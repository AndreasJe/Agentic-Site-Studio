// Admin keys (plan §13.4, §13.8; decisions #25, #28, #32; M7.4). An Admin adds a device for
// themselves under the key rule, signed by one of their own keys; a key for a new Admin needs as
// many different Admins as the strictest rule; a removed key stays removed, here and on production.
import { fromBase64Url, toBase64Url, utf8 } from '@site-studio/shared/bytes'
import type { TrustedKey } from '@site-studio/shared/release'
import { coseKeyIdentity, SUPPORTED_ALGS, verifyRegistration } from '@site-studio/shared/webauthn'
import type { SessionUser } from '../auth/sessions.ts'
import { createPasskeyCommand } from '../release/commands.ts'
import {
  createSigning,
  type Fail,
  requestOptions,
  type SigningRow,
  type WebAuthnDeps,
} from '../release/signing.ts'
import { pairedTargets } from '../release/targets.ts'
import type { StoreContext } from '../store/revisions.ts'
import { audit } from './audit.ts'
import { currentPolicy, strictest } from './policy.ts'
import { stepUpChallenge } from './stepup.ts'

type KeyRow = {
  id: string
  user_id: number
  public_key: string
  alg: number
  created_at: string
  approved_at: string | null
  removed_at: string | null
  handle: string
  name: string
  role: string
}

const ADD_KEY_TTL_MS = 120_000
const APP_ONLY_TTL_MS = 24 * 3600_000

const keyRow = (ctx: Pick<StoreContext, 'db'>, keyId: string) =>
  ctx.db
    .query(
      `select p.id, p.user_id, p.public_key, p.alg, p.created_at, p.approved_at, p.removed_at,
              u.handle, u.name, u.role
       from passkeys p join users u on u.id = p.user_id where p.id = ?`,
    )
    .get(keyId) as KeyRow | null

export function listKeys(ctx: Pick<StoreContext, 'db'>) {
  const rows = ctx.db
    .query(
      `select p.id, p.user_id, p.public_key, p.alg, p.created_at, p.approved_at, p.removed_at,
              u.handle, u.name, u.role
       from passkeys p join users u on u.id = p.user_id
       where u.role = 'admin' order by u.handle, p.created_at, p.id`,
    )
    .all() as KeyRow[]
  return rows.map((r) => ({
    keyId: r.id,
    adminId: r.handle,
    name: r.name,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    removedAt: r.removed_at,
    status: r.removed_at ? 'removed' : r.approved_at ? 'approved' : 'waiting',
  }))
}

/** The key as a trust-keys command carries it (contracts/command.schema.json trustedKey). */
export function trustedKeyOf(ctx: Pick<StoreContext, 'db'>, keyId: string): TrustedKey | null {
  const r = keyRow(ctx, keyId)
  if (r?.role !== 'admin' || r.removed_at) return null
  return {
    keyId: r.id,
    adminId: r.handle,
    alg: r.alg as TrustedKey['alg'],
    publicKey: r.public_key,
  }
}

/** Production trusts these keys now (a trust-keys it accepted, or the pairing file). */
export function markKeysApproved(ctx: Pick<StoreContext, 'db'>, keyIds: string[]) {
  const at = new Date().toISOString()
  for (const id of keyIds)
    ctx.db
      .query(
        'update passkeys set approved_at = ? where id = ? and approved_at is null and removed_at is null',
      )
      .run(at, id)
}

export function markKeyRemoved(ctx: Pick<StoreContext, 'db'>, keyId: string) {
  ctx.db
    .query('update passkeys set removed_at = ? where id = ? and removed_at is null')
    .run(new Date().toISOString(), keyId)
}

/** Admins who keep at least one key that isn't removed, leaving out `except`. */
function adminsWithKeys(ctx: Pick<StoreContext, 'db'>, except?: string): Set<string> {
  const rows = ctx.db
    .query(
      `select distinct u.handle from passkeys p join users u on u.id = p.user_id
       where u.role = 'admin' and p.removed_at is null and p.approved_at is not null and p.id <> ?`,
    )
    .all(except ?? '') as { handle: string }[]
  return new Set(rows.map((r) => r.handle))
}

// ---- adding a device for yourself (#28) ---------------------------------------------------

export function beginAddKey(ctx: Pick<StoreContext, 'db'>, deps: WebAuthnDeps, user: SessionUser) {
  const id = crypto.randomUUID()
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  ctx.db
    .query(
      "insert into ceremonies (id, user_id, purpose, payload, challenge, expires_at) values (?, ?, 'add-key', '{}', ?, ?)",
    )
    .run(id, user.id, challenge, deps.now() + ADD_KEY_TTL_MS)
  // Every key ever registered, removed ones too: a removed key can never come back (#32).
  const existing = ctx.db.query('select id from passkeys').all() as { id: string }[]
  return {
    challengeId: id,
    publicKey: {
      rp: { id: deps.rpId, name: 'Site Studio' },
      user: {
        id: toBase64Url(utf8.encode(`user-${user.id}`)),
        name: user.handle,
        displayName: user.name,
      },
      challenge,
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: existing.map((p) => ({ type: 'public-key', id: p.id })),
      attestation: 'none',
      timeout: 60_000,
    },
  }
}

/** Stores the new key, waiting for approval; it signs nothing for production until approved. */
export async function finishAddKey(
  ctx: Pick<StoreContext, 'db'>,
  deps: WebAuthnDeps,
  user: SessionUser,
  body: unknown,
): Promise<{ ok: true; keyId: string } | Fail> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const response = (
    typeof b.response === 'object' && b.response !== null ? b.response : {}
  ) as Record<string, unknown>
  if (typeof b.challengeId !== 'string') return { ok: false, status: 400, code: 'malformed' }
  const ch = ctx.db
    .query(
      "delete from ceremonies where id = ? and purpose = 'add-key' returning user_id, challenge, expires_at",
    )
    .get(b.challengeId) as { user_id: number; challenge: string; expires_at: number } | null
  if (!ch || ch.user_id !== user.id || ch.expires_at <= deps.now())
    return { ok: false, status: 400, code: 'challenge-expired' }
  const att = response.attestationObject
  const cdj = response.clientDataJSON
  if (typeof att !== 'string' || typeof cdj !== 'string')
    return { ok: false, status: 400, code: 'malformed' }
  let result: Awaited<ReturnType<typeof verifyRegistration>>
  try {
    result = await verifyRegistration({
      attestationObject: fromBase64Url(att),
      clientDataJSON: fromBase64Url(cdj),
      expectedChallenge: fromBase64Url(ch.challenge),
      expectedOrigin: deps.appOrigin,
      rpId: deps.rpId,
    })
  } catch {
    return { ok: false, status: 400, code: 'malformed' }
  }
  if (!result.ok) return { ok: false, status: 400, code: result.code }
  const keyId = toBase64Url(result.credential.id)
  const identity = coseKeyIdentity(result.credential.publicKey)
  const stored = ctx.db.transaction(() => {
    // A removed key keeps its row, so the same credential or key material is refused here (#32).
    if (ctx.db.query('select 1 from passkeys where id = ? or identity = ?').get(keyId, identity))
      return false
    ctx.db
      .query(
        'insert into passkeys (id, user_id, public_key, alg, sign_count, created_at, identity) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        keyId,
        user.id,
        toBase64Url(result.credential.publicKey),
        result.credential.alg,
        result.credential.signCount,
        new Date(deps.now()).toISOString(),
        identity,
      )
    return true
  })()
  if (!stored) return { ok: false, status: 409, code: 'credential-exists' }
  audit(ctx, user.handle, 'key-registered', { keyId, adminId: user.handle })
  return { ok: true, keyId }
}

// ---- approving and removing keys -----------------------------------------------------------

/** One paired target, or none (app-only, before pairing). Several are not supported yet. */
export function governanceTarget(ctx: StoreContext): { target: string | null } | Fail {
  const targets = pairedTargets(ctx)
  if (targets.length > 1) return { ok: false, status: 409, code: 'several-targets' }
  return { target: targets[0] ?? null }
}

const openFor = (ctx: Pick<StoreContext, 'db'>, ref: string) =>
  ctx.db
    .query(
      "select * from signing_requests where ref = ? and status = 'open' order by id desc limit 1",
    )
    .get(ref) as SigningRow | null

async function appOnly(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  input: {
    purpose: string
    ref: string
    needed: number
    owner?: string | null
    effect: Record<string, unknown>
    who: string
  },
) {
  const body = {
    action: input.purpose,
    ...input.effect,
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  }
  return createSigning(ctx, {
    kind: 'app-only',
    purpose: input.purpose,
    target: null,
    ref: input.ref,
    body,
    challenge: await stepUpChallenge(body),
    needed: input.needed,
    owner: input.owner ?? null,
    effect: input.effect,
    createdBy: input.who,
    expiresAt: deps.now() + APP_ONLY_TTL_MS,
  })
}

/**
 * Approving a key that is waiting (#28): for an Admin who already has a key, the key rule and
 * the owner's own signature; for a new Admin, the strictest rule's number of Admins.
 */
export async function startApproveKey(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  user: SessionUser,
  keyId: string,
) {
  const key = keyRow(ctx, keyId)
  if (key?.role !== 'admin') return { ok: false, status: 404, code: 'not-found' } as Fail
  if (key.removed_at) return { ok: false, status: 409, code: 'key-removed' } as Fail
  if (key.approved_at) return { ok: false, status: 409, code: 'already-approved' } as Fail
  const ref = `key-add:${keyId}`
  const open = openFor(ctx, ref)
  if (open) return { ok: true as const, row: open, options: requestOptions(ctx, deps, open, user) }
  const where = governanceTarget(ctx)
  if ('ok' in where) return where
  const policy = currentPolicy(ctx)
  const existing = adminsWithKeys(ctx, keyId).has(key.handle)
  const rule = existing
    ? { needed: policy.keys, owner: key.handle }
    : { needed: strictest(policy), owner: null }
  if (!existing && adminsWithKeys(ctx, keyId).size < rule.needed)
    return { ok: false, status: 409, code: 'too-few-admins' } as Fail
  const effect = { type: 'key-add', keyId, adminId: key.handle, newAdmin: !existing }
  const trusted = trustedKeyOf(ctx, keyId) as TrustedKey
  const row = where.target
    ? await createPasskeyCommand(ctx, deps, {
        target: where.target,
        command: 'trust-keys',
        args: { add: [trusted] },
        purpose: 'key-add',
        ref,
        needed: rule.needed,
        owner: rule.owner,
        effect,
        who: user.handle,
      })
    : await appOnly(ctx, deps, { purpose: 'key-add', ref, ...rule, effect, who: user.handle })
  audit(ctx, user.handle, 'key-approval-started', {
    keyId,
    adminId: key.handle,
    needed: rule.needed,
  })
  return { ok: true as const, row, options: requestOptions(ctx, deps, row, user) }
}

/** Removing a key (#32), under the key rule; production keeps it revoked for good. */
export async function startRemoveKey(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  user: SessionUser,
  keyId: string,
) {
  const key = keyRow(ctx, keyId)
  if (key?.role !== 'admin') return { ok: false, status: 404, code: 'not-found' } as Fail
  if (key.removed_at) return { ok: false, status: 409, code: 'key-removed' } as Fail
  const ref = `key-remove:${keyId}`
  const open = openFor(ctx, ref)
  if (open) return { ok: true as const, row: open, options: requestOptions(ctx, deps, open, user) }
  const policy = currentPolicy(ctx)
  // Never fewer Admins than the rule needs, or nobody could sign anything again.
  if (adminsWithKeys(ctx, keyId).size < strictest(policy))
    return { ok: false, status: 409, code: 'too-few-admins' } as Fail
  const where = governanceTarget(ctx)
  if ('ok' in where) return where
  const effect = { type: 'key-remove', keyId, adminId: key.handle }
  const row = where.target
    ? await createPasskeyCommand(ctx, deps, {
        target: where.target,
        command: 'remove-key',
        args: { remove: [keyId] },
        purpose: 'key-remove',
        ref,
        needed: policy.keys,
        effect,
        who: user.handle,
      })
    : await appOnly(ctx, deps, {
        purpose: 'key-remove',
        ref,
        needed: policy.keys,
        effect,
        who: user.handle,
      })
  audit(ctx, user.handle, 'key-removal-started', {
    keyId,
    adminId: key.handle,
    needed: policy.keys,
  })
  return { ok: true as const, row, options: requestOptions(ctx, deps, row, user) }
}

export { appOnly as createAppOnlySigning }
