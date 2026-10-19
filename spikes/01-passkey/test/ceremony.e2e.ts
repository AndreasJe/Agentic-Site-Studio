// Real browser ceremonies against the spike server: Edge (already installed, no download) with
// Chrome's virtual authenticator over CDP. Runs under Node: `bun run test:browser`.
import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright-core'

const PORT = 3123
const APP = `http://localhost:${PORT}`
const SPIKE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'spike1-e2e-'))
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
    cwd: SPIKE,
    env: { ...process.env, PORT: String(PORT), OUT_DIR: OUT },
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
  rmSync(OUT, { recursive: true, force: true })
})

/** The separate production process (src/production.ts): files in, ACCEPTED/REFUSED out. */
function production(...args: string[]): string {
  const p = spawnSync(bunBinary(), ['src/production.ts', ...args], { cwd: SPIKE, encoding: 'utf8' })
  return p.stdout.trim()
}

const statusText = (page: Page) =>
  page
    .locator('#status')
    .textContent()
    .then((t) => t ?? '')
const waitStatus = (page: Page, re: RegExp) =>
  page.waitForFunction(
    (source) => new RegExp(source).test(document.querySelector('#status')?.textContent ?? ''),
    re.source,
  )

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

test('a real browser passkey signs the pairing file and a release; production checks them offline', async () => {
  const page = await pageWithAuthenticator({ hasUserVerification: true, isUserVerified: true })
  await page.goto(APP)
  await page.getByRole('button', { name: 'Register a passkey' }).click()
  await waitStatus(page, /^Registered/)

  const state = join(OUT, 'production-state')
  assert.equal(production('init', state), 'INITIALISED')

  await page.getByRole('button', { name: 'Sign the pairing keys file' }).click()
  await waitStatus(page, /^Signed|Refused|Browser refused/)
  const shown = await statusText(page)
  const fingerprint = shown.match(/fingerprint (SHA256:\S+)/)?.[1] ?? ''
  assert.match(fingerprint, /^SHA256:/, shown)
  const genesis = join(OUT, 'command-1.json')
  // The production side shows the same fingerprint for the person to compare.
  assert.equal(
    production('command', state, genesis),
    `FINGERPRINT ${fingerprint}\nREFUSED fingerprint-not-confirmed`,
  )
  assert.equal(production('command', state, genesis, '--confirm', fingerprint), 'ACCEPTED')

  await page.getByLabel('Release number').fill('1')
  await page.getByRole('button', { name: 'Sign release' }).click()
  await waitStatus(page, /^Signed|Refused|Browser refused/)
  assert.match(await statusText(page), /release-1\.json/)
  const release = join(OUT, 'release-1.json')
  const bundle = join(OUT, 'bundle-1.bin')

  const tampered = readFileSync(bundle)
  tampered[10] = (tampered[10] ?? 0) ^ 1
  writeFileSync(join(OUT, 'bundle-1-tampered.bin'), tampered)
  assert.match(
    production('release', state, release, join(OUT, 'bundle-1-tampered.bin')),
    /^REFUSED hash-mismatch/,
  )
  assert.equal(production('release', state, release, bundle), 'ACCEPTED')
  assert.match(production('release', state, release, bundle), /^REFUSED release-number-not-higher/)
  await page.close()
})
