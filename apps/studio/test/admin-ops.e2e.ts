// M8 Admin screens in a real browser: Setup, Models, Backups, Usage, Projects and Project
// settings. The server is the real apps/studio/server/main.ts on a temp DATA_DIR, with a mock
// OpenAI-compatible endpoint for Test connection and a temp folder as the backup target.
// Runs under Node: `bun run test:browser`.
import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, chromium, type Page } from 'playwright-core'

const PORT = 3201
const APP = `http://localhost:${PORT}`
const STUDIO = fileURLToPath(new URL('..', import.meta.url))
const DATA = mkdtempSync(join(tmpdir(), 'studio-ops-e2e-'))
const BACKUPS = mkdtempSync(join(tmpdir(), 'studio-ops-backups-'))
const RESTORED = join(mkdtempSync(join(tmpdir(), 'studio-ops-restore-')), 'copy')
let server: ChildProcess
let browser: Browser
let stdout = ''
let llm: Server
let admin: Page

function bunBinary(): string {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const exec = process.env.npm_execpath
  if (exec && /bun(\.exe)?$/i.test(exec)) return exec
  if (process.platform !== 'win32') return 'bun'
  return join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'bun', 'bin', 'bun.exe')
}

before(async () => {
  llm = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
        return res.writeHead(404).end()
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        chunk({ choices: [{ delta: { content: '{"ok":' } }] }) +
          chunk({ choices: [{ delta: { content: 'true}' } }] }) +
          chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }) +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve))
  server = spawn(bunBinary(), ['server/main.ts'], {
    cwd: STUDIO,
    env: {
      ...process.env,
      APP_URL: APP,
      PREVIEW_URL: `http://127.0.0.1:${PORT + 1}`,
      DATA_DIR: DATA,
      APP_SECRET: 'x'.repeat(40),
      INSTANCE_ID: 'e2e-ops',
      LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
      LLM_API_KEY: 'test-key',
      LLM_MODEL: 'test-model',
    },
  })
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.includes(`app ${APP}`)) resolve()
    })
    once(server, 'exit').then(([code]) => reject(new Error(`server exited ${code}`)))
  })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})

after(async () => {
  await browser?.close()
  server?.kill()
  llm?.close()
  await new Promise((r) => setTimeout(r, 300))
  for (const d of [DATA, BACKUPS, join(RESTORED, '..')])
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const axeClean = async (page: Page, where: string) => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  assert.deepEqual(
    result.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target).join(' | ')}`),
    [],
  )
}

const noSideScroll = async (page: Page, where: string) => {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  const who =
    over > 0
      ? await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter(
              (e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
            )
            .slice(0, 6)
            .map((e) => e.tagName + '.' + e.className),
        )
      : []
  assert.ok(over <= 0, `${where}: the page scrolls sideways by ${over}px: ${who.join(' ')}`)
}

async function open(path: string, heading: string) {
  await admin.goto(`${APP}${path}`)
  await admin.getByRole('heading', { level: 1, name: heading }).waitFor()
}

test('an Admin signs in with a passkey and creates a project', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  context.setDefaultTimeout(10_000)
  admin = await context.newPage()
  const cdp = await context.newCDPSession(admin)
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
  const code = /Setup code for Admin admina: (\S+)/.exec(stdout)?.[1]
  assert.ok(code, 'the server printed a setup code')
  await admin.goto(`${APP}/sign-in`)
  await admin.getByText('First time? Set up your passkey').click()
  await admin.getByLabel('Admin user name').fill('admina')
  await admin.getByLabel('Setup code').fill(code)
  await admin.getByRole('button', { name: 'Set up passkey' }).click()
  await admin.waitForURL(`${APP}/projects`)
  await admin.getByLabel('Project name').fill('Ops Site')
  await admin.getByRole('button', { name: 'Create project' }).click()
  await admin.waitForURL(`${APP}/p/opssite/brief`)
})

test('Setup shows the checklist, computed from the install', async () => {
  await open('/admin/setup', 'Setup checklist')
  assert.equal(await admin.locator('[data-testid=su-list] li').count(), 8)
  assert.match((await admin.getByTestId('su-progress').textContent()) ?? '', /^\d of 8 done$/)
  // Nothing is paired or backed up yet, and each open item links to where the work is done.
  await admin.getByRole('link', { name: 'Open: A backup target is chosen' }).click()
  await admin.waitForURL(`${APP}/admin/backups`)
  await open('/admin/setup', 'Setup checklist')
  await axeClean(admin, 'setup')
})

test('Models adds an endpoint, tests it and shows the detected capability', async () => {
  await open('/admin/models', 'Models')
  // The server environment endpoint is the default until one is added.
  await admin.getByTestId('md-fallback').waitFor()
  await admin.getByRole('button', { name: 'Add endpoint' }).click()
  await admin.getByLabel('Name', { exact: true }).fill('Mock')
  await admin
    .getByLabel('Base URL')
    .fill(`http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`)
  await admin.getByLabel('Key', { exact: true }).fill('secret-key-123')
  await admin.getByLabel('Model', { exact: true }).fill('mock-model')
  await admin.getByRole('button', { name: 'Add endpoint' }).last().click()
  const row = admin.getByTestId('md-endpoint')
  await row.getByText('mock-model').waitFor()
  // The key is write-only: only "Key set" comes back.
  await row.getByText('Key set').waitFor()
  assert.equal(await admin.getByText('secret-key-123').count(), 0)
  await admin.getByRole('button', { name: 'Test connection: Mock' }).click()
  await row.getByText(/Works\. Detected: JSON schema/).waitFor()
  // The override: set it by hand and the screen says so.
  await admin.getByRole('button', { name: 'Edit Mock' }).click()
  await admin.getByLabel('Structured output').selectOption('json_object')
  await admin.getByRole('button', { name: 'Save Mock' }).click()
  await row.getByText(/JSON object · set by an Admin/).waitFor()
  // A role points to the endpoint.
  await admin.getByLabel('Endpoint for writer').selectOption({ label: 'Mock' })
  await admin.getByRole('button', { name: 'Save roles' }).click()
  await admin.getByText('Roles saved and logged.').waitFor()
  await axeClean(admin, 'models')
})

test('Backups runs now to a folder target and lists the backup, then restores a copy', async () => {
  await open('/admin/backups', 'Backups')
  await admin.getByLabel('Folder path').fill(BACKUPS)
  await admin.getByLabel('Passphrase for this backup').fill('short')
  await admin.getByRole('button', { name: 'Back up now' }).click()
  await admin.getByText('The passphrase is too short. Choose a longer one.').waitFor()
  await admin.getByLabel('Passphrase for this backup').fill('a long passphrase 42')
  await admin.getByRole('button', { name: 'Back up now' }).click()
  await admin
    .getByTestId('bk-run-msg')
    .getByText(/^Backed up: ssb-all-/)
    .waitFor()
  // The passphrase is never shown back.
  assert.equal(await admin.getByLabel('Passphrase for this backup').inputValue(), '')
  await admin
    .getByTestId('bk-list')
    .getByText(/ssb-all-.*\.ssbak/)
    .waitFor()
  assert.ok(readdirSync(BACKUPS).some((f) => f.endsWith('.ssbak')))
  await admin
    .getByTestId('bk-last')
    .getByText(/^OK · /)
    .waitFor()
  await axeClean(admin, 'backups')

  await admin.getByRole('button', { name: /^Restore ssb-all-/ }).click()
  await admin.getByLabel('Passphrase of that backup').fill('a long passphrase 42')
  await admin.getByLabel('New folder').fill(RESTORED)
  await admin.getByRole('button', { name: 'Restore into a new folder' }).click()
  await admin.getByText(/^Restored \d+ files into /).waitFor()
  assert.ok(existsSync(RESTORED))
})

test('Usage loads site figures, one person and the retention setting', async () => {
  await open('/admin/usage', 'Usage statistics')
  await admin.getByTestId('ug-totals').waitFor()
  // The Test connection call above is in the figures.
  await admin.getByRole('heading', { name: 'Per role' }).waitFor()
  await admin.getByLabel('User name').fill('admina')
  await admin.getByRole('button', { name: 'Show this person’s figures' }).click()
  await admin.getByRole('heading', { name: 'Figures for admina' }).waitFor()
  await admin.getByLabel('Keep per-person rows for … days').fill('60')
  await admin.getByRole('button', { name: 'Save retention' }).click()
  await admin.getByText('Retention saved and logged.').waitFor()
  await axeClean(admin, 'usage')
})

test('Projects overview and Project settings', async () => {
  await open('/admin/projects', 'Projects overview')
  await admin.getByTestId('pj-list').getByText('Ops Site').waitFor()
  await axeClean(admin, 'projects')
  await admin.getByRole('link', { name: 'Settings of Ops Site' }).click()
  await admin.waitForURL(`${APP}/p/opssite/settings`)
  await admin.getByRole('heading', { level: 1, name: 'opssite' }).waitFor()
  await admin
    .getByRole('button', { name: 'An Admin approves structure changes before staging' })
    .click()
  await admin.getByRole('button', { name: 'Save project settings' }).click()
  await admin.getByText('Project settings saved and logged.').waitFor()
  await axeClean(admin, 'project settings')
})

test('Send request now reaches the Admin before any revision is saved', async () => {
  await admin.setViewportSize({ width: 1440, height: 900 })
  await admin.goto(`${APP}/p/opssite/pages/new`)
  await admin.getByRole('heading', { level: 1, name: 'New page' }).waitFor()
  await admin.getByLabel('Working title').fill('Promo page')
  await admin.getByRole('button', { name: /Own subdomain or domain/ }).click()
  await admin.getByLabel('Suggested name').fill('promo')
  await admin.getByText(/promo..* is free./).waitFor()
  await admin.getByLabel('Send request now').check()
  await admin.getByLabel('Note for the Admins').fill('For the launch')
  await axeClean(admin, 'new page')
  await admin.getByRole('button', { name: 'Create page' }).click()
  await admin.waitForURL(`${APP}/p/opssite/structure`)
  // The Admin's list shows it, though nothing has been saved as a revision.
  await admin.goto(`${APP}/admin`)
  await admin.getByRole('link', { name: 'Open address request' }).first().waitFor()
  await axeClean(admin, 'inbox')
  await admin.getByRole('link', { name: 'Open address request' }).first().click()
  await admin.waitForURL(`${APP}/admin/addresses/opssite/promo`)
  await admin.getByText(/sent now, not yet in a saved revision/).waitFor()
  await admin.getByText('For the launch').waitFor()
  await axeClean(admin, 'address request')
  // Approving may ask for the passkey again (step-up); the virtual authenticator answers it.
  await admin.getByRole('button', { name: /^Approve Reserve/ }).click()
  await admin.getByRole('button', { name: /^Approve promo./ }).click()
  await admin.getByText('Reserved', { exact: true }).waitFor()
  await axeClean(admin, 'address request decided')
})

test('the screens have no sideways scroll at 390px and read in Danish', async () => {
  await admin.setViewportSize({ width: 390, height: 844 })
  for (const [path, heading] of [
    ['/admin/setup', 'Setup checklist'],
    ['/admin/models', 'Models'],
    ['/admin/backups', 'Backups'],
    ['/admin/usage', 'Usage statistics'],
    ['/admin/projects', 'Projects overview'],
    ['/p/opssite/settings', 'opssite'],
  ] as const) {
    await open(path, heading)
    await admin.waitForLoadState('networkidle')
    await noSideScroll(admin, path)
    if (process.env.SHOTS)
      await admin.screenshot({
        path: join(process.env.SHOTS, `m390-${path.replaceAll('/', '_')}.png`),
        fullPage: true,
      })
  }
  await admin.setViewportSize({ width: 1440, height: 900 })
  for (const [path, heading] of [
    ['/admin/setup', 'Setup checklist'],
    ['/admin/models', 'Models'],
    ['/admin/backups', 'Backups'],
    ['/admin/usage', 'Usage statistics'],
    ['/admin/projects', 'Projects overview'],
    ['/p/opssite/settings', 'opssite'],
  ] as const) {
    if (!process.env.SHOTS) break
    await open(path, heading)
    await admin.waitForLoadState('networkidle')
    await admin.screenshot({
      path: join(process.env.SHOTS, `d1440-${path.replaceAll('/', '_')}.png`),
      fullPage: true,
    })
  }
  await admin.getByRole('button', { name: 'Account menu' }).click()
  await admin.getByRole('button', { name: 'DA', exact: true }).click()
  await open('/admin/backups', 'Backup')
  await admin.getByRole('heading', { name: 'Gendan som en ny kopi' }).waitFor()
  await axeClean(admin, 'backups da')
})
