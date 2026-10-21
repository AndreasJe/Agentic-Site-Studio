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
import { brandRoutes } from './brand.ts'
import { briefRoutes } from './brief.ts'
import { mediaRoutes } from './media.ts'
import { projectRoutes } from './projects.ts'
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
}

type Env = { Variables: { user: SessionUser; sid: string; csrf: string } }

export function createApp({
  appUrl,
  instanceId,
  clientDist = CLIENT_DIST,
  db = openDb(':memory:'),
  dataDir = mkdtempSync(join(tmpdir(), 'studio-data-')),
  now = Date.now,
  llmEndpoint,
}: AppOptions) {
  const app = new Hono<Env>()
  const appOrigin = appUrl.origin
  // serveStatic wants a path relative to the cwd
  const root = relative(process.cwd(), clientDist) || '.'

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
  mediaRoutes(app, { db, dataDir, instanceId })
  brandRoutes(app, { db, dataDir, instanceId })

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
