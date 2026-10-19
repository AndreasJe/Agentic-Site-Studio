// Admin passkeys (plan §13.8; decisions #24, #41). A one-time setup code per Admin, printed at
// install, lets that Admin register a passkey; after that Admins sign in with the passkey only.
// Verification is packages/shared/webauthn (spike 1).
import type { Database } from 'bun:sqlite'
import { fromBase64Url, sha256, toBase64Url, utf8 } from '@site-studio/shared/bytes'
import { hex } from '@site-studio/shared/release'
import {
  type CoseAlg,
  SUPPORTED_ALGS,
  verifyAssertion,
  verifyRegistration,
} from '@site-studio/shared/webauthn'
import type { Context, Hono } from 'hono'
import { createSession, sameToken, sessionCookie } from './sessions.ts'

export const SETUP_CODE_TTL_MS = 24 * 3600_000
const CHALLENGE_TTL_MS = 120_000

const random = (n = 32) => crypto.getRandomValues(new Uint8Array(n))
const hashCode = async (code: string) => hex(await sha256(utf8.encode(code)))

/** One code per Admin who has no passkey and no unused code yet. Returns handle → code, to print once. */
export function issueSetupCodes(db: Database, now: number): Record<string, string> {
  const admins = db
    .query(
      `select u.id, u.handle from users u
       where u.role = 'admin'
         and not exists (select 1 from passkeys p where p.user_id = u.id)
         and not exists (select 1 from setup_codes c where c.user_id = u.id and c.used_at is null and c.expires_at > ?)`,
    )
    .all(now) as { id: number; handle: string }[]
  const out: Record<string, string> = {}
  for (const a of admins) {
    const code = toBase64Url(random(18))
    // Stored hashed; the plain code is shown once.
    const h = new Bun.CryptoHasher('sha256').update(code).digest('hex')
    db.query(
      'insert or replace into setup_codes (user_id, code_hash, expires_at, used_at) values (?, ?, ?, null)',
    ).run(a.id, h, now + SETUP_CODE_TTL_MS)
    out[a.handle] = code
  }
  return out
}

type Deps = { db: Database; appOrigin: string; rpId: string; now: () => number }

function newChallenge(d: Deps, kind: 'setup' | 'sign-in', userId: number | null) {
  const id = crypto.randomUUID()
  const challenge = toBase64Url(random(32)) // sign-in format, decision #24
  d.db
    .query(
      'insert into challenges (id, kind, user_id, challenge, expires_at) values (?, ?, ?, ?, ?)',
    )
    .run(id, kind, userId, challenge, d.now() + CHALLENGE_TTL_MS)
  return { id, challenge }
}

/** Single use, whatever the outcome. */
function takeChallenge(d: Deps, id: unknown, kind: 'setup' | 'sign-in') {
  if (typeof id !== 'string') return null
  const row = d.db
    .query('delete from challenges where id = ? returning kind, user_id, challenge, expires_at')
    .get(id) as {
    kind: string
    user_id: number | null
    challenge: string
    expires_at: number
  } | null
  if (!row || row.kind !== kind || row.expires_at < d.now()) return null
  return row
}

const field = (body: unknown, ...path: string[]) => {
  let v: unknown = body
  for (const k of path)
    v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : null
}

function signedIn(c: Context, d: Deps, userId: number) {
  const s = createSession(d.db, userId, d.now())
  c.header('set-cookie', sessionCookie(s.id))
  return c.json({ csrf: s.csrf })
}

export function passkeyRoutes(app: Hono, d: Deps) {
  app.post('/api/passkey/setup/options', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const handle = field(body, 'handle')?.toLowerCase() ?? ''
    const code = field(body, 'code') ?? ''
    const row = d.db
      .query(
        `select u.id, u.handle, c.code_hash from users u join setup_codes c on c.user_id = u.id
         where u.handle = ? and u.role = 'admin' and c.used_at is null and c.expires_at > ?`,
      )
      .get(handle, d.now()) as { id: number; handle: string; code_hash: string } | null
    if (!row || !sameToken(await hashCode(code), row.code_hash)) {
      return c.json({ code: 'bad-setup-code' }, 403)
    }
    const { id, challenge } = newChallenge(d, 'setup', row.id)
    const existing = (d.db.query('select id from passkeys').all() as { id: string }[]).map((p) => ({
      type: 'public-key',
      id: p.id,
    }))
    return c.json({
      challengeId: id,
      publicKey: {
        rp: { id: d.rpId, name: 'Site Studio' },
        user: {
          id: toBase64Url(utf8.encode(`user-${row.id}`)),
          name: row.handle,
          displayName: row.handle,
        },
        challenge,
        pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: existing,
        attestation: 'none',
        timeout: 60_000,
      },
    })
  })

  app.post('/api/passkey/setup', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ch = takeChallenge(d, (body as { challengeId?: unknown }).challengeId, 'setup')
    if (!ch?.user_id) return c.json({ code: 'challenge-expired' }, 400)
    const att = field(body, 'response', 'attestationObject')
    const cdj = field(body, 'response', 'clientDataJSON')
    if (!att || !cdj) return c.json({ code: 'malformed' }, 400)
    let result: Awaited<ReturnType<typeof verifyRegistration>>
    try {
      result = await verifyRegistration({
        attestationObject: fromBase64Url(att),
        clientDataJSON: fromBase64Url(cdj),
        expectedChallenge: fromBase64Url(ch.challenge),
        expectedOrigin: d.appOrigin,
        rpId: d.rpId,
      })
    } catch {
      return c.json({ code: 'malformed' }, 400)
    }
    if (!result.ok) return c.json({ code: result.code }, 400)
    const credentialId = toBase64Url(result.credential.id)
    const userId = ch.user_id
    // The credential ID comes from the client: never let a registration replace a stored key.
    const stored = d.db.transaction(() => {
      if (d.db.query('select 1 from passkeys where id = ?').get(credentialId)) return false
      const used = d.db
        .query(
          'update setup_codes set used_at = ? where user_id = ? and used_at is null and expires_at > ?',
        )
        .run(d.now(), userId, d.now())
      if (used.changes !== 1) throw new Error('setup code already used')
      d.db
        .query(
          'insert into passkeys (id, user_id, public_key, alg, sign_count, created_at) values (?, ?, ?, ?, ?, ?)',
        )
        .run(
          credentialId,
          userId,
          toBase64Url(result.credential.publicKey),
          result.credential.alg,
          result.credential.signCount,
          new Date(d.now()).toISOString(),
        )
      return true
    })
    let ok: boolean
    try {
      ok = stored()
    } catch {
      return c.json({ code: 'bad-setup-code' }, 403)
    }
    if (!ok) return c.json({ code: 'credential-exists' }, 409)
    return signedIn(c, d, userId)
  })

  app.post('/api/passkey/sign-in/options', (c) => {
    const { id, challenge } = newChallenge(d, 'sign-in', null)
    const keys = (d.db.query('select id from passkeys').all() as { id: string }[]).map((p) => ({
      type: 'public-key',
      id: p.id,
    }))
    return c.json({
      challengeId: id,
      publicKey: {
        rpId: d.rpId,
        challenge,
        allowCredentials: keys,
        userVerification: 'required',
        timeout: 60_000,
      },
    })
  })

  app.post('/api/passkey/sign-in', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ch = takeChallenge(d, (body as { challengeId?: unknown }).challengeId, 'sign-in')
    if (!ch) return c.json({ code: 'challenge-expired' }, 400)
    const rawId = field(body, 'rawId')
    const key = rawId
      ? (d.db
          .query('select id, user_id, public_key, alg, sign_count from passkeys where id = ?')
          .get(rawId) as {
          id: string
          user_id: number
          public_key: string
          alg: CoseAlg
          sign_count: number
        } | null)
      : null
    if (!key) return c.json({ code: 'unknown-credential' }, 400)
    const authData = field(body, 'response', 'authenticatorData')
    const cdj = field(body, 'response', 'clientDataJSON')
    const sig = field(body, 'response', 'signature')
    if (!authData || !cdj || !sig) return c.json({ code: 'malformed' }, 400)
    let result: Awaited<ReturnType<typeof verifyAssertion>>
    try {
      result = await verifyAssertion({
        credential: {
          id: fromBase64Url(key.id),
          publicKey: fromBase64Url(key.public_key),
          alg: key.alg,
          signCount: key.sign_count,
        },
        authenticatorData: fromBase64Url(authData),
        clientDataJSON: fromBase64Url(cdj),
        signature: fromBase64Url(sig),
        expectedChallenge: fromBase64Url(ch.challenge),
        expectedOrigin: d.appOrigin,
        rpId: d.rpId,
      })
    } catch {
      return c.json({ code: 'malformed' }, 400)
    }
    if (!result.ok) return c.json({ code: result.code }, 400)
    // Compare-and-set on the value we verified against, so two concurrent sign-ins can't both
    // pass with the same counter (spike 1 notes for M1).
    const swapped = d.db
      .query('update passkeys set sign_count = ? where id = ? and sign_count = ?')
      .run(result.signCount, key.id, key.sign_count)
    if (swapped.changes !== 1) return c.json({ code: 'counter-regressed' }, 400)
    return signedIn(c, d, key.user_id)
  })
}
