// Review previews (decision #46, rule 4): signed paths on the preview site serve a saved
// revision's package exactly, only its listed paths, with the contract CSP and no cookies.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreview } from '../server/preview/index.ts'
import {
  REVIEW_LINK_LIFETIME_MS,
  signReviewLink,
  verifyReviewLink,
} from '../server/preview/review-link.ts'
import { putBlob } from '../server/store/blobs.ts'
import { projectDir } from '../server/store/revisions.ts'

const secret = 'x'.repeat(40)
const appUrl = new URL('http://localhost:3000')
const dataDir = mkdtempSync(join(tmpdir(), 'ss-review-'))
afterAll(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }))
const enc = new TextEncoder()
const HOME =
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><section data-section="s-abc123">Home</section></body></html>'
const HASH = 'a'.repeat(64)

async function setup() {
  const dir = projectDir(dataDir, 'go')
  const files = {
    'index.html': await putBlob(dir, enc.encode(HOME)),
    'style.css': await putBlob(dir, enc.encode('body{color:#2b675b}')),
    'about/index.html': await putBlob(dir, enc.encode('<p>About</p>')),
  }
  await putBlob(dir, enc.encode('private draft'))
  mkdirSync(join(dir, 'packages'), { recursive: true })
  writeFileSync(
    join(dir, 'packages', 'go-r1.json'),
    JSON.stringify({ rev: 'go-r1', hash: HASH, files }),
  )
  const preview = createPreview({ appUrl, appSecret: secret, dataDir })
  const base = signReviewLink(secret, { project: 'go', rev: 'go-r1', hash: HASH })
  return { preview, base, files: base.replace('/__review/', '/r/') }
}

describe('review links', () => {
  test('the shell loads only our scripts and frames the package sandboxed', async () => {
    const { preview, base } = await setup()
    const r = await preview.request(base)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('src="/__review/shell.js"')
    expect(html).toContain('sandbox="allow-same-origin"')
    expect(html).not.toMatch(/<script>|\son[a-z]+=/)
    expect(r.headers.get('content-security-policy')).toContain("frame-src 'self'")
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  test('package files are served byte for byte with the contract CSP', async () => {
    const { preview, files } = await setup()
    for (const [p, body] of [
      ['index.html', HOME],
      ['', HOME],
      ['about/', '<p>About</p>'],
      ['about/index.html', '<p>About</p>'],
    ] as const) {
      const r = await preview.request(`${files}${p}`)
      expect(await r.text()).toBe(body)
      const csp = r.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("connect-src 'self'")
      expect(r.headers.get('set-cookie')).toBeNull()
      expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect((await preview.request(`${files}style.css`)).headers.get('content-type')).toContain(
      'text/css',
    )
  })

  test('only listed paths exist: no traversal, no other blobs', async () => {
    const { preview, files } = await setup()
    for (const p of [
      '../packages/go-r1.json',
      '%2e%2e/x',
      'blobs/sha256/x',
      'nope.html',
      'about',
      '%E0%A4%A',
    ])
      expect((await preview.request(`${files}${p}`)).status).toBe(404)
  })

  test('a tampered, expired, foreign or mismatched link serves nothing', async () => {
    const { preview, base } = await setup()
    const token = base.split('/')[2] as string
    expect(verifyReviewLink(secret, token)).not.toBeNull()
    const [payload, sig] = token.split('.') as [string, string]
    const forged = Buffer.from(
      JSON.stringify({ project: 'go', rev: 'go-r2', hash: HASH, exp: Date.now() + 60_000 }),
    ).toString('base64url')
    expect((await preview.request(`/__review/${forged}.${sig}/`)).status).toBe(404)
    const old = signReviewLink(
      secret,
      { project: 'go', rev: 'go-r1', hash: HASH },
      Date.now() - REVIEW_LINK_LIFETIME_MS - 1,
    )
    expect((await preview.request(old)).status).toBe(404)
    const foreign = signReviewLink('y'.repeat(40), { project: 'go', rev: 'go-r1', hash: HASH })
    expect((await preview.request(foreign)).status).toBe(404)
    // Signed for another package hash than the one on disk.
    const other = signReviewLink(secret, { project: 'go', rev: 'go-r1', hash: 'b'.repeat(64) })
    expect((await preview.request(other)).status).toBe(404)
    expect((await preview.request(`/__review/${payload}/`)).status).toBe(404)
  })

  test('an artboard token is not a review token', async () => {
    const { preview } = await setup()
    const { signArtboardLink } = await import('../server/preview/artboard-link.ts')
    const a = signArtboardLink(secret, { project: 'go', html: `sha256:${HASH}`, css: null })
    const token = a.split('/')[2] as string
    expect((await preview.request(`/__review/${token}/`)).status).toBe(404)
  })

  test('the shell scripts are served from the preview site', async () => {
    const { preview } = await setup()
    for (const p of ['/__review/shell.js', '/__review/axe.js']) {
      const r = await preview.request(p)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('javascript')
    }
  })
})

describe('the app side (spike 3 must-dos)', () => {
  test('the app sends its own CSP: our scripts only, frames only the preview shells', async () => {
    const { createApp, appCspFor } = await import('../server/app/index.ts')
    const previewUrl = new URL('http://127.0.0.1:3001')
    const app = createApp({ appUrl, instanceId: 't', previewUrl, appSecret: secret, dataDir })
    const csp = (await app.request(`${appUrl.origin}/api/health`)).headers.get(
      'content-security-policy',
    )
    expect(csp).toBe(appCspFor(previewUrl))
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain('frame-src http://127.0.0.1:3001/__review/ http://127.0.0.1:3001/a/')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(appCspFor()).toContain("frame-src 'none'")
  })

  test('a POST from the preview site, or with Origin null, is refused as bad-origin', async () => {
    const { createApp } = await import('../server/app/index.ts')
    const app = createApp({ appUrl, instanceId: 't', dataDir })
    for (const origin of ['http://127.0.0.1:3001', 'null']) {
      const r = await app.request(`${appUrl.origin}/api/p/go/review/go-r1/approve`, {
        method: 'POST',
        headers: { origin, 'content-type': 'text/plain' },
        body: '{}',
      })
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ code: 'bad-origin' })
    }
  })
})
