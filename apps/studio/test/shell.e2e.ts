// M1 step 8: the app shell and its four screens in a real browser. Edge (already installed,
// no download) with Chrome's virtual authenticator over CDP. Runs under Node:
// `bun run test:browser`. The server is the real apps/studio/server/main.ts on a temp DATA_DIR.

import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
let llm: Server
// The next model answer (a design take); the mock streams it like an OpenAI-compatible endpoint.
let nextReply = ''

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
  llm = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
        return res.writeHead(404).end()
      const half = Math.ceil(nextReply.length / 2)
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
      const parts = [nextReply.slice(0, half), nextReply.slice(half)]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        parts.map((p) => chunk({ choices: [{ delta: { content: p } }] })).join('') +
          chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }) +
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
      INSTANCE_ID: 'e2e',
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
  rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function newContext() {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
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
  const openCount = async () =>
    ((await alex.locator('#o-h').textContent()) ?? '').replace(/\D/g, '')
  assert.equal(await openCount(), '10')
  await alex.locator('.blk', { hasText: 'Audience' }).click()
  await alex.locator('#e-text').fill('CIOs and enterprise architects')
  await alex.getByRole('button', { name: 'Save block' }).click()
  await alex.getByText('alex · own text').first().waitFor()
  assert.equal(await openCount(), '9')
  await alex.getByRole('button', { name: /Guided questions/ }).click()
  await alex.locator('#g-text').fill('A whole site, for the launch')
  await alex.getByRole('button', { name: 'Save and next' }).click()
  await alex.waitForFunction(() => document.querySelector('#o-h')?.textContent?.endsWith('· 8'))
  // Open questions never block approval (plan §4.6).
  await alex.getByRole('button', { name: 'Approve brief' }).click()
  await alex.getByText('Approved', { exact: true }).first().waitFor()
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

test('structure: move a page up, then remove a menu item', async () => {
  await createPage(alex, 'Order one')
  await createPage(alex, 'Order two')
  await alex.goto(`${APP}/p/qualiwarego/structure`)
  const nodes = alex.locator('.node b')
  await alex.getByRole('button', { name: /^Order two/ }).waitFor()
  const texts = async () => (await nodes.allTextContents()).filter((x) => x.startsWith('Order'))
  assert.deepEqual(await texts(), ['Order one', 'Order two'])
  await alex.getByRole('button', { name: /^Order two/ }).click()
  await alex.getByRole('button', { name: 'Move up' }).click()
  await alex.locator('.node b', { hasText: 'Order two' }).first().waitFor()
  for (let i = 0; i < 20 && (await texts())[0] !== 'Order two'; i++) await alex.waitForTimeout(100)
  assert.deepEqual(await texts(), ['Order two', 'Order one'])
  await alex.getByRole('button', { name: 'Add to main menu' }).click()
  await alex.getByText('Order two added to the Main menu.').waitFor()
  await alex.getByRole('button', { name: 'Remove Order two from the main menu' }).click()
  await alex.getByText('Order two removed from the main menu.').waitFor()
  await alex
    .getByRole('button', { name: 'Remove Order two from the main menu' })
    .waitFor({ state: 'detached' })
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

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('media: upload an image, write its alt text, archive it; axe is clean', async () => {
  await alex.goto(`${APP}/media`)
  await alex.getByRole('heading', { name: 'Media library' }).waitFor()
  await alex.getByRole('button', { name: 'This project' }).click()
  await alex.locator('#m-project').selectOption('qualiwarego')
  await alex
    .getByLabel('Upload files')
    .setInputFiles({ name: 'boat.png', mimeType: 'image/png', buffer: PIXEL })
  await alex.getByText('Uploaded boat.png.').waitFor()
  await alex.getByLabel('Alt text').fill('A small boat at sea')
  await alex.getByRole('button', { name: 'Save details' }).click()
  await alex.getByText('Saved.').waitFor()
  await alex.getByRole('button', { name: 'boat', exact: false }).first().waitFor()
  const axe = await new AxeBuilder({ page: alex })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  assert.deepEqual(
    axe.violations.map((v) => `media: ${v.id} ${v.nodes.map((n) => n.target).join(' | ')}`),
    [],
  )
  // A refused file says why and adds nothing.
  await alex
    .getByLabel('Upload files')
    .setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await alex.getByRole('alert').filter({ hasText: 'not a PNG, JPEG, WebP, GIF or SVG' }).waitFor()
  await alex.getByRole('button', { name: 'Archive', exact: true }).click()
  await alex.getByText('Archived. The file is kept.').waitFor()
  await alex.locator('.tile').waitFor({ state: 'detached' })
  // Nothing is removed: it shows again with "Show archived".
  await alex.getByLabel('Show archived').check()
  await alex.locator('.tile', { hasText: 'Archived' }).waitFor()
  // A Creator cannot upload to the organisation library.
  await alex.getByRole('button', { name: 'Organisation library' }).click()
  await alex.getByText('Only Admins change the organisation library').waitFor()
  assert.equal(await alex.getByLabel('Upload files').count(), 0)
})

test('brand and rules: an Admin builds 20% dark-green + white, saves version 2; axe is clean', async () => {
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
  const code = /Setup code for Admin adminb: (\S+)/.exec(stdout)?.[1]
  assert.ok(code, 'the server printed a setup code for adminb')
  await page.goto(`${APP}/sign-in`)
  await page.getByText('First time? Set up your passkey').click()
  await page.getByLabel('Admin user name').fill('adminb')
  await page.getByLabel('Setup code').fill(code)
  await page.getByRole('button', { name: 'Set up passkey' }).click()
  await page.waitForURL(`${APP}/projects`)

  const check = async (where: string) => {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    assert.deepEqual(
      result.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target).join(' | ')}`),
      [],
    )
  }

  await page.getByRole('link', { name: 'Brand and rules' }).click()
  await page.waitForURL(`${APP}/brand`)
  await page.getByRole('heading', { name: 'Brand and rules', level: 1 }).waitFor()
  const save = page.getByRole('button', { name: 'Save as version 2' })
  await save.waitFor()
  assert.equal(await save.isDisabled(), true, 'nothing to save yet')

  // The derived-colour builder: pick dark-green and white, drag to 20%.
  await page.getByLabel('Guide colour', { exact: true }).selectOption('dark-green')
  await page.getByLabel('Mixed with', { exact: true }).selectOption('white')
  await page.getByLabel(/Amount of the guide colour/).fill('20')
  assert.equal(await page.getByTestId('recipe').textContent(), '20% dark-green + white')
  assert.equal(await page.getByTestId('built-hex').textContent(), '#d3dfdc')
  await page.getByLabel('Used for').fill('hover')
  await page.getByRole('button', { name: 'Add derived colour' }).click()
  await page.getByText('Unsaved changes').waitFor()
  assert.equal(await save.isEnabled(), true)
  await check('brand and rules')

  await save.click()
  await page.getByText('Saved as version 2.').waitFor()
  await page.getByRole('button', { name: 'Save as version 3' }).waitFor()
  // It is in the next version, not in version 1.
  const v2 = (await (await page.request.get(`${APP}/api/brand/guide/v/2`)).json()) as {
    guide: { derived: { recipe: string; hex: string; use: string }[] }
  }
  assert.deepEqual(
    v2.guide.derived.find((d) => d.recipe === '20% dark-green + white'),
    { hex: '#d3dfdc', recipe: '20% dark-green + white', use: 'hover' },
  )
  const v1 = (await (await page.request.get(`${APP}/api/brand/guide/v/1`)).json()) as {
    guide: { derived: unknown[] }
  }
  assert.equal(v1.guide.derived.length, 1)
  await page.reload()
  await page.getByText('20% dark-green + white').first().waitFor()
  await page.getByRole('button', { name: /Go back to this version/ }).waitFor()

  await page.getByRole('link', { name: 'Brand assets' }).click()
  await page.waitForURL(`${APP}/brand/assets`)
  await page.getByRole('heading', { name: 'Header and footer' }).waitFor()
  await check('brand assets')

  // Checks (M6.8): a floor check is locked on Block; a non-floor one can be changed.
  await page.getByRole('link', { name: 'Admin panel' }).click()
  await page.waitForURL(`${APP}/admin/checks`)
  await page.getByRole('heading', { name: 'Checks', level: 1 }).waitFor()
  const floorRow = page.getByTestId('check-html')
  await floorRow.getByText('Locked on Block').waitFor()
  for (const level of ['Off', 'Warn', 'Block'])
    assert.equal(
      await floorRow.getByRole('button', { name: level, exact: true }).isDisabled(),
      true,
    )
  assert.equal(
    await floorRow.getByRole('button', { name: 'Block', exact: true }).getAttribute('aria-pressed'),
    'true',
  )
  const lowered = await call(page, 'PUT', '/api/admin/checks/html', { level: 'warn' })
  assert.equal(lowered.status, 409)
  assert.equal(lowered.body.code, 'cant-be-lowered')
  const seo = page.getByTestId('check-seo')
  await seo.getByRole('button', { name: 'Warn', exact: true }).click()
  await seo.getByText('is now on Warn').waitFor()
  await page.reload()
  await page
    .getByTestId('check-seo')
    .getByRole('button', { name: 'Warn', exact: true })
    .and(page.locator('[aria-pressed="true"]'))
    .waitFor()
  assert.equal(
    await page
      .getByTestId('check-html')
      .getByRole('button', { name: 'Block', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await check('admin checks')
  await context.close()
})

const axeClean = async (page: Page, where: string) => {
  // The preview frame is another origin and the page's own content, not this app's UI.
  const result = await new AxeBuilder({ page })
    .exclude('iframe')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  assert.deepEqual(
    result.violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target).join(' | ')}`),
    [],
  )
}
const PREVIEW = `http://127.0.0.1:${PORT + 1}/`
const takeReply = (html: string, summary: string) =>
  JSON.stringify({ html, css: 'body{margin:0}', summary, proposals: [] })

test('design: start a design from the spine; the overview shows the Lead in development 1/7', async () => {
  await alex.goto(`${APP}/p/qualiwarego/structure`)
  await alex
    .locator('.spine')
    .getByRole('link', { name: /Design/ })
    .click()
  await alex.waitForURL(`${APP}/p/qualiwarego/design`)
  const home = alex
    .locator('article')
    .filter({ has: alex.getByRole('heading', { name: 'Home', exact: true }) })
  await home.getByRole('button', { name: 'Start a design' }).click()
  await home
    .getByText('In development 1/7')
    .waitFor()
    .catch(async (e) => {
      console.log('DBG', await home.innerText())
      throw e
    })
  assert.equal(await home.locator('.chip', { hasText: /^Lead$/ }).count(), 1)
  // The same actions, in the same place, on every card: Open in editor is last.
  assert.equal(await home.locator('.card-f > *').last().textContent(), 'Open in editor')
  await axeClean(alex, 'design overview')
})

test('design editor: the canvas loads from the preview site and the labels come from the postMessage', async () => {
  await alex.goto(`${APP}/p/qualiwarego/design`)
  await alex.getByRole('link', { name: 'Open in editor' }).first().click()
  await alex.waitForURL(/\/p\/qualiwarego\/design\/\d+$/)
  const frame = alex.locator('.stage iframe')
  await frame.waitFor()
  assert.ok(((await frame.getAttribute('src')) ?? '').startsWith(`${PREVIEW}a/`))
  const label = alex.locator('.slabel')
  await label.first().waitFor()
  assert.match((await label.first().textContent()) ?? '', /Home/)
  assert.ok((await frame.evaluate((el) => el.getBoundingClientRect().height)) > 100)
  // Clicking a label selects the section and shows its checklist.
  await label.first().click()
  await alex.getByRole('group', { name: 'Checklist' }).waitFor()
  // The device switch sets the frame width.
  await alex.getByRole('button', { name: 'Mobile' }).click()
  await alex.waitForFunction(
    () => document.querySelector('.stage')?.getBoundingClientRect().width === 375,
  )
  await alex.getByRole('button', { name: 'Desktop' }).click()
  await alex.getByRole('button', { name: 'Hide labels' }).click()
  assert.equal(await alex.locator('.slabel').count(), 0)
  await alex.getByRole('button', { name: 'Show labels' }).click()
  await alex.locator('.slabel').first().waitFor()
  await axeClean(alex, 'design editor')
})

test('design editor: Think new is off after every generation', async () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="style.css"></head><body><section><h1 style="color:#ff0000">Bold</h1><p>Different</p></section></body></html>`
  nextReply = takeReply(html, 'A louder hero.')
  const think = alex.getByRole('switch', { name: 'Think new' })
  assert.equal(await think.getAttribute('aria-checked'), 'false', 'off by default')
  await alex.locator('.olist .orow').first().click()
  await think.click()
  assert.equal(await think.getAttribute('aria-checked'), 'true')
  await alex.getByLabel('What should change?').fill('Something much bolder')
  await alex.getByText(/About \d+ to \d+ tokens/).waitFor()
  await alex.getByRole('button', { name: 'Generate one take' }).click()
  await alex.getByText('A louder hero.').waitFor()
  assert.equal(await think.getAttribute('aria-checked'), 'false', 'switches itself off')
  // The decision bar: the consequence next to the primary action, bottom right.
  const bar = alex.getByRole('region', { name: 'Next decision' })
  await bar.getByText('Creates a new alternative').waitFor()
  assert.equal(await bar.locator('.acts > *').last().textContent(), 'Apply take')
  await alex.getByText('Deviations from the guide').waitFor()
  await bar.getByRole('button', { name: 'Discard' }).click()
  await alex.getByText('Take discarded. Nothing was changed.').waitFor()
})

test('design editor: an approved section is locked, and a take on it is refused when applied', async () => {
  const lead = Number(alex.url().split('/').pop())
  // The Mobile item needs a mobile variant of the page.
  await alex.evaluate(
    async ({ lead, id }) => {
      const me = (await (await fetch('/api/me')).json()) as { csrf: string }
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="style.css"></head><body><section><h1>Home</h1></section></body></html>`
      const r = await fetch(`/api/p/${id}/design/artboards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
        body: JSON.stringify({
          pageId: 'home',
          html,
          role: 'state',
          kind: 'mobile',
          parentId: lead,
        }),
      })
      if (!r.ok) throw new Error(`mobile variant: ${r.status}`)
    },
    { lead, id: 'qualiwarego' },
  )
  await alex.reload()
  await alex.locator('.olist .orow').nth(1).click()
  // Approving too early shows the server's refusal inline.
  await alex.getByRole('button', { name: 'Approve section' }).click()
  await alex.getByRole('alert').filter({ hasText: 'Tick all seven items' }).waitFor()
  for (const item of ['Copy', 'Media', 'Interactions', 'Mobile', 'Motion', 'Tested']) {
    await alex.getByRole('checkbox', { name: item }).check()
  }
  await alex.getByRole('button', { name: 'Approve section' }).click()
  await alex.getByRole('button', { name: 'Unlock section' }).waitFor()
  assert.equal(await alex.getByRole('checkbox', { name: 'Copy' }).isDisabled(), true)
  // A take on the approved section can be drafted, but not applied.
  nextReply = takeReply('<section><h2>Another hero</h2><p>Text</p></section>', 'A calmer hero.')
  await alex.getByLabel('What should change?').fill('Calmer')
  await alex.getByRole('button', { name: 'Generate one take' }).click()
  await alex.getByText('A calmer hero.').waitFor()
  const bar = alex.getByRole('region', { name: 'Next decision' })
  await bar.getByText('Updates this section').waitFor()
  await bar.getByRole('button', { name: 'Apply take' }).click()
  await alex.getByRole('alert').filter({ hasText: 'approved and locked' }).waitFor()
})

// ---- Review (M5 step 3) ----

type Call = { status: number; body: Record<string, unknown> }
const call = (page: Page, method: string, path: string, body?: unknown): Promise<Call> =>
  page.evaluate(
    async ({ method, path, body }) => {
      const me = (await (await fetch('/api/me')).json()) as { csrf: string }
      const r = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    },
    { method, path, body },
  )

const ITEMS = ['copy', 'media', 'interactions', 'mobile', 'motion', 'translated', 'tested']
const pageHtml = (t: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title><link rel="stylesheet" href="style.css"></head><body><section><h1>${t}</h1><p>Text</p></section></body></html>`
const saveRevision = async (page: Page, msg: string) => {
  const r = await call(page, 'POST', '/api/p/qualiwarego/draft/save', { msg })
  assert.equal(r.status < 300, true, `save revision: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.revision as string
}
const leadBoards = async (page: Page) => {
  const o = await call(page, 'GET', '/api/p/qualiwarego/design')
  return (
    o.body.pages as { id: string; title: string; artboards: { id: number; role: string }[] }[]
  ).map((p) => ({ page: p, lead: p.artboards.find((a) => a.role === 'lead') }))
}
const newestRevision = async (page: Page) =>
  ((await call(page, 'GET', '/api/p/qualiwarego/review')).body.revisions as { id: string }[])[0]
    ?.id as string

test('review: the shell loads from the preview origin, labels appear, Approve revision is disabled', async () => {
  // Start from an untouched Lead: unlock its section and switch every item off.
  for (const { lead } of await leadBoards(alex)) {
    if (!lead) continue
    const b = await call(alex, 'GET', `/api/p/qualiwarego/design/artboards/${lead.id}`)
    for (const sec of b.body.sections as { id: string; approved: unknown }[]) {
      const base = `/api/p/qualiwarego/design/sections/${lead.id}/${sec.id}`
      if (sec.approved) await call(alex, 'POST', `${base}/unlock`)
      for (const item of ITEMS) await call(alex, 'PUT', `${base}/check/${item}`, { on: false })
    }
  }
  const rev = await saveRevision(alex, 'Review me')
  await alex.goto(`${APP}/p/qualiwarego/review/${rev}`)
  const frame = alex.locator('.stage iframe')
  await frame.waitFor()
  assert.ok(((await frame.getAttribute('src')) ?? '').startsWith(`${PREVIEW}__review/`))
  await alex.locator('.slabel').first().waitFor()
  assert.match((await alex.locator('.slabel').first().textContent()) ?? '', /\S/)
  const approve = alex.getByRole('button', { name: 'Approve revision' })
  assert.equal(await approve.isDisabled(), true)
  await alex
    .getByRole('region', { name: 'Next decision' })
    .getByText(/Every section of every Lead must be approved first \(\d+ left\)/)
    .waitFor()
  // The context line carries the 12-character package hash.
  assert.match((await alex.getByTestId('context').textContent()) ?? '', /[0-9a-f]{12}/)
  // Device switch and page picker.
  await alex.getByRole('button', { name: 'Mobile' }).click()
  await alex.waitForFunction(
    () => document.querySelector('.stage')?.getBoundingClientRect().width === 375,
  )
  await alex.getByRole('button', { name: 'Desktop' }).click()
  assert.ok((await alex.locator('#pagepick option').count()) >= 1)
})

test('review: Suggest checkmarks shows "Looks ready" and ticks nothing', async () => {
  await alex.goto(`${APP}/p/qualiwarego/review/${await newestRevision(alex)}`)
  await alex.locator('.slabel').first().click()
  nextReply = JSON.stringify({
    suggestions: [{ item: 'copy', reason: 'The text is short and clear' }],
  })
  await alex.getByRole('button', { name: 'Suggest checkmarks' }).click()
  await alex.getByText('Looks ready: The text is short and clear').waitFor()
  // There is no way to apply a suggestion.
  assert.equal(await alex.getByRole('button', { name: /apply|tick all/i }).count(), 0)
  assert.equal(await alex.getByRole('checkbox', { name: 'Copy' }).isChecked(), false)
  for (const { lead } of await leadBoards(alex)) {
    if (!lead) continue
    const b = await call(alex, 'GET', `/api/p/qualiwarego/design/artboards/${lead.id}`)
    for (const sec of b.body.sections as { checklist: Record<string, boolean> }[])
      assert.deepEqual(
        // Translated is on by itself when the site has one language; the AI ticked nothing.
        Object.entries(sec.checklist)
          .filter(([item, on]) => on && item !== 'translated')
          .map(([item]) => item),
        [],
        'no checkmark is on after a suggestion',
      )
  }
})

test('review: spoofed messages from the shell frame change nothing', async () => {
  const rev = await newestRevision(alex)
  await alex.goto(`${APP}/p/qualiwarego/review/${rev}`)
  const labels = alex.locator('.slabel')
  await labels.first().waitFor()
  const before = await labels.count()
  await labels.first().click()
  const selected = alex.locator('.slabel[aria-pressed="true"]')
  assert.equal(await selected.count(), 1)
  const shellFrame = alex.frames().find((f) => f.url().includes('/__review/'))
  assert.ok(shellFrame, 'the shell frame is on the preview origin')
  await shellFrame.evaluate(() => {
    parent.postMessage({ type: 'approve' }, '*')
    parent.postMessage({ type: 'select', id: 's-zzzzzz' }, '*')
    parent.postMessage(
      {
        type: 'ss-review',
        page: 'index.html',
        boxes: [{ id: 's-zzzzzz', x: 0, y: 0, w: 10, h: 10 }],
        height: 100,
      },
      '*',
    )
    parent.postMessage({ type: 'ss-review', page: 5, boxes: 'x', height: 'tall' }, '*')
    parent.postMessage(
      {
        type: 'ss-review',
        page: 'index.html',
        boxes: [{ id: 'not-a-section', x: 'a' }],
        height: 100,
      },
      '*',
    )
  })
  await alex.waitForTimeout(500)
  assert.equal(await labels.count(), before, 'no unknown section appeared')
  assert.equal(await alex.locator('.slabel', { hasText: 's-zzzzzz' }).count(), 0)
  assert.equal(await selected.count(), 1, 'the selection did not move')
  const r = await call(alex, 'GET', `/api/p/qualiwarego/review/${rev}`)
  assert.equal(r.body.approval, null, 'the revision was not approved')
})

test('review: approve every section, save a revision, approve it and see the hash', async () => {
  for (const { page, lead: existing } of await leadBoards(alex)) {
    let lead = existing?.id
    if (!lead) {
      const made = await call(alex, 'POST', '/api/p/qualiwarego/design/artboards', {
        pageId: page.id,
        html: pageHtml(page.title),
        css: 'body{margin:0}',
      })
      assert.equal(made.status, 201)
      lead = made.body.id as number
    }
    const b = await call(alex, 'GET', `/api/p/qualiwarego/design/artboards/${lead}`)
    if (b.body.role !== 'lead')
      await call(alex, 'POST', `/api/p/qualiwarego/design/artboards/${lead}/role`, { role: 'lead' })
    // A mobile variant, so the Mobile item can be ticked.
    await call(alex, 'POST', '/api/p/qualiwarego/design/artboards', {
      pageId: page.id,
      html: pageHtml(page.title),
      role: 'state',
      kind: 'mobile',
      parentId: lead,
    })
    const fresh = await call(alex, 'GET', `/api/p/qualiwarego/design/artboards/${lead}`)
    for (const sec of fresh.body.sections as { id: string; approved: unknown }[]) {
      if (sec.approved) continue
      const base = `/api/p/qualiwarego/design/sections/${lead}/${sec.id}`
      for (const item of ITEMS) await call(alex, 'PUT', `${base}/check/${item}`, { on: true })
      const done = await call(alex, 'POST', `${base}/approve`)
      assert.equal(done.status, 200, `approve ${sec.id}: ${JSON.stringify(done.body)}`)
    }
  }
  const rev = await saveRevision(alex, 'All approved')
  await alex.goto(`${APP}/p/qualiwarego/review/${rev}`)
  const approve = alex.getByRole('button', { name: 'Approve revision' })
  await approve.waitFor()
  await alex.waitForFunction(
    () => !(document.querySelector('.decide .btn.primary') as HTMLButtonElement | null)?.disabled,
  )
  const hash = ((await alex.getByTestId('context').textContent()) ?? '').match(/[0-9a-f]{12}/)?.[0]
  assert.ok(hash)
  await alex
    .getByRole('region', { name: 'Next decision' })
    .getByText(`Records package ${hash}`)
    .waitFor()
  await approve.click()
  await alex.getByRole('status').filter({ hasText: 'Revision approved' }).waitFor()
  assert.equal(await alex.getByTestId('approved-hash').textContent(), hash)
  assert.equal(await approve.isDisabled(), true)
})

test('review: axe finds no WCAG A/AA violations on the Review screen', async () => {
  await alex.goto(`${APP}/p/qualiwarego/review/${await newestRevision(alex)}`)
  await alex.locator('.slabel').first().waitFor()
  await alex.locator('.slabel').first().click()
  await alex.getByRole('group', { name: 'Checklist' }).waitFor()
  await axeClean(alex, 'review')
})

test('staging: nothing is staged yet; Review shows the queued run; axe is clean', async () => {
  await alex.goto(`${APP}/p/qualiwarego/staging`)
  await alex.getByRole('heading', { name: 'Nothing is on staging yet' }).waitFor()
  assert.equal(await alex.getByRole('button', { name: 'Request publication' }).isDisabled(), true)
  await axeClean(alex, 'staging empty')
  await alex.goto(`${APP}/p/qualiwarego/review/${await newestRevision(alex)}`)
  await alex.getByTestId('run-status').getByText('Queued: waiting for the check runner.').waitFor()
})

test('staging: a clean worker result stages the revision; a second request supersedes the first', async () => {
  const runs = (await call(alex, 'GET', '/api/p/qualiwarego/checks/runs')).body.runs as {
    id: string
    kind: string
    hash: string
  }[]
  const run = runs.find((r) => r.kind === 'package')
  assert.ok(run, 'approval queued a check run')
  const job = JSON.parse(
    readFileSync(join(DATA, 'checks', 'pending', `${run.id}.json`), 'utf8'),
  ) as { kind: string; hash: string }
  mkdirSync(join(DATA, 'checks', 'results'), { recursive: true })
  writeFileSync(
    join(DATA, 'checks', 'results', `${run.id}.json`),
    JSON.stringify({
      id: run.id,
      kind: job.kind,
      hash: job.hash,
      startedAt: 'a',
      finishedAt: 'b',
      hashOk: true,
      checks: ['html', 'links', 'csp', 'inline-code', 'validators', 'svg', 'pinned', 'secrets'].map(
        (id) => ({ id, floor: true, level: 'block', status: 'pass', lowered: null, findings: [] }),
      ),
      blocked: false,
    }),
  )
  await alex.goto(`${APP}/p/qualiwarego/staging`)
  await alex.getByTestId('staged-rev').waitFor()
  assert.equal(await alex.getByTestId('staged-hash').textContent(), job.hash.slice(0, 12))
  assert.ok(
    ((await alex.locator('.frame iframe').getAttribute('src')) ?? '').startsWith(
      `${PREVIEW}staging/`,
    ),
  )
  await alex.getByText('All hard gates passed').waitFor()
  assert.match(
    (await alex.getByTestId('floor-checks').textContent()) ?? '',
    /HTML validitys*Passed/,
  )

  const send = alex.getByRole('button', { name: 'Request publication' })
  assert.equal(await send.isDisabled(), true, 'a note is needed')
  await alex.getByLabel('Note to the Admins').fill('<b>first</b> request')
  await send.click()
  await alex.getByText('Requested. Waiting for an Admin.').waitFor()
  await alex.getByLabel('Note to the Admins').fill('second request')
  await send.click()
  await alex.locator('.req[data-status="superseded"]').waitFor()
  const items = alex.getByTestId('requests').locator('.req')
  assert.equal(await items.count(), 2)
  assert.equal(
    await alex
      .locator('.req[data-status="open"]')
      .textContent()
      .then((t) => /second request/.test(t ?? '')),
    true,
  )
  const old = alex.locator('.req[data-status="superseded"] .notetext')
  assert.equal(await old.textContent(), '<b>first</b> request', 'the note is shown as text')
  assert.equal(await old.locator('b').count(), 0)
  await axeClean(alex, 'staging')
  await alex.goto(`${APP}/p/qualiwarego/review/${await newestRevision(alex)}`)
  await alex.getByTestId('run-status').getByRole('link', { name: 'Open staging' }).waitFor()
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
  await alex.locator('.blk').first().waitFor()
  await check(alex, 'brief')
  await alex.goto(`${APP}/p/qualiwarego/structure`)
  await alex.locator('.node').first().waitFor()
  await check(alex, 'structure')
  await alex.goto(`${APP}/p/qualiwarego/pages/new`)
  await alex.locator('.tcard').first().waitFor()
  await check(alex, 'new page')
  await alex.close()
})
