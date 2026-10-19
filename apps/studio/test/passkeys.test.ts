// M1 step 5: Admin passkeys (plan §13.8; decisions #24, #41; spike 1 notes for M1).
import { describe, expect, test } from 'bun:test'
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { SoftAuthenticator } from '../../../packages/shared/test/soft-authenticator.ts'
import { createApp } from '../server/app/index.ts'
import { issueSetupCodes } from '../server/auth/passkeys.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { openDb } from '../server/db/index.ts'

const APP = 'http://localhost:3000'

function setup() {
  const db = openDb(':memory:')
  seedTestAccounts(db)
  let now = Date.parse('2026-10-19T08:00:00Z')
  const codes = issueSetupCodes(db, now)
  const app = createApp({ appUrl: new URL(APP), instanceId: 'inst-test', db, now: () => now })
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    app.request(`${APP}${path}`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    })
  const json = async (res: Response) => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  })
  return { db, app, codes, post, json, advance: (ms: number) => (now += ms) }
}

async function register(
  s: ReturnType<typeof setup>,
  handle: string,
  code: string,
  auth: SoftAuthenticator,
  over = {},
) {
  const opts = await s.json(await s.post('/api/passkey/setup/options', { handle, code }))
  if (opts.status !== 200) return opts
  const pk = opts.body.publicKey as { challenge: string; rp: { id: string } }
  expect(pk.rp.id).toBe('localhost')
  const reg = await auth.register({
    challenge: fromBase64Url(pk.challenge),
    origin: APP,
    rpId: 'localhost',
    ...over,
  })
  return s.json(
    await s.post('/api/passkey/setup', {
      challengeId: opts.body.challengeId,
      response: {
        attestationObject: toBase64Url(reg.attestationObject),
        clientDataJSON: toBase64Url(reg.clientDataJSON),
      },
    }),
  )
}

async function signIn(s: ReturnType<typeof setup>, auth: SoftAuthenticator, over = {}) {
  const opts = await s.json(await s.post('/api/passkey/sign-in/options', {}))
  const pk = opts.body.publicKey as { challenge: string }
  expect(fromBase64Url(pk.challenge).length).toBe(32)
  const a = await auth.assert({
    challenge: fromBase64Url(pk.challenge),
    origin: APP,
    rpId: 'localhost',
    ...over,
  })
  const request = {
    challengeId: opts.body.challengeId,
    rawId: toBase64Url(auth.credentialId),
    response: {
      authenticatorData: toBase64Url(a.authenticatorData),
      clientDataJSON: toBase64Url(a.clientDataJSON),
      signature: toBase64Url(a.signature),
    },
  }
  const res = await s.post('/api/passkey/sign-in', request)
  return {
    ...(await s.json(res)),
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    request,
  }
}

describe('setup codes', () => {
  test('one code per Admin, printed at install; it works once', async () => {
    const s = setup()
    expect(Object.keys(s.codes).sort()).toEqual(['admina', 'adminb'])
    const auth = await SoftAuthenticator.create()
    expect((await register(s, 'admina', s.codes.admina as string, auth)).status).toBe(200)
    const again = await register(
      s,
      'admina',
      s.codes.admina as string,
      await SoftAuthenticator.create(),
    )
    expect(again).toMatchObject({ status: 403, body: { code: 'bad-setup-code' } })
  })

  test('a wrong, another Admin\x27s or an expired code is refused', async () => {
    const s = setup()
    const auth = await SoftAuthenticator.create()
    expect((await register(s, 'admina', 'nope', auth)).status).toBe(403)
    expect((await register(s, 'admina', s.codes.adminb as string, auth)).status).toBe(403)
    s.advance(24 * 3600_000 + 1)
    expect((await register(s, 'adminb', s.codes.adminb as string, auth)).status).toBe(403)
  })

  test('codes are only issued to Admins without a passkey, and stored hashed', async () => {
    const s = setup()
    await register(s, 'admina', s.codes.admina as string, await SoftAuthenticator.create())
    // adminb still holds an unused code; admina has a passkey: nobody gets a new one.
    expect(issueSetupCodes(s.db, Date.parse('2026-10-19T09:00:00Z'))).toEqual({})
    // Once adminb's code has expired, adminb gets a fresh one; admina never does.
    expect(Object.keys(issueSetupCodes(s.db, Date.parse('2026-10-20T09:00:00Z')))).toEqual([
      'adminb',
    ])
    const stored = s.db.query('select code_hash from setup_codes').all() as { code_hash: string }[]
    for (const row of stored) expect(Object.values(s.codes)).not.toContain(row.code_hash)
  })
})

describe('registration', () => {
  test('a passkey without user verification, or for another origin, is refused', async () => {
    const s = setup()
    expect(
      (
        await register(s, 'admina', s.codes.admina as string, await SoftAuthenticator.create(), {
          uv: false,
        })
      ).body.code,
    ).toBe('user-not-verified')
    expect(
      (
        await register(s, 'adminb', s.codes.adminb as string, await SoftAuthenticator.create(), {
          origin: 'http://127.0.0.1:3001',
        })
      ).body.code,
    ).toBe('origin-mismatch')
  })

  test('a credential ID that is already registered is refused', async () => {
    const s = setup()
    const auth = await SoftAuthenticator.create()
    expect((await register(s, 'admina', s.codes.admina as string, auth)).status).toBe(200)
    expect(await register(s, 'adminb', s.codes.adminb as string, auth)).toMatchObject({
      status: 409,
      body: { code: 'credential-exists' },
    })
  })
})

describe('passkey sign-in', () => {
  test('an Admin signs in with their passkey and gets an Admin session', async () => {
    const s = setup()
    const auth = await SoftAuthenticator.create()
    await register(s, 'admina', s.codes.admina as string, auth)
    const r = await signIn(s, auth)
    expect(r.status).toBe(200)
    expect(r.cookie).toStartWith('__Host-sid=')
    const me = (await (
      await s.app.request(`${APP}/api/me`, { headers: { cookie: r.cookie } })
    ).json()) as { user: { role: string } }
    expect(me.user.role).toBe('admin')
  })

  test('no user verification, a replayed assertion or an unknown key is refused', async () => {
    const s = setup()
    const auth = await SoftAuthenticator.create()
    await register(s, 'admina', s.codes.admina as string, auth)
    expect((await signIn(s, auth, { uv: false })).body.code).toBe('user-not-verified')
    const ok = await signIn(s, auth)
    expect((await s.json(await s.post('/api/passkey/sign-in', ok.request))).body.code).toBe(
      'challenge-expired',
    )
    expect((await signIn(s, await SoftAuthenticator.create())).body.code).toBe('unknown-credential')
  })

  test('the signature counter is stored, and one that goes back is refused', async () => {
    const s = setup()
    const auth = await SoftAuthenticator.create()
    await register(s, 'admina', s.codes.admina as string, auth)
    auth.signCount = 5
    expect((await signIn(s, auth)).status).toBe(200)
    expect((await signIn(s, auth)).body.code).toBe('counter-regressed')
    auth.signCount = 6
    expect((await signIn(s, auth)).status).toBe(200)
  })
})
