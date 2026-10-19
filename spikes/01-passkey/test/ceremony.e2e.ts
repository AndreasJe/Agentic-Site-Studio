// Real browser ceremonies against the spike server: Edge (already installed, no download) with
// Chrome's virtual authenticator over CDP. Runs under Node: `bun run test:browser`.
import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { type Browser, chromium, type Page } from 'playwright-core'

const PORT = 3123
const APP = `http://localhost:${PORT}`
let server: ChildProcess
let browser: Browser

// The server needs Bun; on Windows npm only installs a bun.cmd shim, which Node can't spawn
// without a shell, so find the real executable.
function bunBinary(): string {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const exec = process.env.npm_execpath
  if (exec && /bun(\.exe)?$/i.test(exec)) return exec
  if (process.platform !== 'win32') return 'bun'
  return join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'bun', 'bin', 'bun.exe')
}

before(async () => {
  server = spawn(bunBinary(), ['src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT) },
  })
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on('data', (d: Buffer) => d.toString().includes('listening') && resolve())
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)))
  })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})

after(async () => {
  await browser?.close()
  server?.kill()
})

async function pageWithAuthenticator(options: Record<string, unknown>): Promise<Page> {
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      automaticPresenceSimulation: true,
      ...options,
    },
  })
  return page
}

const status = (page: Page) => page.locator('#status')

test('a passkey with user verification registers and signs in', async () => {
  const page = await pageWithAuthenticator({ hasUserVerification: true, isUserVerified: true })
  await page.goto(APP)
  await page.getByRole('button', { name: 'Register a passkey' }).click()
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.startsWith('Registered'),
  )
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.startsWith('Signed in'),
  )
  assert.match((await status(page).textContent()) ?? '', /Signed in as admin/)
  await page.close()
})

test('the server refuses a passkey that did not verify the user', async () => {
  const page = await pageWithAuthenticator({ hasUserVerification: false })
  await page.goto(`${APP}/?uv=preferred`)
  await page.getByRole('button', { name: 'Register a passkey' }).click()
  await page.waitForFunction(() =>
    /Refused|Browser refused/.test(document.querySelector('#status')?.textContent ?? ''),
  )
  assert.equal(await status(page).textContent(), 'Refused · user-not-verified')
  await page.close()
})

test('the server refuses requests from another site (the preview address)', async () => {
  const page = await pageWithAuthenticator({ hasUserVerification: true, isUserVerified: true })
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.getByRole('button', { name: 'Register a passkey' }).click()
  await page.waitForFunction(() =>
    /Refused/.test(document.querySelector('#status')?.textContent ?? ''),
  )
  assert.equal(await status(page).textContent(), 'Refused · bad-origin')
  await page.close()
})

test("the browser refuses the app's rpId on another site, for create and get", async () => {
  const page = await pageWithAuthenticator({ hasUserVerification: true, isUserVerified: true })
  await page.goto(`http://127.0.0.1:${PORT}/`)
  const errors = await page.evaluate(async () => {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const tryIt = (p: Promise<unknown>) =>
      p.then(
        () => 'accepted',
        (e: Error) => e.name,
      )
    return [
      await tryIt(
        navigator.credentials.create({
          publicKey: {
            rp: { id: 'localhost', name: 'app' },
            user: { id: new Uint8Array(16), name: 'x', displayName: 'x' },
            challenge,
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          },
        }),
      ),
      await tryIt(navigator.credentials.get({ publicKey: { rpId: 'localhost', challenge } })),
    ]
  })
  assert.deepEqual(errors, ['SecurityError', 'SecurityError'])
  await page.close()
})
