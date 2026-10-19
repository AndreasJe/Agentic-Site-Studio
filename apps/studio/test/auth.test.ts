// M1 step 4: Creator sign-in, sessions, Origin + CSRF, and the role guard (CLAUDE.md rule 4;
// permission-cases.md Roles [M1]; decision #41 sessions).
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createApp } from '../server/app/index.ts'
import { ADMIN_CAPABILITIES, requireCapability } from '../server/auth/roles.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { openDb } from '../server/db/index.ts'

const APP = 'http://localhost:3000'

function setup() {
  const db = openDb(':memory:')
  seedTestAccounts(db)
  let now = Date.parse('2026-10-19T08:00:00Z')
  const app = createApp({ appUrl: new URL(APP), instanceId: 'inst-test', db, now: () => now })
  const call = (path: string, init: RequestInit & { cookie?: string; csrf?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.cookie) headers.set('cookie', init.cookie)
    if (init.csrf) headers.set('x-csrf-token', init.csrf)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return app.request(`${APP}${path}`, { ...init, headers })
  }
  const signIn = async (handle: string, password = handle) => {
    const res = await call('/api/sign-in', {
      method: 'POST',
      headers: { origin: APP },
      body: JSON.stringify({ handle, password }),
    })
    const setCookie = res.headers.get('set-cookie') ?? ''
    const body = (await res.json()) as { csrf?: string; code?: string }
    return { res, body, setCookie, cookie: setCookie.split(';')[0] ?? '' }
  }
  return { db, app, call, signIn, advance: (ms: number) => (now += ms) }
}

describe('sign-in', () => {
  test('a Creator signs in with a host-only, HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const { signIn } = setup()
    const { res, setCookie, body } = await signIn('alex')
    expect(res.status).toBe(200)
    expect(setCookie).toStartWith('__Host-sid=')
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
      expect(setCookie).toContain(attr)
    expect(setCookie.toLowerCase()).not.toContain('domain=')
    expect(body.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('a wrong password or unknown user is refused the same way', async () => {
    const { signIn } = setup()
    expect((await signIn('alex', 'wrong')).res.status).toBe(401)
    expect((await signIn('nobody', 'x')).res.status).toBe(401)
  })

  test('Admins cannot sign in with a password', async () => {
    const { db, signIn } = setup()
    const admin = db.query("select handle from users where role = 'admin' limit 1").get() as {
      handle: string
    }
    const r = await signIn(admin.handle, admin.handle)
    expect(r.res.status).toBe(403)
    expect(r.body.code).toBe('passkey-required')
  })
})

describe('Origin and CSRF on every state-changing request', () => {
  test('a POST without Origin, or from another origin, is refused before anything else', async () => {
    const { call } = setup()
    for (const origin of [undefined, 'http://127.0.0.1:3001', 'null']) {
      const res = await call('/api/sign-in', {
        method: 'POST',
        headers: origin ? { origin } : {},
        body: JSON.stringify({ handle: 'alex', password: 'alex' }),
      })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code: string }).code).toBe('bad-origin')
    }
  })

  test('a signed-in POST needs the session CSRF token', async () => {
    const { call, signIn } = setup()
    const { cookie, body } = await signIn('alex')
    const lang = (csrf?: string) =>
      call('/api/me/language', {
        method: 'POST',
        headers: { origin: APP },
        cookie,
        csrf,
        body: '{"language":"da"}',
      })
    expect(((await (await lang()).json()) as { code: string }).code).toBe('bad-csrf')
    expect(((await (await lang('x'.repeat(43))).json()) as { code: string }).code).toBe('bad-csrf')
    expect((await lang(body.csrf)).status).toBe(200)
  })
})

describe('sessions', () => {
  test('me answers with a session and not without one', async () => {
    const { call, signIn } = setup()
    expect((await call('/api/me')).status).toBe(401)
    const { cookie } = await signIn('alex')
    const me = (await (await call('/api/me', { cookie })).json()) as {
      user: { handle: string; role: string }
    }
    expect(me.user).toMatchObject({ handle: 'alex', role: 'creator' })
  })

  test('a session ends after 2 hours idle or 12 hours in all', async () => {
    const s = setup()
    const { cookie } = await s.signIn('alex')
    s.advance(2 * 3600_000 + 1)
    expect((await s.call('/api/me', { cookie })).status).toBe(401)
    const again = await s.signIn('alex')
    for (let i = 0; i < 7; i++) {
      s.advance(3600_000 + 30 * 60_000)
      expect((await s.call('/api/me', { cookie: again.cookie })).status).toBe(200)
    }
    s.advance(2 * 3600_000)
    expect((await s.call('/api/me', { cookie: again.cookie })).status).toBe(401)
  })

  test('the database holds only a hash of the session ID', async () => {
    const { db, signIn } = setup()
    const { cookie } = await signIn('alex')
    const sid = cookie.split('=')[1] as string
    const ids = (db.query('select id from sessions').all() as { id: string }[]).map((r) => r.id)
    expect(ids).toHaveLength(1)
    expect(ids).not.toContain(sid)
  })

  test('sign-out ends the session', async () => {
    const { call, signIn } = setup()
    const { cookie, body } = await signIn('alex')
    expect(
      (
        await call('/api/sign-out', {
          method: 'POST',
          headers: { origin: APP },
          cookie,
          csrf: body.csrf,
        })
      ).status,
    ).toBe(200)
    expect((await call('/api/me', { cookie })).status).toBe(401)
  })

  test('the interface language is saved per person', async () => {
    const { call, signIn } = setup()
    const { cookie, body } = await signIn('alex')
    await call('/api/me/language', {
      method: 'POST',
      headers: { origin: APP },
      cookie,
      csrf: body.csrf,
      body: '{"language":"da"}',
    })
    const me = (await (await call('/api/me', { cookie })).json()) as { user: { language: string } }
    expect(me.user.language).toBe('da')
  })
})

describe('roles (permission-cases.md: a Creator can\x27t use Admin areas)', () => {
  test('every Admin capability refuses a Creator and admits an Admin', async () => {
    const { db } = setup()
    const app = new Hono<{ Variables: { user: { role: 'admin' | 'creator' } } }>()
    for (const cap of ADMIN_CAPABILITIES) {
      app.get(
        `/${cap}`,
        (c, next) => {
          c.set('user', { role: c.req.header('x-role') as 'admin' | 'creator' })
          return next()
        },
        requireCapability(cap),
        (c) => c.text('ok'),
      )
    }
    expect(ADMIN_CAPABILITIES).toEqual(
      expect.arrayContaining([
        'publish',
        'deployment',
        'backups',
        'mail',
        'users',
        'models',
        'kill-switch',
      ]),
    )
    for (const cap of ADMIN_CAPABILITIES) {
      expect((await app.request(`/${cap}`, { headers: { 'x-role': 'creator' } })).status).toBe(403)
      expect((await app.request(`/${cap}`, { headers: { 'x-role': 'admin' } })).status).toBe(200)
    }
    db.close()
  })

  test('the seed creates 2 Admins without passwords and 20 Creators with letter-only handles', () => {
    const { db } = setup()
    const users = db.query('select handle, role, password_hash from users').all() as {
      handle: string
      role: string
      password_hash: string | null
    }[]
    expect(users.filter((u) => u.role === 'admin')).toHaveLength(2)
    expect(users.filter((u) => u.role === 'admin').every((u) => u.password_hash === null)).toBe(
      true,
    )
    expect(users.filter((u) => u.role === 'creator')).toHaveLength(20)
    expect(users.every((u) => /^[a-z]+$/.test(u.handle))).toBe(true)
  })
})
