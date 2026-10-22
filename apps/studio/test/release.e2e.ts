// M7 release in a real browser: an Admin sets up a passkey (Chrome's virtual authenticator over
// CDP, in installed Edge), and that passkey pairs production and signs a release. The review
// screen is not built yet (M7.8), so the release is driven through the API from the page, on the
// app's own origin: the challenge comes from the app, navigator.credentials.get signs its exact
// bytes, and the real production agent accepts it. Runs under Node: `bun run test:browser`.
import assert from 'node:assert/strict'
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright-core'

const PORT = 3161
const CONTROL = `http://127.0.0.1:${PORT + 2}`
const APP = `http://localhost:${PORT}`
const STUDIO = fileURLToPath(new URL('..', import.meta.url))
let server: ChildProcess
let browser: Browser
let stdout = ''

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
  context.setDefaultTimeout(10_000)
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

  // The release, from the page: the app's challenge, the browser's passkey, the app's checks.
  const signed = await page.evaluate(async (id) => {
    const me = (await (await fetch('/api/me')).json()) as { csrf: string }
    const post = async (path: string, body?: unknown) => {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
        body: JSON.stringify(body ?? {}),
      })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    }
    const ch = await post(`/api/admin/review/${id}/challenge`)
    return { me, ch }
  }, requestId)
  assert.equal(signed.ch.status, 200, JSON.stringify(signed.ch.body))
  const options = signed.ch.body.publicKey as {
    challenge: string
    allowCredentials: { id: string }[]
  }
  // Exactly the release challenge of #23: 40 bytes, ending in release number 1.
  const raw = Buffer.from(options.challenge, 'base64url')
  assert.equal(raw.length, 40)
  assert.equal(raw.readBigUInt64BE(32), 1n)
  const assertion = await assertInPage(
    page,
    options.challenge,
    options.allowCredentials.map((c) => c.id),
  )
  const sent = await page.evaluate(
    async ({ id, assertion, csrf }) => {
      const r = await fetch(`/api/admin/review/${id}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify(assertion),
      })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    },
    { id: requestId, assertion, csrf: signed.me.csrf },
  )
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.equal(sent.body.sent, true)

  const after = (await control('/scan')) as { active: number; highestRelease: number }
  assert.deepEqual(after, { active: 1, highestRelease: 1 })
  const review = await page.evaluate(async (id) => {
    return (await (await fetch(`/api/admin/review/${id}`)).json()) as {
      request: { status: string }
      signing: { status: string; outcome: string }
    }
  }, requestId)
  assert.equal(review.request.status, 'published')
  assert.equal(review.signing.status, 'accepted')
  await context.close()
})
