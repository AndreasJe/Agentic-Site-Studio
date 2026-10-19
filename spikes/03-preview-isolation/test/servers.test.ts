// The two servers over HTTP (no browser): headers, cookies and bytes.
import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appCsp, startApp } from '../src/app.ts'
import { previewCsp, startPreview } from '../src/preview.ts'
import { packageFiles, REVISIONS } from '../src/revisions.ts'

const APP = 'http://localhost:3999'
const CONTRACT = readFileSync(join(import.meta.dir, '../../../contracts/csp.txt'), 'utf8')
const preview = startPreview({
  port: 0,
  appOrigin: APP,
  packages: Object.fromEntries(Object.entries(REVISIONS).map(([rev, r]) => [rev, r.dir])),
})
const PREVIEW = `http://127.0.0.1:${preview.port}`
const app = startApp({
  port: 0,
  appOrigin: APP,
  previewOrigin: PREVIEW,
  revisions: { 'rev-clean': { sections: ['hero'], hash: 'h' } },
})
afterAll(() => {
  preview.stop(true)
  app.stop(true)
})

describe('preview', () => {
  test('the package CSP is the contract with only frame-src and frame-ancestors changed', () => {
    const csp = previewCsp(CONTRACT, APP)
    expect(csp).toBe(
      CONTRACT.trim()
        .replace('frame-src <approved video platform host>', "frame-src 'none'")
        .replace("frame-ancestors 'none'", `frame-ancestors 'self' ${APP}`),
    )
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('<')
    expect(() => previewCsp("default-src 'self'", APP)).toThrow()
  })

  test('every package file is served byte for byte, with the CSP header and no cookie', async () => {
    for (const [rev, { dir }] of Object.entries(REVISIONS))
      for (const [path, abs] of packageFiles(dir)) {
        const res = await fetch(`${PREVIEW}/r/${rev}/${path}`)
        expect(res.status).toBe(200)
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(readFileSync(abs)))
        expect(res.headers.get('content-security-policy')).toBe(previewCsp(CONTRACT, APP))
        expect(res.headers.get('set-cookie')).toBeNull()
      }
  })

  test('the shell is framed only by the app and sets no cookie', async () => {
    const res = await fetch(`${PREVIEW}/__review/rev-clean/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain(`frame-ancestors ${APP};`)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.text()).toContain('data-src="/r/rev-clean/index.html"')
  })

  test('anything outside a package is not found', async () => {
    for (const path of [
      '/r/rev-clean/../../src/main.ts',
      '/r/rev-clean/%2e%2e/%2e%2e/src/main.ts',
      '/r/rev-clean/..%5c..%5csrc%5cmain.ts',
      '/r/rev-nope/index.html',
      '/__review/rev-nope/',
      '/',
    ])
      expect((await fetch(`${PREVIEW}${path}`)).status).toBe(404)
  })
})

describe('app', () => {
  test('pages forbid framing and only the preview may be framed', async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/review/rev-clean`)
    expect(res.headers.get('content-security-policy')).toBe(appCsp(PREVIEW))
    expect(appCsp(PREVIEW)).toContain("frame-ancestors 'none'")
    expect(appCsp(PREVIEW)).toContain(`frame-src ${PREVIEW};`)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  test('sign-in sets the __Host- session cookie and approval needs the CSRF token', async () => {
    const base = `http://127.0.0.1:${app.port}`
    const signIn = await fetch(`${base}/api/sign-in`, { method: 'POST', headers: { origin: APP } })
    const cookie = signIn.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^__Host-sid=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/)
    expect(cookie).not.toMatch(/domain/i)
    const { csrf } = (await signIn.json()) as { csrf: string }
    const sid = cookie.split(';')[0] ?? ''
    const approve = (headers: Record<string, string>) =>
      fetch(`${base}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ rev: 'rev-clean', section: 'hero' }),
      })
    expect((await approve({ origin: APP, cookie: sid })).status).toBe(403)
    expect((await approve({ origin: PREVIEW, cookie: sid, 'x-csrf-token': csrf })).status).toBe(403)
    const ok = await approve({ origin: APP, cookie: sid, 'x-csrf-token': csrf })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { approved: string[] }).approved).toEqual(['hero'])
  })
})
