// M5: spike 3's attacks against the real preview server and review shell (decision #46).
// A package that went bad is written straight into a project's store (the validator would
// never let its script in), then opened two ways in a signed-in browser:
//  1. as the top page on the preview site, where its script runs: every attack must fail
//     through the contract CSP and site separation, with CSP violations as positive evidence;
//  2. inside the real review shell, where the sandbox stops its script from running at all.
// Runs under Node with the installed Edge: `bun run test:browser`.

import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright-core'
import { signReviewLink } from '../server/preview/review-link.ts'

const PORT = 3161
const APP = `http://localhost:${PORT}`
const PREVIEW = `http://127.0.0.1:${PORT + 1}`
const SECRET = 'x'.repeat(40)
const STUDIO = fileURLToPath(new URL('..', import.meta.url))
const SPIKE = fileURLToPath(
  new URL('../../../spikes/03-preview-isolation/fixtures/attack/', import.meta.url),
)
const DATA = mkdtempSync(join(tmpdir(), 'studio-review-e2e-'))
let server: ChildProcess
let browser: Browser
let lan: Server
let LAN = ''
const lanHits: string[] = []

function bunBinary(): string {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const exec = process.env.npm_execpath
  if (exec && /bun(\.exe)?$/i.test(exec)) return exec
  if (process.platform !== 'win32') return 'bun'
  return join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'bun', 'bin', 'bun.exe')
}

before(async () => {
  // A decoy host on the LAN: anything that reaches it is a failure (#40).
  lan = createServer((req, res) => {
    lanHits.push(`${req.method} ${req.url}`)
    res.end('lan')
  })
  lan.on('upgrade', (req, socket) => {
    lanHits.push(`upgrade ${req.url}`)
    socket.destroy()
  })
  await new Promise<void>((resolve) => lan.listen(0, '127.0.0.1', resolve))
  LAN = `http://127.0.0.1:${(lan.address() as AddressInfo).port}`
  server = spawn(bunBinary(), ['server/main.ts'], {
    cwd: STUDIO,
    env: {
      ...process.env,
      APP_URL: APP,
      PREVIEW_URL: PREVIEW,
      DATA_DIR: DATA,
      APP_SECRET: SECRET,
      INSTANCE_ID: 'e2e-review',
      LLM_BASE_URL: 'http://127.0.0.1:9/v1',
      LLM_API_KEY: 'none',
      LLM_MODEL: 'none',
    },
  })
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
  let out = ''
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes(`app ${APP}`)) resolve()
    })
    once(server, 'exit').then(([code]) => reject(new Error(`server exited ${code}`)))
  })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})

after(async () => {
  await browser?.close()
  server?.kill()
  lan?.close()
  await new Promise((r) => setTimeout(r, 300))
  rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Store bytes the way server/store/blobs.ts does; returns the blob hash. */
function putBlob(project: string, bytes: Buffer): string {
  const hex = createHash('sha256').update(bytes).digest('hex')
  const dir = join(DATA, project, 'blobs', 'sha256', hex.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, hex.slice(2)), bytes)
  return `sha256:${hex}`
}

/** The spike's attack package, aimed at this app and LAN host, as revision attack-r1. */
function writeAttackPackage(project: string): string {
  const approve = `${APP}/api/p/${project}/review/${project}-r1/approve`
  const script = readFileSync(join(SPIKE, 'attack.js'), 'utf8')
    .replace("params.get('app') ?? ''", JSON.stringify(APP))
    .replace("params.get('lan') ?? ''", JSON.stringify(LAN))
    // Both attack requests aim at the real approve route (the spike's template literal).
    .replaceAll(/`\$\{app\}\/api\/approve`/g, JSON.stringify(approve))
  const files = {
    'index.html': putBlob(project, readFileSync(join(SPIKE, 'index.html'))),
    'attack.js': putBlob(project, Buffer.from(script)),
  }
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  const rev = `${project}-r1`
  mkdirSync(join(DATA, project, 'packages'), { recursive: true })
  writeFileSync(
    join(DATA, project, 'packages', `${rev}.json`),
    JSON.stringify({ rev, hash, files }),
  )
  return signReviewLink(SECRET, { project, rev, hash })
}

async function signedIn(name: string): Promise<{ page: Page; project: string }> {
  const context = await browser.newContext()
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  await page.goto(`${APP}/sign-in`)
  await page.getByLabel('User name', { exact: true }).fill('alex')
  await page.getByLabel('Password').fill('alex')
  await page.getByRole('button', { name: 'Sign in as Creator' }).click()
  await page.waitForURL(`${APP}/projects`)
  await page.getByLabel('Project name').fill(name)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.waitForURL(/\/p\/[a-z0-9-]+/)
  const project = /\/p\/([a-z0-9-]+)/.exec(page.url())?.[1] as string
  return { page, project }
}

type Results = Record<string, unknown> & { violations: { directive: string; blocked: string }[] }

test('every spike 3 attack fails when the bad package runs as the top page', async () => {
  const { page, project } = await signedIn('Attack top')
  const link = writeAttackPackage(project)
  // The session cookie exists on the app site; the package must not be able to use it.
  assert.equal((await page.context().cookies(APP)).length, 1)
  const pkg = await page.context().newPage()
  await pkg.goto(`${PREVIEW}${link.replace('/__review/', '/r/')}index.html`)
  await pkg.locator('body[data-done="1"]').waitFor({ state: 'attached', timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 1000))
  const r = JSON.parse((await pkg.locator('#results').textContent()) ?? '{}') as Results
  const blocked = (directive: string, prefix: string) =>
    r.violations.some((v) => v.directive === directive && v.blocked.startsWith(prefix))

  assert.equal(r.cookie, '', 'no app cookie visible to the package')
  assert.match(String(r.fetchPost), /^error: TypeError/)
  assert.match(String(r.fetchGet), /^error: TypeError/)
  assert.equal(r.imageBeacon, 'error')
  // Positive evidence that each request was attempted and stopped, so nothing passes by silence.
  assert.ok(blocked('connect-src', APP), 'fetch to the app is a CSP violation')
  assert.ok(blocked('img-src', APP), 'the image beacon is a CSP violation')
  assert.ok(blocked('form-action', APP), 'the form POST is a CSP violation')
  assert.ok(blocked('frame-src', APP), 'framing the app is a CSP violation')
  assert.match(String(r.webauthn), /^error: (NotAllowedError|SecurityError)$/)
  assert.match(String(r.lanFetch), /^error: TypeError/)
  assert.equal(r.lanImage, 'error')
  assert.equal(r.lanSocket, 'error')
  assert.ok(blocked('connect-src', LAN), 'fetch to the LAN host is a CSP violation')
  assert.deepEqual(lanHits, [], 'the LAN host received nothing')
  await page.context().close()
})

test('inside the real review shell the package runs no script, and the shell loads', async () => {
  const { page, project } = await signedIn('Attack shell')
  const link = writeAttackPackage(project)
  await page.goto(`${PREVIEW}${link}`)
  const shell = page.mainFrame()
  await shell.locator('iframe#page').waitFor()
  const pkg = page.frames().find((f) => f.url().includes('/r/'))
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>('iframe#page')
    return f?.contentDocument?.readyState === 'complete' && f.contentDocument.body
  })
  await new Promise((r) => setTimeout(r, 1500))
  const frame = page.frames().find((f) => f.url().includes('/r/')) ?? pkg
  assert.ok(frame, 'the package frame loaded from /r/')
  assert.equal(await frame.evaluate(() => document.body.dataset.done ?? null), null)
  assert.equal(await frame.locator('#results').textContent(), '')
  assert.equal(await shell.locator('iframe#page').getAttribute('sandbox'), 'allow-same-origin')
  assert.deepEqual(lanHits, [], 'the LAN host received nothing')
  await page.context().close()
})
