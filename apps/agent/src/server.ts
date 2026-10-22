// The production web server: serves the active release's files, listed paths only, with the
// contract CSP (rule 8, contracts/csp.txt) and the security headers on every response. It sets
// no cookies and runs nothing from the package. Production keeps frame-ancestors 'none' (#38).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Server } from 'bun'

const CONTRACT = readFileSync(join(import.meta.dir, '../../../contracts/csp.txt'), 'utf8').trim()

/** The contract CSP with frame-src filled in: the one approved video host, or 'none'. */
export function siteCsp(frameSrc: string | null): string {
  const csp = CONTRACT.replace(
    'frame-src <approved video platform host>',
    `frame-src ${frameSrc ?? "'none'"}`,
  )
  if (/[<>]/.test(csp) || !csp.endsWith("frame-ancestors 'none'")) {
    throw new Error('contracts/csp.txt changed shape; update apps/agent/src/server.ts')
  }
  return csp
}

/** Every response carries these (plan §21.1: CSP, HSTS, Referrer-Policy, Permissions-Policy). */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    'content-security-policy': csp,
    'strict-transport-security': 'max-age=31536000',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  }
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  glb: 'model/gltf-binary',
  pdf: 'application/pdf',
}
export const typeOf = (path: string) =>
  TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** Regular files under `dir`, as forward-slash paths. Links and anything odd are not listed. */
export function listFiles(dir: string): Set<string> {
  const out = new Set<string>()
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue
    out.add(relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
  }
  return out
}

export type ServerOptions = {
  hostname: string
  port: number
  /** '' or '/path' for a site under a path (plan §13.11). */
  prefix: string
  csp: string
  /** Tests only: a header to leave out, read per response, to see the smoke test catch it. */
  faults?: { dropHeader?: string }
}

export type Tls = { cert: string; key: string }

/**
 * The built-in maintenance page (decision #50): one small HTML file with an inline style only, so
 * it needs nothing from the release, no external asset and no script, and fits the site CSP.
 */
export const MAINTENANCE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Down for maintenance</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#ffffff;color:#1f2a3d}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin:0 0 .75rem}
p{margin:0;line-height:1.5}
</style>
</head>
<body>
<main>
<h1>Down for maintenance</h1>
<p>This site is being worked on. Please come back a little later.</p>
</main>
</body>
</html>
`

/** Seconds a visitor's browser or a crawler is asked to wait while the maintenance page is on. */
export const MAINTENANCE_RETRY_AFTER = '300'

export class SiteServer {
  private server: Server<undefined> | null = null
  private dir: string | null = null
  /** On: every request answers 503 with MAINTENANCE_PAGE (decision #50). */
  maintenance = false
  private files = new Set<string>()
  private tls: Tls | null = null
  private readonly headers: Record<string, string>

  constructor(private readonly opts: ServerOptions) {
    this.headers = securityHeaders(opts.csp)
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  get secure(): boolean {
    return this.tls !== null
  }

  /** The paths being served now. */
  get listed(): Set<string> {
    return this.files
  }

  /** What to serve from now on: a release folder, or nothing. */
  serve(dir: string | null) {
    this.dir = dir
    this.files = dir ? listFiles(dir) : new Set()
  }

  start(tls: Tls | null = this.tls) {
    this.stop()
    this.tls = tls
    this.server = Bun.serve({
      hostname: this.opts.hostname,
      port: this.opts.port,
      ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
      fetch: (req) => this.handle(req),
    })
  }

  stop() {
    this.server?.stop(true)
    this.server = null
  }

  /**
   * One request through the running server's own release handler, in this process: no socket is
   * opened (the smoke test uses this; the agent never makes a client connection).
   */
  async request(path: string): Promise<Response> {
    if (!this.server) throw new Error('server is not running')
    const base = `${this.tls ? 'https' : 'http'}://${this.opts.hostname}:${this.port}`
    // The release itself, past the maintenance page: a release sent while it is on is tested too.
    return this.handleSite(new Request(new URL(path, base)))
  }

  private reply(status: number, body: BodyInit | null, extra: Record<string, string> = {}) {
    const headers = { ...this.headers, ...extra }
    const drop = this.opts.faults?.dropHeader
    if (drop) delete headers[drop]
    return new Response(body, { status, headers })
  }

  /** What a visitor gets: the maintenance page while it is on, else the release. */
  handle(req: Request): Response {
    if (this.maintenance) {
      return this.reply(503, req.method === 'HEAD' ? null : MAINTENANCE_PAGE, {
        'content-type': 'text/html; charset=utf-8',
        'retry-after': MAINTENANCE_RETRY_AFTER,
        'cache-control': 'no-store',
      })
    }
    return this.handleSite(req)
  }

  private handleSite(req: Request): Response {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return this.reply(405, 'Method not allowed', { allow: 'GET, HEAD' })
    }
    if (!this.dir) return this.reply(503, 'No release is active', { 'retry-after': '60' })
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url).pathname)
    } catch {
      return this.reply(400, 'Bad request')
    }
    const { prefix } = this.opts
    if (prefix) {
      if (path === prefix) return this.reply(301, null, { location: `${prefix}/` })
      if (!path.startsWith(`${prefix}/`)) return this.notFound()
      path = path.slice(prefix.length)
    }
    let rel = path.slice(1)
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'
    // Only paths the release lists: nothing outside it can be named, whatever the URL says.
    if (!this.files.has(rel)) {
      if (this.files.has(`${rel}/index.html`)) {
        return this.reply(301, null, { location: `${prefix}${path}/` })
      }
      return this.notFound()
    }
    const body = req.method === 'HEAD' ? null : Bun.file(join(this.dir, rel))
    return this.reply(200, body, { 'content-type': typeOf(rel) })
  }

  private notFound() {
    if (this.dir && this.files.has('404.html')) {
      return this.reply(404, Bun.file(join(this.dir, '404.html')), {
        'content-type': typeOf('404.html'),
      })
    }
    return this.reply(404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' })
  }
}
