// The app (studio.internal; here http://localhost:<port>). Session cookie, Origin + CSRF on
// every POST, frame-ancestors 'none', and a review page that frames the preview's shell.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkRequest, readCookie, SESSION_COOKIE, type Session } from './guard.ts'

export type AppRevision = { sections: string[]; hash: string }
export type LogEntry = Record<string, unknown>
export type AppOptions = {
  port: number
  appOrigin: string
  previewOrigin: string
  revisions: Record<string, AppRevision>
  log?: (entry: LogEntry) => void
}

const PUBLIC = join(import.meta.dir, '../public/app')

export function appCsp(previewOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    `frame-src ${previewOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}

export function startApp(opts: AppOptions) {
  const sessions = new Map<string, Session>()
  const approved = new Map<string, Set<string>>()
  const headers = {
    'content-security-policy': appCsp(opts.previewOrigin),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, 'content-type': 'application/json', ...extra },
    })
  const file = (name: string, type: string) =>
    new Response(Bun.file(join(PUBLIC, name)), { headers: { ...headers, 'content-type': type } })
  const messageJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    readFileSync(join(import.meta.dir, 'message.ts'), 'utf8'),
  )
  const randomToken = () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

  const sessionOf = (req: Request) => {
    const sid = readCookie(req.headers.get('cookie'), SESSION_COOKIE)
    return sid === undefined ? undefined : sessions.get(sid)
  }
  const revisionView = (rev: string) => {
    const r = opts.revisions[rev]
    if (!r) return undefined
    return {
      rev,
      ...r,
      previewOrigin: opts.previewOrigin,
      approved: [...(approved.get(rev) ?? [])],
    }
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    const path = url.pathname
    if (req.method === 'GET') {
      if (/^\/review\/[a-z0-9-]+$/.test(path))
        return file('review.html', 'text/html; charset=utf-8')
      if (path === '/review.js') return file('review.js', 'text/javascript')
      if (path === '/review.css') return file('review.css', 'text/css')
      if (path === '/message.js')
        return new Response(messageJs, {
          headers: { ...headers, 'content-type': 'text/javascript' },
        })
      const session = sessionOf(req)
      if (path === '/api/session') return session ? json({ csrf: session.csrf }) : json({}, 401)
      if (path === '/api/revision') {
        if (!session) return json({ error: 'no-session' }, 401)
        const view = revisionView(url.searchParams.get('rev') ?? '')
        return view ? json(view) : json({ error: 'unknown-revision' }, 404)
      }
      return json({ error: 'not-found' }, 404)
    }
    if (req.method !== 'POST') return json({ error: 'method' }, 405)

    const signIn = path === '/api/sign-in'
    const verdict = checkRequest(req, {
      appOrigin: opts.appOrigin,
      sessions,
      requireSession: !signIn,
    })
    if (!verdict.ok) return json({ error: verdict.reason }, verdict.status)

    if (signIn) {
      const sid = randomToken()
      const csrf = randomToken()
      sessions.set(sid, { csrf })
      return json({ csrf }, 200, {
        'set-cookie': `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      })
    }
    if (path === '/api/approve') {
      const body = (await req.json().catch(() => null)) as {
        rev?: unknown
        section?: unknown
      } | null
      const rev = typeof body?.rev === 'string' ? body.rev : ''
      const section = typeof body?.section === 'string' ? body.section : ''
      if (!opts.revisions[rev]?.sections.includes(section))
        return json({ error: 'unknown-section' }, 400)
      const set = approved.get(rev) ?? new Set<string>()
      set.add(section)
      approved.set(rev, set)
      return json(revisionView(rev))
    }
    return json({ error: 'not-found' }, 404)
  }

  return Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url)
      const res = await handle(req, url)
      opts.log?.({
        method: req.method,
        path: url.pathname,
        status: res.status,
        origin: req.headers.get('origin'),
        site: req.headers.get('sec-fetch-site'),
        dest: req.headers.get('sec-fetch-dest'),
        cookie: readCookie(req.headers.get('cookie'), SESSION_COOKIE) !== undefined,
      })
      return res
    },
  })
}
