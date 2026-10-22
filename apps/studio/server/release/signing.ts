// Signing requests (plan §13.3, §13.8–§13.9; decisions #23–#26, #30): one fixed challenge that one
// or two Admins sign with their passkeys, each assertion checked here with the shared verifier
// exactly as production will check it (origin, rpId, user verification, counter). Releases,
// passkey commands, governance and key changes all go through this table.
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { type CoseAlg, verifyAssertion } from '@site-studio/shared/webauthn'
import type { SessionUser } from '../auth/sessions.ts'
import type { StoreContext } from '../store/revisions.ts'

export type WebAuthnDeps = { appOrigin: string; rpId: string; now: () => number }

export type SigningKind = 'release' | 'command' | 'app-only'
export type SigningStatus =
  | 'open'
  | 'signed'
  | 'sent'
  | 'accepted'
  | 'refused'
  | 'stale'
  | 'cancelled'
  | 'done'

export type SigningRow = {
  id: number
  kind: SigningKind
  purpose: string
  target: string | null
  ref: string
  body: string
  challenge: string
  needed: number
  owner: string | null
  number: number | null
  effect: string
  status: SigningStatus
  outcome: string | null
  smoke: string | null
  created_by: string
  created_at: string
  expires_at: number
  sent_at: string | null
  done_at: string | null
}

export type Assertion = {
  rawId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

export type Fail = { ok: false; status: 400 | 403 | 404 | 409 | 502; code: string }
const fail = (status: Fail['status'], code: string): Fail => ({ ok: false, status, code })

const B64U = /^[A-Za-z0-9_-]{1,16384}$/
const str = (v: unknown) => (typeof v === 'string' && B64U.test(v) ? v : null)

/** `{ rawId, response: { authenticatorData, clientDataJSON, signature } }` as the browser sends it. */
export function parseAssertion(body: unknown): Assertion | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const r = (typeof b.response === 'object' && b.response !== null ? b.response : {}) as Record<
    string,
    unknown
  >
  const rawId = str(b.rawId)
  const authenticatorData = str(r.authenticatorData)
  const clientDataJSON = str(r.clientDataJSON)
  const signature = str(r.signature)
  if (!rawId || !authenticatorData || !clientDataJSON || !signature) return null
  return { rawId, authenticatorData, clientDataJSON, signature }
}

type KeyRow = { id: string; user_id: number; public_key: string; alg: CoseAlg; sign_count: number }

/**
 * A fresh assertion by this Admin, with one of their own keys that was never removed, over exactly
 * `challenge`. The counter moves forward by compare-and-set, as at sign-in (decisions #30).
 */
export async function verifyAdminAssertion(
  ctx: Pick<StoreContext, 'db'>,
  deps: WebAuthnDeps,
  user: SessionUser,
  a: Assertion,
  challenge: Uint8Array,
  opts: { notKey?: string } = {},
): Promise<{ ok: true; keyId: string } | Fail> {
  if (user.role !== 'admin') return fail(403, 'forbidden')
  const key = ctx.db
    .query(
      'select id, user_id, public_key, alg, sign_count from passkeys where id = ? and user_id = ? and removed_at is null and approved_at is not null',
    )
    .get(a.rawId, user.id) as KeyRow | null
  if (!key) return fail(403, 'not-your-key')
  if (opts.notKey && key.id === opts.notKey) return fail(409, 'new-key-cannot-sign')
  let result: Awaited<ReturnType<typeof verifyAssertion>>
  try {
    result = await verifyAssertion({
      credential: {
        id: fromBase64Url(key.id),
        publicKey: fromBase64Url(key.public_key),
        alg: key.alg,
        signCount: key.sign_count,
      },
      authenticatorData: fromBase64Url(a.authenticatorData),
      clientDataJSON: fromBase64Url(a.clientDataJSON),
      signature: fromBase64Url(a.signature),
      expectedChallenge: new Uint8Array(challenge),
      expectedOrigin: deps.appOrigin,
      rpId: deps.rpId,
    })
  } catch {
    return fail(400, 'malformed')
  }
  if (!result.ok) return fail(400, result.code)
  const swapped = ctx.db
    .query('update passkeys set sign_count = ? where id = ? and sign_count = ?')
    .run(result.signCount, key.id, key.sign_count)
  if (swapped.changes !== 1) return fail(400, 'counter-regressed')
  return { ok: true, keyId: key.id }
}

export type NewSigning = {
  kind: SigningKind
  purpose: string
  target: string | null
  ref: string
  body: Record<string, unknown>
  challenge: Uint8Array
  needed: number
  owner?: string | null
  number?: number | null
  effect?: Record<string, unknown>
  createdBy: string
  expiresAt: number
  status?: SigningStatus
}

export function createSigning(ctx: Pick<StoreContext, 'db'>, s: NewSigning): SigningRow {
  return ctx.db
    .query(
      `insert into signing_requests (kind, purpose, target, ref, body, challenge, needed, owner, number,
         effect, status, created_by, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning *`,
    )
    .get(
      s.kind,
      s.purpose,
      s.target,
      s.ref,
      JSON.stringify(s.body),
      toBase64Url(s.challenge),
      s.needed,
      s.owner ?? null,
      s.number ?? null,
      JSON.stringify(s.effect ?? {}),
      s.status ?? 'open',
      s.createdBy,
      new Date().toISOString(),
      s.expiresAt,
    ) as SigningRow
}

export const getSigning = (ctx: Pick<StoreContext, 'db'>, id: number) =>
  ctx.db.query('select * from signing_requests where id = ?').get(id) as SigningRow | null

export function setStatus(
  ctx: Pick<StoreContext, 'db'>,
  id: number,
  status: SigningStatus,
  extra: { outcome?: string | null; sent?: boolean; done?: boolean } = {},
) {
  const at = new Date().toISOString()
  ctx.db
    .query(
      `update signing_requests set status = ?, outcome = coalesce(?, outcome),
         sent_at = case when ? then ? else sent_at end,
         done_at = case when ? then ? else done_at end
       where id = ?`,
    )
    .run(status, extra.outcome ?? null, extra.sent ? 1 : 0, at, extra.done ? 1 : 0, at, id)
}

export type Signer = { adminId: string; userId: number; keyId: string; at: string }

export function signersOf(ctx: Pick<StoreContext, 'db'>, id: number): Signer[] {
  return ctx.db
    .query(
      'select admin_id as adminId, user_id as userId, key_id as keyId, at from signing_signatures where request_id = ? order by at, rowid',
    )
    .all(id) as Signer[]
}

/** The signatures as release.json and command files carry them (contracts/*.schema.json). */
export function passkeySignatures(ctx: Pick<StoreContext, 'db'>, id: number) {
  const rows = ctx.db
    .query(
      'select key_id, authenticator_data, client_data_json, signature from signing_signatures where request_id = ? order by at, rowid',
    )
    .all(id) as {
    key_id: string
    authenticator_data: string
    client_data_json: string
    signature: string
  }[]
  return rows.map((r) => ({
    adminKeyId: r.key_id,
    authenticatorData: r.authenticator_data,
    clientDataJSON: r.client_data_json,
    signature: r.signature,
  }))
}

/** Enough different Admins, and the key's owner among them where a key rule needs it (#28). */
export function isComplete(ctx: Pick<StoreContext, 'db'>, row: SigningRow): boolean {
  const signers = signersOf(ctx, row.id)
  const admins = new Set(signers.map((s) => s.adminId))
  if (admins.size < row.needed) return false
  return !row.owner || admins.has(row.owner)
}

/** What navigator.credentials.get needs: the challenge is the exact bytes production verifies. */
export function requestOptions(
  ctx: Pick<StoreContext, 'db'>,
  deps: WebAuthnDeps,
  row: SigningRow,
  user: SessionUser,
) {
  const notKey = (JSON.parse(row.effect) as { keyId?: string }).keyId
  const keys = (
    ctx.db
      .query(
        'select id from passkeys where user_id = ? and removed_at is null and approved_at is not null order by created_at',
      )
      .all(user.id) as { id: string }[]
  ).filter((k) => !(row.purpose === 'key-add' && k.id === notKey))
  return {
    signingId: row.id,
    purpose: row.purpose,
    needed: row.needed,
    owner: row.owner,
    signers: signersOf(ctx, row.id).map((s) => ({ adminId: s.adminId, at: s.at })),
    publicKey: {
      rpId: deps.rpId,
      challenge: row.challenge,
      allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.id })),
      userVerification: 'required',
      timeout: 120_000,
    },
  }
}

/**
 * One Admin's signature on an open request. Each Admin signs once; a signature is checked against
 * the stored challenge, so it is valid for exactly this release or command.
 */
export async function addSignature(
  ctx: Pick<StoreContext, 'db'>,
  deps: WebAuthnDeps,
  row: SigningRow,
  user: SessionUser,
  body: unknown,
): Promise<{ ok: true; complete: boolean } | Fail> {
  if (user.role !== 'admin') return fail(403, 'forbidden')
  if (row.status !== 'open')
    return fail(409, row.status === 'stale' ? 'needs-re-signing' : 'closed')
  if (row.expires_at <= deps.now()) {
    setStatus(ctx, row.id, 'stale', { outcome: 'expired' })
    return fail(409, 'needs-re-signing')
  }
  const a = parseAssertion(body)
  if (!a) return fail(400, 'malformed')
  if (
    ctx.db
      .query('select 1 from signing_signatures where request_id = ? and user_id = ?')
      .get(row.id, user.id)
  )
    return fail(409, 'already-signed')
  const notKey =
    row.purpose === 'key-add' ? (JSON.parse(row.effect) as { keyId?: string }).keyId : undefined
  const v = await verifyAdminAssertion(ctx, deps, user, a, fromBase64Url(row.challenge), { notKey })
  if (!v.ok) return v
  // The request may have been cancelled or gone stale while the assertion was checked: the status
  // is read again, and moved to 'signed' only from 'open', in one transaction.
  const stored = ctx.db.transaction((): Fail | { complete: boolean } => {
    const now = getSigning(ctx, row.id)
    if (now?.status !== 'open') return fail(409, 'closed')
    try {
      ctx.db
        .query(
          `insert into signing_signatures (request_id, user_id, admin_id, key_id, authenticator_data,
             client_data_json, signature, at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          user.id,
          user.handle,
          v.keyId,
          a.authenticatorData,
          a.clientDataJSON,
          a.signature,
          new Date(deps.now()).toISOString(),
        )
    } catch {
      return fail(409, 'already-signed')
    }
    if (!isComplete(ctx, now)) return { complete: false }
    const moved = ctx.db
      .query("update signing_requests set status = 'signed' where id = ? and status = 'open'")
      .run(row.id)
    return { complete: moved.changes === 1 }
  })()
  if ('ok' in stored) return stored
  return { ok: true, complete: stored.complete }
}

/** The newest number this app already sent to a target, for releases or commands. */
export function highestSent(
  ctx: Pick<StoreContext, 'db'>,
  target: string,
  kind: 'release' | 'command',
) {
  const row = ctx.db
    .query(
      `select max(number) as n from signing_requests
       where target = ? and kind = ? and status in ('sent', 'accepted', 'refused')`,
    )
    .get(target, kind) as { n: number | null }
  return row.n ?? 0
}

/**
 * Decisions #26, #30: a command signed earlier but not sent yet can't follow a later one (the
 * sequence would be refused as replayed), so it has to be signed again. Same for releases.
 */
export function markOlderStale(
  ctx: Pick<StoreContext, 'db'>,
  target: string,
  kind: 'release' | 'command',
  below: number,
) {
  ctx.db
    .query(
      `update signing_requests set status = 'stale', outcome = 'overtaken'
       where target = ? and kind = ? and status in ('open', 'signed') and number < ?`,
    )
    .run(target, kind, below)
}
