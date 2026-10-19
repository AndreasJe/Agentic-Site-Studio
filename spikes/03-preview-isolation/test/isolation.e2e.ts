// Spike 3 in a real browser: Edge (installed, no download) against the app on localhost and the
// preview on 127.0.0.1, two different sites. Runs under Node: `bun run test:browser`.
// Run 1 has the preview CSP header on; run 2 turns it off to show that SameSite, Origin and CSRF
// alone still stop the authenticated requests.
import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'

const SPIKE = fileURLToPath(new URL('..', import.meta.url))

// The server needs Bun; on Windows npm only installs a bun.cmd shim, which Node can't spawn
// without a shell, so find the real executable.
function bunBinary(): string {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const exec = process.env.npm_execpath
  if (exec && /bun(\.exe)?$/i.test(exec)) return exec
  if (process.platform !== 'win32') return 'bun'
  return join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'bun', 'bin', 'bun.exe')
}

type Entry = Record<string, unknown>
type Results = Record<string, unknown> & { violations: { directive: string; blocked: string }[] }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function servers(base: number, csp: boolean) {
  const APP = `http://localhost:${base}`
  const PREVIEW = `http://127.0.0.1:${base + 1}`
  const LAN = `http://127.0.0.1:${base + 2}`
  const logs: { who: string; entry: Entry }[] = []
  let server: ChildProcess
  let browser: Browser

  before(async () => {
    server = spawn(bunBinary(), ['src/main.ts'], {
      cwd: SPIKE,
      env: {
        ...process.env,
        APP_PORT: String(base),
        PREVIEW_PORT: String(base + 1),
        LAN_PORT: String(base + 2),
        PREVIEW_CSP: csp ? 'on' : 'off',
      },
    })
    let buffer = ''
    await new Promise<void>((resolve, reject) => {
      server.stdout?.on('data', (d: Buffer) => {
        buffer += d.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('listening')) resolve()
          const m = /^LOG (\w+) (.*)$/.exec(line.trim())
          if (m?.[1] && m[2]) logs.push({ who: m[1], entry: JSON.parse(m[2]) as Entry })
        }
      })
      server.on('exit', (code) => reject(new Error(`server exited ${code}`)))
    })
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  })

  after(async () => {
    await browser?.close()
    server?.kill()
  })

  const query = `?app=${encodeURIComponent(APP)}&lan=${encodeURIComponent(LAN)}`

  async function signedIn(): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext()
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable', { enableUI: false })
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    await page.goto(`${APP}/review/rev-clean`)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.locator('body[data-ready="1"]').waitFor({ state: 'attached' })
    return { context, page }
  }

  /** Opens the attack package in the app's review page and returns what it recorded. */
  async function attackInReview(page: Page): Promise<Results> {
    await page.goto(`${APP}/review/rev-attack${query}`)
    const pkg = page.frameLocator('#shell').frameLocator('#site')
    await pkg.locator('body[data-done="1"]').waitFor({ state: 'attached', timeout: 30_000 })
    await sleep(1000) // late requests (the form, the frame) and their log lines
    return JSON.parse((await pkg.locator('#results').textContent()) ?? '{}') as Results
  }

  const appState = (page: Page, rev: string) =>
    page.evaluate(
      async (r) => (await (await fetch(`/api/revision?rev=${r}`)).json()) as { approved: string[] },
      rev,
    )
  const crossSite = () => logs.filter((l) => l.who === 'app' && l.entry.site === 'cross-site')
  const lanHits = () => logs.filter((l) => l.who === 'lan')

  /** Every frame the package opened (the app frame, the form's sink) is a browser error page. */
  async function assertAppFrameBlocked(page: Page) {
    const opened = page
      .frames()
      .filter((f) => f !== page.mainFrame() && !f.url().startsWith(PREVIEW))
    assert.equal(opened.length, 2, opened.map((f) => f.url()).join(', '))
    for (const frame of opened) {
      assert.equal(frame.url(), 'chrome-error://chromewebdata/')
      assert.equal(await frame.evaluate(() => document.querySelector('#approve')), null)
    }
  }

  return {
    APP,
    PREVIEW,
    LAN,
    query,
    signedIn,
    attackInReview,
    appState,
    crossSite,
    lanHits,
    assertAppFrameBlocked,
  }
}

describe('preview CSP on', () => {
  const s = servers(3311, true)

  test('sign-in sets a host-only, HttpOnly, SameSite=Strict, Secure __Host- cookie', async () => {
    const { context } = await s.signedIn()
    const cookies = await context.cookies()
    assert.equal(cookies.length, 1)
    const [c] = cookies
    assert.equal(c?.name, '__Host-sid')
    assert.equal(c?.domain, 'localhost') // no leading dot: host-only
    assert.equal(c?.path, '/')
    assert.equal(c?.httpOnly, true)
    assert.equal(c?.sameSite, 'Strict')
    assert.equal(c?.secure, true)
    await context.close()
  })

  test('every attack from the package fails inside the review page', async () => {
    const { context, page } = await s.signedIn()
    const r = await s.attackInReview(page)
    const blocked = (directive: string, prefix: string) =>
      r.violations.some((v) => v.directive === directive && v.blocked.startsWith(prefix))

    assert.equal(r.cookie, '', 'no app cookie visible to the package')

    assert.match(String(r.fetchPost), /^error: TypeError/)
    assert.match(String(r.fetchGet), /^error: TypeError/)
    assert.equal(r.imageBeacon, 'error')
    assert.ok(blocked('connect-src', s.APP), 'fetch to the app is a CSP violation')
    assert.ok(blocked('img-src', s.APP), 'image beacon is a CSP violation')
    assert.ok(blocked('form-action', s.APP), 'form POST is a CSP violation')
    assert.ok(blocked('frame-src', s.APP), 'framing the app is a CSP violation')
    assert.deepEqual(s.crossSite(), [], 'the app never received a request from the preview')
    await s.assertAppFrameBlocked(page)

    assert.match(String(r.webauthn), /^error: (NotAllowedError|SecurityError)$/)

    assert.match(String(r.lanFetch), /^error: TypeError/)
    assert.equal(r.lanImage, 'error')
    assert.equal(r.lanSocket, 'error')
    assert.ok(blocked('connect-src', s.LAN), 'fetch to the LAN host is a CSP violation')
    assert.ok(blocked('img-src', s.LAN), 'image to the LAN host is a CSP violation')
    assert.ok(blocked('connect-src', s.LAN.replace('http', 'ws')), 'WebSocket is a CSP violation')
    assert.deepEqual(s.lanHits(), [], 'the LAN host received nothing')

    const messages = page.locator('#messages')
    assert.equal(await messages.getAttribute('data-accepted'), '0')
    assert.equal(await messages.getAttribute('data-rejected'), '3')
    assert.match((await messages.textContent()) ?? '', /wrong-source, wrong-source, wrong-source/)
    assert.equal(await page.locator('#selected').textContent(), 'none')
    assert.deepEqual((await s.appState(page, 'rev-attack')).approved, [])
    await context.close()
  })

  test("WebAuthn for the app's rpId throws SecurityError on the preview", async () => {
    const { context } = await s.signedIn()
    const page = await context.newPage()
    await page.goto(`${s.PREVIEW}/r/rev-attack/index.html${s.query}`)
    await page.locator('body[data-done="1"]').waitFor({ state: 'attached', timeout: 30_000 })
    const r = JSON.parse((await page.locator('#results').textContent()) ?? '{}') as Results
    assert.equal(r.webauthn, 'error: SecurityError')
    assert.equal(r.cookie, '')
    await context.close()
  })

  test('a shell click selects a known section; approval needs the app button', async () => {
    const { context, page } = await s.signedIn()
    const shell = page.frameLocator('#shell')
    await shell.locator('[data-overlay="features"]').click()
    assert.equal(await page.locator('#selected').textContent(), 'features')
    assert.deepEqual((await s.appState(page, 'rev-clean')).approved, [])

    // From the real shell, but with an unknown id or the wrong shape: ignored.
    const shellFrame = page.frames().find((f) => f.url().includes('/__review/rev-clean/'))
    assert.ok(shellFrame)
    await shellFrame.evaluate((app) => {
      parent.postMessage({ type: 'section-click', id: 'not-a-section' }, app)
      parent.postMessage({ type: 'section-click', id: 'hero', extra: 1 }, app)
    }, s.APP)
    await page.waitForFunction(
      () => document.querySelector('#messages')?.getAttribute('data-rejected') === '2',
    )
    assert.equal(await page.locator('#selected').textContent(), 'features')
    assert.match(
      (await page.locator('#messages').textContent()) ?? '',
      /unknown-section, bad-shape/,
    )

    await page.getByRole('button', { name: 'Approve section' }).click()
    await page.locator('#approved', { hasText: 'features' }).waitFor()
    assert.deepEqual((await s.appState(page, 'rev-clean')).approved, ['features'])
    await context.close()
  })
})

describe('preview CSP off: SameSite, Origin and CSRF on their own', () => {
  const s = servers(3321, false)

  test('authenticated requests from the package are still refused', async () => {
    const { context, page } = await s.signedIn()
    const r = await s.attackInReview(page)
    assert.equal(r.violations.length, 0, 'no CSP on the package in this run')
    assert.equal(r.cookie, '')

    const received = s.crossSite().map((l) => l.entry)
    const seen = (method: string, path: string) =>
      received.filter((e) => e.method === method && e.path === path)
    assert.ok(received.length > 0, 'requests reached the app this time')
    for (const e of received)
      assert.equal(e.cookie, false, `no session cookie: ${JSON.stringify(e)}`)
    // fetch POST and form POST: refused on Origin.
    assert.equal(seen('POST', '/api/approve').length, 2)
    for (const e of seen('POST', '/api/approve')) assert.equal(e.status, 403)
    // fetch GET and image beacon: no session.
    assert.equal(seen('GET', '/api/revision').length, 2)
    for (const e of seen('GET', '/api/revision')) assert.equal(e.status, 401)
    assert.match(String(r.fetchGet), /^error: TypeError/, 'the response is unreadable (no CORS)')
    // The frame request arrives, but frame-ancestors 'none' on the app stops it rendering.
    await s.assertAppFrameBlocked(page)

    assert.equal(await page.locator('#messages').getAttribute('data-accepted'), '0')
    assert.equal(await page.locator('#selected').textContent(), 'none')
    assert.deepEqual((await s.appState(page, 'rev-attack')).approved, [])

    // Without the header nothing stops LAN reach: the CSP is the only control there (#40).
    assert.ok(s.lanHits().length >= 3, 'the LAN host was reached once the CSP was off')
    await context.close()
  })
})
