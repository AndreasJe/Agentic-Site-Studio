// The app's Origin and CSRF middleware.
import { describe, expect, test } from 'bun:test'
import { checkRequest, readCookie, SESSION_COOKIE, type Session } from '../src/guard.ts'

const APP = 'http://localhost:3000'
const sessions = new Map<string, Session>([['sid-1', { csrf: 'token-1' }]])
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${APP}/api/approve`, { method, headers })
const check = (r: Request, requireSession = true) =>
  checkRequest(r, { appOrigin: APP, sessions, requireSession })
const full = { origin: APP, cookie: `${SESSION_COOKIE}=sid-1`, 'x-csrf-token': 'token-1' }

describe('checkRequest', () => {
  test('GET and HEAD pass without Origin or token', () => {
    expect(check(req('GET')).ok).toBe(true)
    expect(check(req('HEAD')).ok).toBe(true)
  })

  test('a POST with the app Origin, a session and its token passes', () => {
    expect(check(req('POST', full))).toEqual({ ok: true, sid: 'sid-1' })
  })

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`${method} from another origin, a null origin or none is refused`, () => {
      for (const origin of ['http://127.0.0.1:3001', 'null', 'http://localhost:3001', ''])
        expect(check(req(method, { ...full, origin }))).toEqual({
          ok: false,
          status: 403,
          reason: 'bad-origin',
        })
      const { origin: _, ...noOrigin } = full
      expect(check(req(method, noOrigin))).toMatchObject({ ok: false, reason: 'bad-origin' })
    })
  }

  test('a POST without a known session is refused', () => {
    const { cookie: _, ...noCookie } = full
    expect(check(req('POST', noCookie))).toMatchObject({ ok: false, reason: 'no-session' })
    expect(check(req('POST', { ...full, cookie: `${SESSION_COOKIE}=other` }))).toMatchObject({
      ok: false,
      reason: 'no-session',
    })
    expect(check(req('POST', { ...full, cookie: 'sid=sid-1' }))).toMatchObject({
      ok: false,
      reason: 'no-session',
    })
  })

  test('a POST with a missing, wrong or other-session token is refused', () => {
    const { 'x-csrf-token': _, ...noToken } = full
    for (const headers of [
      noToken,
      { ...full, 'x-csrf-token': 'token-2' },
      { ...full, 'x-csrf-token': 'token-10' },
      { ...full, 'x-csrf-token': '' },
    ])
      expect(check(req('POST', headers))).toMatchObject({ ok: false, reason: 'bad-csrf' })
  })

  test('sign-in needs the Origin but no session', () => {
    expect(check(req('POST', { origin: APP }), false)).toEqual({ ok: true })
    expect(check(req('POST', { origin: 'http://127.0.0.1:3001' }), false)).toMatchObject({
      ok: false,
      reason: 'bad-origin',
    })
  })
})

test('readCookie finds the named cookie only', () => {
  expect(readCookie('a=1; __Host-sid=xyz; b=2', SESSION_COOKIE)).toBe('xyz')
  expect(readCookie('x__Host-sid=xyz', SESSION_COOKIE)).toBeUndefined()
  expect(readCookie(null, SESSION_COOKIE)).toBeUndefined()
})
