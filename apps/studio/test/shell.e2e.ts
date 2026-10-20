// M1 step 8: the app shell and its four screens in a real browser. Edge (already installed,
// no download) with Chrome's virtual authenticator over CDP. Runs under Node:
// `bun run test:browser`. The server is the real apps/studio/server/main.ts on a temp DATA_DIR.

import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, chromium, type Page } from 'playwright-core'

const PORT = 3141
const APP = `http://localhost:${PORT}`
const STUDIO = fileURLToPath(new URL('..', import.meta.url))
const DATA = mkdtempSync(join(tmpdir(), 'studio-shell-e2e-'))
let server: ChildProcess
let browser: Browser
let stdout = ''

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
  server = spawn(bunBinary(), ['server/main.ts'], {
    cwd: STUDIO,
    env: {
      ...process.env,
      APP_URL: APP,
      PREVIEW_URL: `http://127.0.0.1:${PORT + 1}`,
      DATA_DIR: DATA,
      APP_SECRET: 'x'.repeat(40),
      INSTANCE_ID: 'e2e',
      LLM_BASE_URL: 'http://127.0.0.1:9/v1',
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
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)))
  })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})

after(async () => {
  await browser?.close()
  server?.kill()
  await new Promise((r) => setTimeout(r, 300))
  rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function newContext() {
  const context = await browser.newContext()
  context.setDefaultTimeout(8000)
  return context
}

let alex: Page

async function signInAsAlex(page: Page) {
  await page.goto(`${APP}/sign-in`)
  await page.getByLabel('User name', { exact: true }).fill('alex')
  await page.getByLabel('Password').fill('alex')
  await page.getByRole('button', { name: 'Sign in as Creator' }).click()
  await page.waitForURL(`${APP}/projects`)
}

const createProject = async (page: Page, name: string) => {
  await page.getByLabel('Project name').fill(name)
  await page.getByRole('button', { name: 'Create project' }).click()
}

test('a Creator signs in, creates QualiWare GO and sees its ID', async () => {
  alex = await (await newContext()).newPage()
  await signInAsAlex(alex)
  await alex.getByLabel('Project name').fill('QualiWare GO')
  // The live slug preview comes before anything is sent.
  assert.equal(await alex.locator('.slug').textContent(), 'qualiwarego')
  await alex.getByRole('button', { name: 'Create project' }).click()
  await alex.waitForURL(`${APP}/p/qualiwarego`)
  assert.equal(await alex.locator('.pids .id').first().textContent(), 'qualiwarego')
  assert.equal(await alex.getByRole('heading', { level: 1 }).textContent(), 'QualiWare GO')
})

test('a second project with the same name shows the taken ID and the suggestion', async () => {
  await alex.getByRole('link', { name: 'Projects' }).click()
  await alex.waitForURL(`${APP}/projects`)
  await createProject(alex, 'QualiWare GO')
  await alex.getByText('qualiwarego is taken').waitFor()
  assert.equal(await alex.locator('.id', { hasText: /^qualiwarego2$/ }).count(), 1)
  assert.equal(alex.url(), `${APP}/projects`)
})

test('the Creator saves a draft revision and sees r1 in the timeline', async () => {
  await alex.goto(`${APP}/p/qualiwarego/revisions`)
  const save = alex.getByRole('button', { name: 'Save draft as revision' })
  await save.waitFor()
  assert.equal(await save.isDisabled(), true)
  await alex.getByLabel('Message').fill('ab')
  assert.equal(await save.isDisabled(), true, 'two characters are not enough')
  await alex.getByLabel('Message').fill('  First draft  ')
  assert.equal(await save.isEnabled(), true)
  await save.click()
  await alex.locator('.rv', { hasText: 'qualiwarego-r1' }).waitFor()
  assert.match((await alex.locator('.rv').first().textContent()) ?? '', /First draft/)
  assert.equal(await save.isDisabled(), true, 'the message is cleared after saving')
})

test('continue from here, archive, read-only and a confirmed discard', async () => {
  await alex.getByLabel('Message').fill('Second revision')
  await alex.getByRole('button', { name: 'Save draft as revision' }).click()
  await alex.locator('.rv', { hasText: 'qualiwarego-r2' }).waitFor()
  // Select r1 and continue from it: r3 with r1 as parent.
  await alex.locator('.rv', { hasText: 'qualiwarego-r1' }).click()
  await alex.getByRole('button', { name: 'Open read-only' }).click()
  await alex.getByText('read-only. Nothing here can be changed.').waitFor()
  await alex.getByRole('button', { name: 'Close read-only view' }).click()
  await alex.getByRole('button', { name: 'Continue from here' }).click()
  await alex.locator('.rv', { hasText: 'qualiwarego-r3' }).waitFor()
  assert.match((await alex.locator('aside').textContent()) ?? '', /parent qualiwarego-r1/)
  // Archive r1: marked, not removed.
  await alex.locator('.rv', { hasText: 'qualiwarego-r1' }).click()
  await alex.getByRole('button', { name: 'Archive r1' }).click()
  await alex.locator('.rv.arch', { hasText: 'qualiwarego-r1' }).waitFor()
  await alex.getByRole('button', { name: 'Show r1 in timeline again' }).click()
  await alex.locator('.rv.arch').waitFor({ state: 'detached' })
  // Discard asks first; "Keep" changes nothing.
  await alex.getByRole('button', { name: 'Discard my draft' }).click()
  await alex.getByText('Discard your draft?').waitFor()
  await alex.getByRole('button', { name: 'Keep my draft' }).click()
  assert.equal(await alex.getByText('Discard your draft?').count(), 0)
  await alex.getByRole('button', { name: 'Discard my draft' }).click()
  await alex.getByRole('button', { name: 'Yes, discard my draft' }).click()
  await alex.getByText('Your draft was discarded.').waitFor()
})

test('a Creator does not see Admin menu items', async () => {
  await alex.getByRole('button', { name: 'Account menu' }).click()
  assert.equal(await alex.getByText('Waiting for you').count(), 0)
  assert.equal(await alex.getByText('Admin panel').count(), 0)
  assert.equal(await alex.getByRole('link', { name: 'Projects' }).count(), 1)
  await alex.getByText('Creator', { exact: true }).waitFor()
})

test('the EN/DA switch changes a visible string and is remembered', async () => {
  // The account menu is open from the previous test.
  await alex.getByRole('button', { name: 'DA', exact: true }).click()
  await alex.getByRole('heading', { name: 'Revisioner' }).waitFor()
  await alex.reload()
  await alex.getByRole('heading', { name: 'Revisioner' }).waitFor()
  await alex.getByRole('button', { name: 'Kontomenu' }).click()
  await alex.getByRole('button', { name: 'EN', exact: true }).click()
  await alex.getByRole('heading', { name: 'Revisions' }).waitFor()
})

test('an Admin sets up a passkey with the setup code, signs out and signs in with it', async () => {
  const context = await newContext()
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
  const code = /Setup code for Admin admina: (\S+)/.exec(stdout)?.[1]
  assert.ok(code, 'the server printed a setup code')

  await page.goto(`${APP}/sign-in`)
  await page.getByText('First time? Set up your passkey').click()
  await page.getByLabel('Admin user name').fill('admina')
  await page.getByLabel('Setup code').fill(code)
  await page.getByRole('button', { name: 'Set up passkey' }).click()
  await page.waitForURL(`${APP}/projects`)
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByText('Admin', { exact: true }).waitFor()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL(`${APP}/sign-in`)
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.waitForURL(`${APP}/projects`)
  // The Admin sees every project, including alex's.
  await page.getByRole('link', { name: /QualiWare GO/ }).waitFor()
  await context.close()
})

test('the setup code works once', async () => {
  const code = /Setup code for Admin admina: (\S+)/.exec(stdout)?.[1] ?? ''
  const context = await newContext()
  const page = await context.newPage()
  await page.goto(`${APP}/sign-in`)
  await page.getByText('First time? Set up your passkey').click()
  await page.getByLabel('Admin user name').fill('admina')
  await page.getByLabel('Setup code').fill(code)
  await page.getByRole('button', { name: 'Set up passkey' }).click()
  await page.getByText('The setup code is wrong, used or expired.').waitFor()
  await context.close()
})

test('the brief board: edit a block, answer one guided, approve with open questions', async () => {
  await alex.goto(`${APP}/p/qualiwarego`)
  await alex.getByRole('link', { name: /Brief/ }).click()
  await alex.waitForURL(`${APP}/p/qualiwarego/brief`)
  const openCount = () => alex.locator('#o-h + .chip').textContent()
  assert.equal(await openCount(), '10')
  await alex.locator('.blockcard', { hasText: 'Audience' }).click()
  await alex.locator('#e-text').fill('CIOs and enterprise architects')
  await alex.getByRole('button', { name: 'Save block' }).click()
  await alex.getByText('alex · own text').first().waitFor()
  assert.equal(await openCount(), '9')
  await alex.getByRole('button', { name: /Guided questions/ }).click()
  await alex.locator('#g-text').fill('A whole site, for the launch')
  await alex.getByRole('button', { name: 'Save and next' }).click()
  await alex.waitForFunction(() => document.querySelector('#o-h + .chip')?.textContent === '8')
  // Open questions never block approval (plan §4.6).
  await alex.getByRole('button', { name: 'Approve brief' }).click()
  await alex.getByText('Approved', { exact: true }).waitFor()
})

async function createPage(page: Page, title: string, opts: { under?: string } = {}) {
  await page.goto(`${APP}/p/qualiwarego/pages/new`)
  await page.getByLabel('Working title').fill(title)
  if (opts.under)
    await page.getByLabel('Under', { exact: true }).selectOption({ label: opts.under })
  await page.getByRole('button', { name: 'Create page' }).click()
  await page.waitForURL(`${APP}/p/qualiwarego/structure`)
}

test('structure: add a page, hide it, and a hidden page cannot go in a menu', async () => {
  await alex.goto(`${APP}/p/qualiwarego/structure`)
  await alex.getByRole('link', { name: 'New page' }).click()
  await alex.waitForURL(`${APP}/p/qualiwarego/pages/new`)
  await alex.getByLabel('Working title').fill('Pricing')
  await alex.getByRole('button', { name: 'Create page' }).click()
  await alex.waitForURL(`${APP}/p/qualiwarego/structure`)
  await alex.getByRole('button', { name: /^Pricing/ }).click()
  await alex.getByRole('button', { name: 'Hide, link only' }).click()
  await alex.getByRole('button', { name: 'Show in menu' }).waitFor()
  await alex.getByRole('button', { name: 'Add to main menu' }).click()
  await alex
    .getByRole('alert')
    .filter({ hasText: 'Pricing is hidden and cannot go in a menu' })
    .waitFor()
  await alex.getByRole('button', { name: 'Show in menu' }).click()
  await alex.getByRole('button', { name: 'Add to main menu' }).click()
  await alex.getByText('Pricing added to the Main menu.').waitFor()
})

test('structure: moving a parent moves its child', async () => {
  await createPage(alex, 'Products')
  await createPage(alex, 'Go', { under: 'Products' })
  await createPage(alex, 'Solutions')
  await alex.locator('.node', { hasText: 'example.com/products/go' }).waitFor()
  await alex.getByRole('button', { name: /^Products/ }).click()
  await alex.getByLabel('Move under').selectOption({ label: 'Solutions' })
  await alex.getByRole('button', { name: 'Move', exact: true }).click()
  await alex.locator('.node', { hasText: 'example.com/solutions/products/go' }).waitFor()
})

test('new page: a campaign needs an expiry, and the chip says where it will live', async () => {
  await alex.goto(`${APP}/p/qualiwarego/pages/new`)
  await alex.getByRole('button', { name: /^Campaign/ }).click()
  await alex.getByLabel('Working title').fill('GO launch')
  await alex
    .locator('#where')
    .getByText('Will live at example.com/go-launch · Preview only')
    .waitFor()
  await alex.getByRole('button', { name: 'Create page' }).click()
  await alex.getByRole('alert').filter({ hasText: 'A campaign needs an expiry date.' }).waitFor()
  await alex.getByLabel('Expiry date').fill('2027-03-01')
  await alex.getByRole('button', { name: 'Create page' }).click()
  await alex.waitForURL(`${APP}/p/qualiwarego/structure`)
  await alex.getByRole('button', { name: /^GO launch/ }).click()
  await alex.getByText('Hidden, link only · noindex').waitFor()
  // Own address: the name check answers while typing.
  await alex.goto(`${APP}/p/qualiwarego/pages/new`)
  await alex.getByRole('button', { name: /^Own subdomain/ }).click()
  await alex.getByLabel('Suggested name').fill('www')
  await alex.getByText('www.example.com is taken').waitFor()
  await alex.getByLabel('Suggested name').fill('go')
  await alex.locator('#where').getByText('Will live at go.example.com').waitFor()
  await alex.getByText('go.example.com is free.').waitFor()
})

test('axe finds no WCAG A/AA violations on sign-in, projects, revisions, brief, structure and new page', async () => {
  const check = async (page: Page, where: string) => {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    assert.deepEqual(
      result.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target).join(' | ')}`),
      [],
    )
  }
  const anon = await (await newContext()).newPage()
  await anon.goto(`${APP}/sign-in`)
  await anon.getByRole('button', { name: 'Sign in with passkey' }).waitFor()
  await check(anon, 'sign-in')
  await anon.close()
  await alex.goto(`${APP}/projects`)
  await alex.getByRole('heading', { name: 'Projects' }).waitFor()
  await check(alex, 'projects')
  await alex.goto(`${APP}/p/qualiwarego/revisions`)
  await alex.locator('.rv').first().waitFor()
  await check(alex, 'revisions')
  await alex.goto(`${APP}/p/qualiwarego/brief`)
  await alex.locator('.blockcard').first().waitFor()
  await check(alex, 'brief')
  await alex.goto(`${APP}/p/qualiwarego/structure`)
  await alex.locator('.node').first().waitFor()
  await check(alex, 'structure')
  await alex.goto(`${APP}/p/qualiwarego/pages/new`)
  await alex.locator('.tcard').first().waitFor()
  await check(alex, 'new page')
  await alex.close()
})
