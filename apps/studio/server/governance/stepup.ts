// Passkey step-up for app-only Admin changes (M6 check settings; governance before pairing).
// Challenge format (docs/pending/decisions.md #48): the four ASCII bytes `stp1` followed by the
// SHA-256 of the action as canonical JSON (36 bytes). The action names what changes, who asks,
// a fresh random nonce and an expiry, so an assertion is good for exactly one change, once.
// `stp1` differs from `cmd1` (#24), and the length differs from sign-in (32) and release (40),
// so a step-up assertion can never pass as a production command, a release or a sign-in.
import { type Bytes, concat, sha256, toBase64Url, utf8 } from '@site-studio/shared/bytes'
import { canonicalJson } from '@site-studio/shared/release'
import type { SessionUser } from '../auth/sessions.ts'
import { parseAssertion, verifyAdminAssertion, type WebAuthnDeps } from '../release/signing.ts'
import type { StoreContext } from '../store/revisions.ts'

export const STEP_UP_TAG = 'stp1'
const STEP_UP_TTL_MS = 120_000

export async function stepUpChallenge(action: Record<string, unknown>): Promise<Bytes> {
  return concat(utf8.encode(STEP_UP_TAG), await sha256(utf8.encode(canonicalJson(action))))
}

export type StepUpOptions = {
  id: string
  publicKey: {
    rpId: string
    challenge: string
    allowCredentials: { type: 'public-key'; id: string }[]
    userVerification: 'required'
    timeout: number
  }
}

const ownKeys = (ctx: Pick<StoreContext, 'db'>, user: SessionUser) =>
  (
    ctx.db
      .query(
        'select id from passkeys where user_id = ? and removed_at is null and approved_at is not null order by created_at',
      )
      .all(user.id) as { id: string }[]
  ).map((k) => ({ type: 'public-key' as const, id: k.id }))

/** A one-time challenge for `change` (plain JSON: integers and strings only). */
export async function beginStepUp(
  ctx: Pick<StoreContext, 'db'>,
  deps: WebAuthnDeps,
  user: SessionUser,
  change: Record<string, unknown>,
): Promise<StepUpOptions> {
  const id = crypto.randomUUID()
  const expiresAt = deps.now() + STEP_UP_TTL_MS
  const action = {
    ...change,
    by: user.handle,
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    expires: new Date(expiresAt).toISOString(),
  }
  const challenge = toBase64Url(await stepUpChallenge(action))
  ctx.db
    .query(
      "insert into ceremonies (id, user_id, purpose, payload, challenge, expires_at) values (?, ?, 'step-up', ?, ?, ?)",
    )
    .run(id, user.id, JSON.stringify(action), challenge, expiresAt)
  return {
    id,
    publicKey: {
      rpId: deps.rpId,
      challenge,
      allowCredentials: ownKeys(ctx, user),
      userVerification: 'required',
      timeout: 60_000,
    },
  }
}

/**
 * Checks a step-up answer: the same Admin, the same change, within its time, used once (it is
 * deleted whatever the outcome).
 */
export async function finishStepUp(
  ctx: Pick<StoreContext, 'db'>,
  deps: WebAuthnDeps,
  user: SessionUser,
  change: Record<string, unknown>,
  stepUp: unknown,
): Promise<{ ok: true; keyId: string } | { ok: false; code: string }> {
  const s = (typeof stepUp === 'object' && stepUp !== null ? stepUp : {}) as Record<string, unknown>
  if (typeof s.id !== 'string') return { ok: false, code: 'step-up-required' }
  const row = ctx.db
    .query(
      "delete from ceremonies where id = ? and purpose = 'step-up' returning user_id, payload, challenge, expires_at",
    )
    .get(s.id) as { user_id: number; payload: string; challenge: string; expires_at: number } | null
  if (!row || row.user_id !== user.id || row.expires_at <= deps.now())
    return { ok: false, code: 'step-up-expired' }
  const action = JSON.parse(row.payload) as Record<string, unknown>
  for (const [k, v] of Object.entries(change)) {
    if (canonicalJson(action[k] ?? null) !== canonicalJson(v))
      return { ok: false, code: 'step-up-mismatch' }
  }
  if (toBase64Url(await stepUpChallenge(action)) !== row.challenge)
    return { ok: false, code: 'step-up-mismatch' }
  const a = parseAssertion(s)
  if (!a) return { ok: false, code: 'malformed' }
  const v = await verifyAdminAssertion(ctx, deps, user, a, await stepUpChallenge(action))
  if (!v.ok) return { ok: false, code: v.code }
  return { ok: true, keyId: v.keyId }
}

/** Clears ceremonies that ran out, so the table stays small. */
export function sweepCeremonies(ctx: Pick<StoreContext, 'db'>, now: number) {
  ctx.db.query('delete from ceremonies where expires_at <= ?').run(now)
}
