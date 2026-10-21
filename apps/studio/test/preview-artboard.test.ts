// Artboard previews (decision #45, rule 4): signed paths on the preview site, contract CSP,
// no cookies, and nothing but the two signed blobs.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LINK_LIFETIME_MS,
  signArtboardLink,
  verifyArtboardLink,
} from '../server/preview/artboard-link.ts'
import { createPreview } from '../server/preview/index.ts'
import { putBlob } from '../server/store/blobs.ts'
import { projectDir } from '../server/store/revisions.ts'

const secret = 'x'.repeat(40)
const appUrl = new URL('http://localhost:3000')
const dataDir = mkdtempSync(join(tmpdir(), 'ss-prev-'))
afterAll(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }))
const enc = new TextEncoder()
const page =
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><section data-section="s-abc123">Hi</section></body></html>'

async function setup() {
  const html = await putBlob(projectDir(dataDir, 'go'), enc.encode(page))
  const css = await putBlob(projectDir(dataDir, 'go'), enc.encode('section{color:#2b675b}'))
  const other = await putBlob(projectDir(dataDir, 'go'), enc.encode('private draft'))
  const preview = createPreview({ appUrl, appSecret: secret, dataDir })
  return { html, css, other, preview, base: signArtboardLink(secret, { project: 'go', html, css }) }
}

describe('artboard preview links', () => {
  test('serves the shell, the stored html and css byte for byte', async () => {
    const { preview, base } = await setup()
    const shell = await preview.request(base)
    expect(shell.status).toBe(200)
    const shellText = await shell.text()
    expect(shellText).toContain('src="/_shell/shell.js"')
    expect(shellText).not.toMatch(/<script>|on[a-z]+=/)
    expect(shell.headers.get('content-security-policy')).toContain("frame-src 'self'")

    const html = await preview.request(`${base}index.html`)
    expect(await html.text()).toBe(page)
    const csp = html.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'self' http://localhost:3000")
    expect(html.headers.get('set-cookie')).toBeNull()
    expect(html.headers.get('referrer-policy')).toBe('no-referrer')
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await (await preview.request(`${base}style.css`)).text()).toBe('section{color:#2b675b}')
  })

  test('a tampered, foreign or expired link serves nothing', async () => {
    const { preview, base, html, css, other } = await setup()
    const token = base.split('/')[2] as string
    const [payload, sig] = token.split('.') as [string, string]
    // Swap in another blob, keep the signature.
    const forged = Buffer.from(
      JSON.stringify({ project: 'go', html: other, css, exp: Date.now() + 60_000 }),
    ).toString('base64url')
    expect((await preview.request(`/a/${forged}.${sig}/index.html`)).status).toBe(404)
    expect((await preview.request(`/a/${payload}.${sig}x/index.html`)).status).toBe(404)
    expect((await preview.request(`/a/${payload}/index.html`)).status).toBe(404)
    // Signed with another secret.
    const foreign = signArtboardLink('y'.repeat(40), { project: 'go', html, css })
    expect((await preview.request(`${foreign}index.html`)).status).toBe(404)
    // Expired.
    const old = signArtboardLink(
      secret,
      { project: 'go', html, css },
      Date.now() - LINK_LIFETIME_MS - 1,
    )
    expect((await preview.request(`${old}index.html`)).status).toBe(404)
    expect(verifyArtboardLink(secret, token)).not.toBeNull()
  })

  test('only index.html and style.css exist under a link', async () => {
    const { preview, base } = await setup()
    for (const p of ['other.html', '../index.html', 'blobs/x', 'index.html/x'])
      expect((await preview.request(`${base}${p}`)).status).toBe(404)
  })

  test('without a secret the preview serves no artboards', async () => {
    const { base } = await setup()
    const bare = createPreview({ appUrl })
    expect((await bare.request(`${base}index.html`)).status).toBe(404)
  })

  test('refuses to sign a malformed project or hash', () => {
    expect(() =>
      signArtboardLink(secret, { project: '../x', html: 'sha256:00', css: null }),
    ).toThrow()
  })
})
