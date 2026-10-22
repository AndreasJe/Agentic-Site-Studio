// M7 release in a real browser: an Admin sets up a passkey (Chrome's virtual authenticator over
// CDP, in installed Edge), and that passkey pairs production and signs a release. The review
// screen is not built yet (M7.8), so the release is driven through the API from the page, on the
// app's own origin: the challenge comes from the app, navigator.credentials.get signs its exact
// bytes, and the real production agent accepts it. Runs under Node: `bun run test:browser`.
import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, chromium, type Page } from 'playwright-core'

const PORT = 3181
const CONTROL = `http://127.0.0.1:${PORT + 2}`
const APP = `http://localhost:${PORT}`
const STUDIO = fileURLToPath(new URL('..', import.meta.url))
let server: ChildProcess
let browser: Browser
let stdout = ''
let signedIn: Page | undefined

function bunBinary(): string {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const exec = process.env.npm_execpath
  if (exec && /bun(\.exe)?$/i.test(exec)) return exec
  if (process.platform !== 'win32') return 'bun'
  return join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'bun', 'bin', 'bun.exe')
}

before(async () => {
  server = spawn(bunBinary(), ['test/helpers/release-server.ts', String(PORT), String(PORT + 2)], {
    cwd: STUDIO,
    env: { ...process.env },
  })
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.includes(`ready ${PORT}`)) resolve()
    })
    once(server, 'exit').then(([code]) => reject(new Error(`server exited ${code}`)))
  })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
})

after(async () => {
  await browser?.close()
  server?.kill()
  await new Promise((r) => setTimeout(r, 300))
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

const control = async (path: string, body?: unknown) => {
  const r = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const parsed = (await r.json()) as Record<string, unknown>
  assert.equal(r.status, 200, JSON.stringify(parsed))
  return parsed
}

/** In the page: a passkey assertion over a base64url challenge, returned base64url. */
const assertInPage = (page: Page, challenge: string, allow: string[]) =>
  page.evaluate(
    async ({ challenge, allow }) => {
      const b = (s: string) =>
        Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
      const e = (x: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(x)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '')
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: b(challenge),
          rpId: location.hostname,
          allowCredentials: allow.map((id) => ({ type: 'public-key' as const, id: b(id) })),
          userVerification: 'required',
        },
      })) as PublicKeyCredential
      const r = cred.response as AuthenticatorAssertionResponse
      return {
        rawId: e(cred.rawId),
        response: {
          authenticatorData: e(r.authenticatorData),
          clientDataJSON: e(r.clientDataJSON),
          signature: e(r.signature),
        },
      }
    },
    { challenge, allow },
  )

test('an Admin signs a release with a passkey and production accepts it', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  context.setDefaultTimeout(30_000)
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
  const codes = JSON.parse(/setup (\{.*\})/.exec(stdout)?.[1] ?? '{}') as Record<string, string>
  assert.ok(codes.admina, 'the server printed a setup code for admina')

  await page.goto(`${APP}/sign-in`)
  await page.getByText('First time? Set up your passkey').click()
  await page.getByLabel('Admin user name').fill('admina')
  await page.getByLabel('Setup code').fill(codes.admina)
  await page.getByRole('button', { name: 'Set up passkey' }).click()
  await page.waitForURL(`${APP}/projects`)

  // Pairing: the same passkey signs the genesis file; the "server" confirms the fingerprint.
  const start = (await control('/pair/start')) as { challenge: string; keyIds: string[] }
  const g = await assertInPage(page, start.challenge, start.keyIds)
  await control('/pair/finish', { keyId: g.rawId, ...g.response })

  const { requestId } = (await control('/stage')) as { requestId: number }

  // Waiting for you lists the request; the review screen signs it with the passkey, in the UI.
  await page.goto(`${APP}/admin`)
  await page.getByTestId('inbox-publication').waitFor()
  await axeClean(page, 'inbox')
  await page.getByRole('link', { name: 'Open review page' }).first().click()
  await page.waitForURL(`${APP}/admin/review/${requestId}`)
  await page.getByRole('heading', { name: /to production?/ }).waitFor()
  await page.getByText('0 of 1 approvals').waitFor()
  // Stored review images (decision #50): loaded from the preview origin, never the app, and
  // the app's CSP allows exactly that origin and nothing else for images.
  const shots = page.getByTestId('review-shots')
  await shots.waitFor()
  const imgs = await shots.locator('.shotrow img').evaluateAll((els) =>
    (els as HTMLImageElement[]).map((i) => ({
      src: i.src,
      ok: i.complete && i.naturalWidth > 0,
    })),
  )
  assert.equal(imgs.length, 3)
  for (const i of imgs) {
    assert.ok(i.ok, `image loaded: ${i.src}`)
    assert.ok(i.src.startsWith(`http://127.0.0.1:${PORT + 1}/shots/`), i.src)
  }
  await shots.getByRole('slider').fill('20')
  await axeClean(page, 'review')
  const challenge = page.waitForResponse(
    (r) => r.url().endsWith('/challenge') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Approve with passkey' }).click()
  const options = (await (await challenge).json()) as { publicKey: { challenge: string } }
  // Exactly the release challenge of #23: 40 bytes, ending in release number 1.
  const raw = Buffer.from(options.publicKey.challenge, 'base64url')
  assert.equal(raw.length, 40)
  assert.equal(raw.readBigUInt64BE(32), 1n)
  await page.getByText('Sent to production', { exact: true }).waitFor()
  await page.getByText('1 of 1 approvals').waitFor()

  const after = (await control('/scan')) as { active: number; highestRelease: number }
  assert.deepEqual(after, { active: 1, highestRelease: 1 })
  await page.reload()
  await page.getByText('Released to production', { exact: true }).first().waitFor()

  // Deployment: freeze (the app's signature), then unfreeze with the passkey.
  await page.goto(`${APP}/admin/deployment`)
  await page.getByTestId('target-production').waitFor()
  await axeClean(page, 'deployment')
  await page.getByRole('button', { name: 'Kill switch' }).click()
  await axeClean(page, 'kill switch')
  await page.getByRole('button', { name: 'Freeze production' }).click()
  await page.getByText(/Freeze command sent/).waitFor()
  await control('/scan')
  await page.getByRole('button', { name: 'Check again' }).click()
  await page.getByText('Production is frozen').waitFor()
  await page.getByRole('button', { name: 'Unfreeze with passkey' }).click()
  await page.getByText(/Unfreeze command sent/).waitFor()
  await control('/scan')
  await page.getByRole('button', { name: 'Check again' }).click()
  await page.getByText('Production is not frozen').waitFor()
  await page.getByRole('button', { name: 'Releases' }).click()
  await axeClean(page, 'releases')
  await page.getByRole('button', { name: 'Certificates' }).click()
  await axeClean(page, 'certificates')
  await page.getByRole('button', { name: 'Sites and hostnames' }).click()
  await axeClean(page, 'sites')

  // Governance shows the current rule; the other Admin screens are accessible.
  await page.goto(`${APP}/admin/governance`)
  await page.getByTestId('current-rule').getByText('releases 1 · keys 1 · domains 1').waitFor()
  await axeClean(page, 'governance')
  for (const [path, heading] of [
    ['users', 'Users and keys'],
    ['mail', 'Notifications and mail'],
    ['languages', 'Languages'],
  ] as const) {
    await page.goto(`${APP}/admin/${path}`)
    await page.getByRole('heading', { name: heading, level: 1 }).waitFor()
    await axeClean(page, path)
  }

  const review = await page.evaluate(async (id) => {
    return (await (await fetch(`/api/admin/review/${id}`)).json()) as {
      request: { status: string }
      signing: { status: string; outcome: string }
    }
  }, requestId)
  assert.equal(review.request.status, 'published')
  assert.equal(review.signing.status, 'accepted')
  signedIn = page
})

/** True once the app has the maintenance route (agent A's work); until then the test is skipped. */
const hasMaintenanceRoute = () => {
  const dir = join(STUDIO, 'server')
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : [],
    )
  return walk(dir).some((f) => /['"`/]maintenance['"`]/.test(readFileSync(f, 'utf8')))
}

test('maintenance page: an Admin shows and ends it with a passkey, and the heartbeat says so', {
  skip: hasMaintenanceRoute()
    ? false
    : 'skipped: POST /api/admin/commands/:target/maintenance is not in the app yet (agent A)',
}, async () => {
  const page = signedIn
  assert.ok(page, 'the release test signed in first')
  await page.goto(`${APP}/admin/deployment`)
  await page.getByTestId('target-production').waitFor()
  await page.getByRole('button', { name: 'Kill switch' }).click()
  await page.getByText('Maintenance page is not showing').waitFor()
  await axeClean(page, 'maintenance')
  await page.getByRole('button', { name: 'Show maintenance page' }).click()
  await page.getByText(/Maintenance command sent/).waitFor()
  await control('/scan')
  await page.getByRole('button', { name: 'Check again' }).click()
  await page.getByText('Maintenance page is showing').waitFor()
  await page.getByRole('button', { name: 'End maintenance' }).click()
  await page.getByText(/End-of-maintenance command sent/).waitFor()
  await control('/scan')
  await page.getByRole('button', { name: 'Check again' }).click()
  await page.getByText('Maintenance page is not showing').waitFor()
  await axeClean(page, 'maintenance ended')
  await page.context().close()
})
