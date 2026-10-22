import type { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { passkeyRoutes } from '../auth/passkeys.ts'
import {
  clearedCookie,
  createSession,
  endSession,
  loadSession,
  readCookie,
  SESSION_COOKIE,
  type SessionUser,
  sameToken,
  sessionCookie,
} from '../auth/sessions.ts'
import { openDb } from '../db/index.ts'
import type { Endpoint } from '../llm/llm.ts'
import { addressRequestRoutes } from './address-requests.ts'
import { brandRoutes } from './brand.ts'
import { briefRoutes } from './brief.ts'
import { checksRoutes } from './checks.ts'
import { type DeployOptions, deployRoutes } from './deploy.ts'
import { designRoutes } from './design.ts'
import { failureRoutes } from './failures.ts'
import { governanceRoutes } from './governance.ts'
import { mailRoutes } from './mail.ts'
import { mediaRoutes } from './media.ts'
import { operationsRoutes } from './operations.ts'
import { projectRoutes } from './projects.ts'
import { releaseRoutes } from './release.ts'
import { reviewRoutes } from './review.ts'
import { structureRoutes } from './structure.ts'

// Origin is still checked on these; they are how a session starts.
const NO_SESSION = new Set([
  '/api/sign-in',
  '/api/passkey/setup/options',
  '/api/passkey/setup',
  '/api/passkey/sign-in/options',
  '/api/passkey/sign-in',
])
const CLIENT_DIST = join(import.meta.dir, '..', '..', 'client', 'dist')
// Run a real verify for unknown users too, so timing doesn't tell which handles exist.
const DUMMY_HASH = Bun.password.hashSync('dummy', {
  algorithm: 'argon2id',
  memoryCost: 4096,
  timeCost: 2,
})

export type AppOptions = {
  appUrl: URL
  instanceId: string
  clientDist?: string
  db?: Database
  dataDir?: string
  llmEndpoint?: Endpoint
  now?: () => number
  /** For signed artboard preview links (decision #45). Without them, no previews. */
  appSecret?: string
  previewUrl?: URL
  /** Deployment side (pairing, certificates, mail): overrides for tests and development. */
  deploy?: Partial<DeployOptions>
  /** Tests only. `localModelHosts`: Test connection may call localhost (the mock LLM). */
  testOnly?: { localModelHosts?: boolean }
}

type Env = { Variables: { user: SessionUser; sid: string; csrf: string } }

export function appCspFor(previewUrl?: URL): string {
  // The two shells, plus staging, which the Staging screen frames as the site will look (#47).
  const frames = previewUrl
    ? `${previewUrl.origin}/__review/ ${previewUrl.origin}/a/ ${previewUrl.origin}/staging/`
    : "'none'"
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${previewUrl ? ` ${previewUrl.origin}` : ''}`,
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frames}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}

export function createApp({
  appUrl,
  instanceId,
  clientDist = CLIENT_DIST,
  db = openDb(':memory:'),
  dataDir = mkdtempSync(join(tmpdir(), 'studio-data-')),
  now = Date.now,
  llmEndpoint,
  appSecret,
  previewUrl,
  deploy,
  testOnly,
}: AppOptions) {
  const app = new Hono<Env>()
  const appOrigin = appUrl.origin
  // serveStatic wants a path relative to the cwd
  const root = relative(process.cwd(), clientDist) || '.'

  // The app's own CSP (spike 3 must-do 1, decision #46): only our scripts, and it frames only
  // the two preview shells. Nothing may frame the app. Responses that set their own policy
  // (uploaded files, served with a sandbox) keep theirs.
  const appCsp = appCspFor(previewUrl)
  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('content-security-policy'))
      c.res.headers.set('content-security-policy', appCsp)
    c.res.headers.set('x-content-type-options', 'nosniff')
  })

  app.get('/api/health', (c) => c.json({ ok: true, instanceId }))

  // Every state-changing request: Origin first, then (except sign-in) session + CSRF.
  app.use('/api/*', async (c, next) => {
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD'
    if (!safe && c.req.header('origin') !== appOrigin) return c.json({ code: 'bad-origin' }, 403)
    if (NO_SESSION.has(c.req.path)) return next()
    const session = loadSession(db, readCookie(c.req.header('cookie'), SESSION_COOKIE), now())
    if (!session) return c.json({ code: 'no-session' }, safe ? 401 : 403)
    if (!safe) {
      const token = c.req.header('x-csrf-token')
      if (!token || !sameToken(token, session.csrf)) return c.json({ code: 'bad-csrf' }, 403)
    }
    c.set('user', session.user)
    c.set('sid', session.sid)
    c.set('csrf', session.csrf)
    return next()
  })

  app.post('/api/sign-in', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { handle?: unknown; password?: unknown }
    const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const user = db
      .query('select id, role, password_hash from users where handle = ?')
      .get(handle) as { id: number; role: string; password_hash: string | null } | null
    if (user?.role === 'admin') return c.json({ code: 'passkey-required' }, 403)
    const valid = await Bun.password.verify(password, user?.password_hash ?? DUMMY_HASH)
    if (!user || !valid) return c.json({ code: 'wrong-handle-or-password' }, 401)
    const s = createSession(db, user.id, now())
    c.header('set-cookie', sessionCookie(s.id))
    return c.json({ csrf: s.csrf })
  })

  passkeyRoutes(app as unknown as Hono, { db, appOrigin, rpId: appUrl.hostname, now })

  projectRoutes(app, { db, dataDir, instanceId })
  briefRoutes(app, { db, dataDir, instanceId }, llmEndpoint)
  structureRoutes(app, { db, dataDir, instanceId }, llmEndpoint)
  addressRequestRoutes(app, { db, dataDir, instanceId })
  mediaRoutes(app, { db, dataDir, instanceId })
  brandRoutes(app, { db, dataDir, instanceId })
  designRoutes(
    app,
    { db, dataDir, instanceId },
    appSecret && previewUrl ? { secret: appSecret, url: previewUrl } : undefined,
    llmEndpoint,
  )

  reviewRoutes(
    app,
    { db, dataDir, instanceId },
    llmEndpoint,
    appSecret && previewUrl ? { secret: appSecret, url: previewUrl } : undefined,
  )

  checksRoutes(
    app,
    { db, dataDir, instanceId },
    appSecret && previewUrl ? { secret: appSecret, url: previewUrl } : undefined,
    { appOrigin, rpId: appUrl.hostname, now },
  )
  releaseRoutes(
    app,
    { db, dataDir, instanceId },
    { appOrigin, rpId: appUrl.hostname, now },
    appSecret && previewUrl ? { secret: appSecret, url: previewUrl } : undefined,
  )
  governanceRoutes(app, { db, dataDir, instanceId }, { appOrigin, rpId: appUrl.hostname, now })

  deployRoutes(
    app,
    { db, dataDir, instanceId },
    { appUrl, webauthn: { appOrigin, rpId: appUrl.hostname, now }, ...deploy },
  )
  mailRoutes(app, { db, dataDir, instanceId }, { appOrigin, ...deploy?.mail })

  operationsRoutes(
    app,
    { db, dataDir, instanceId },
    {
      fallback: llmEndpoint,
      now,
      localModelHosts: testOnly?.localModelHosts === true,
    },
  )
  failureRoutes(
    app,
    { db, dataDir, instanceId },
    llmEndpoint,
    appSecret && previewUrl ? { secret: appSecret, url: previewUrl } : undefined,
  )

  app.post('/api/sign-out', (c) => {
    endSession(db, c.get('sid'))
    c.header('set-cookie', clearedCookie())
    return c.json({ ok: true })
  })

  app.get('/api/me', (c) => c.json({ user: c.get('user'), csrf: c.get('csrf') }))

  app.post('/api/me/language', async (c) => {
    const { language } = (await c.req.json().catch(() => ({}))) as { language?: unknown }
    if (language !== 'en' && language !== 'da') return c.json({ code: 'bad-language' }, 400)
    db.query('update users set language = ? where id = ?').run(language, c.get('user').id)
    return c.json({ ok: true })
  })

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))
  app.use('*', serveStatic({ root }))
  app.get('*', serveStatic({ root, path: 'index.html' }))
  return app
}
