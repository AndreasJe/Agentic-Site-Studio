import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getBlob } from '../store/blobs.ts'
import { projectDir } from '../store/revisions.ts'
import { verifyArtboardLink } from './artboard-link.ts'
import { verifyReviewLink } from './review-link.ts'

// The site CSP is a contract (rule 8). Decision #38: only the app may frame a preview;
// the frame-src placeholder becomes 'none' until an approved video host exists.
const contract = readFileSync(join(import.meta.dir, '../../../../contracts/csp.txt'), 'utf8').trim()

export function previewCsp(appUrl: URL): string {
  const csp = contract
    .replace('frame-src <approved video platform host>', "frame-src 'none'")
    .replace("frame-ancestors 'none'", `frame-ancestors 'self' ${appUrl.origin}`)
  if (/[<>]/.test(csp) || !csp.includes("frame-src 'none'") || !csp.includes(appUrl.origin)) {
    throw new Error('contracts/csp.txt changed shape; update server/preview/index.ts')
  }
  return csp
}

/** Without a secret and data folder (some tests) the preview serves nothing but 404s. */
export type PreviewOptions = { appUrl: URL; appSecret?: string; dataDir?: string }

const SHELL_JS = readFileSync(join(import.meta.dir, 'shell.js'))
const REVIEW_JS = readFileSync(join(import.meta.dir, 'review-shell.js'))
// Vendored from the axe-core package, served from this site like the shell (decision #46).
const AXE_JS = readFileSync(Bun.resolveSync('axe-core/axe.min.js', import.meta.dir))

// The review shell: ours, not generated. Its script sets the package frame's src. The sandbox
// lets the shell read the layout but lets the package run no script, so it can't read the
// signed path or post as the shell. When site scripts arrive this must be revisited.
const reviewPage = (appOrigin: string) =>
  `<!doctype html><html lang="en" data-app="${appOrigin}"><head><meta charset="utf-8"><title>Review</title><style>html,body{margin:0}iframe{display:block;width:100%;border:0}</style><script src="/__review/axe.js" defer></script><script src="/__review/shell.js" defer></script></head><body><iframe id="page" title="Page" sandbox="allow-same-origin"></iframe></body></html>`

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
}
const typeOf = (path: string) =>
  TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

type StoredPackage = { rev: string; hash: string; files: Record<string, string> }

// The shell page is ours, not generated: it frames the artboard as stored and loads shell.js.
// The sandbox keeps same-origin (shell.js reads the layout) but allows no scripts, forms or top
// navigation, so a link in an artboard can't take the app's tab away (review of M4). When
// artboard scripts arrive (§6.7) this must never become allow-scripts plus allow-same-origin.
const shellPage = (appOrigin: string) =>
  `<!doctype html><html lang="en" data-app="${appOrigin}"><head><meta charset="utf-8"><title>Preview</title><style>html,body{margin:0}iframe{display:block;width:100%;border:0}</style><script src="/_shell/shell.js" defer></script></head><body><iframe id="page" title="Page" src="index.html" sandbox="allow-same-origin"></iframe></body></html>`

// No cookies are ever set here, and there is deliberately no switch for the CSP.
export function createPreview({ appUrl, appSecret, dataDir }: PreviewOptions) {
  const csp = previewCsp(appUrl)
  // Only the shell page (our code, at exactly /a/<token>/) may frame: it frames the artboard on
  // this same origin. The artboard itself keeps the contract's frame-src.
  const shellCsp = csp.replace("frame-src 'none'", "frame-src 'self'")
  const isShell = (path: string) => /^\/(a|__review)\/[^/]+\/$/.test(path)
  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    c.res.headers.delete('set-cookie')
    c.res.headers.set('content-security-policy', isShell(c.req.path) ? shellCsp : csp)
    c.res.headers.set('x-content-type-options', 'nosniff')
    // The signed path must not travel to other sites in a Referer header.
    c.res.headers.set('referrer-policy', 'no-referrer')
  })

  app.get('/_shell/shell.js', (c) =>
    c.body(SHELL_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    }),
  )

  // Artboards (decision #45): /a/<signed>/ is the shell, index.html and style.css the stored
  // bytes. Nothing else under the path exists, so a link can't reach other blobs.
  if (appSecret && dataDir) {
    const serve = async (token: string, file: 'shell' | 'html' | 'css') => {
      const link = verifyArtboardLink(appSecret, token)
      if (!link) return null
      const headers = { 'cache-control': 'private, no-store' }
      if (file === 'shell')
        return new Response(shellPage(appUrl.origin), {
          headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
        })
      const hash = file === 'html' ? link.html : link.css
      if (!hash) return null
      const bytes = await getBlob(projectDir(dataDir, link.project), hash).catch(() => null)
      if (!bytes) return null
      const type = file === 'html' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8'
      // A fresh ArrayBuffer: the stored bytes go out exactly as they are.
      return new Response(new Uint8Array(bytes).buffer, {
        headers: { ...headers, 'content-type': type },
      })
    }
    app.get('/a/:token/', async (c) => (await serve(c.req.param('token'), 'shell')) ?? c.notFound())
    app.get(
      '/a/:token/index.html',
      async (c) => (await serve(c.req.param('token'), 'html')) ?? c.notFound(),
    )
    app.get(
      '/a/:token/style.css',
      async (c) => (await serve(c.req.param('token'), 'css')) ?? c.notFound(),
    )
  }

  app.get('/__review/shell.js', (c) =>
    c.body(REVIEW_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    }),
  )
  app.get('/__review/axe.js', (c) =>
    c.body(AXE_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'max-age=3600',
    }),
  )

  // Revisions (decision #46): /__review/<signed>/ is the shell, /r/<signed>/<path> the package
  // files exactly as stored. Only paths listed in the package exist; no file system path is used.
  if (appSecret && dataDir) {
    const packageOf = (token: string): { project: string; pkg: StoredPackage } | null => {
      const link = verifyReviewLink(appSecret, token)
      if (!link) return null
      const file = join(projectDir(dataDir, link.project), 'packages', `${link.rev}.json`)
      if (!existsSync(file)) return null
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as StoredPackage
      // The package on disk must be the one the app signed.
      if (pkg.hash !== link.hash || pkg.rev !== link.rev) return null
      return { project: link.project, pkg }
    }
    app.get('/__review/:token/', (c) => {
      if (!packageOf(c.req.param('token'))) return c.notFound()
      return new Response(reviewPage(appUrl.origin), {
        headers: {
          'cache-control': 'private, no-store',
          'content-type': 'text/html; charset=utf-8',
        },
      })
    })
    app.get('/r/:token/*', async (c) => {
      const token = c.req.param('token')
      const found = packageOf(token)
      if (!found) return c.notFound()
      let path: string
      try {
        path = decodeURIComponent(c.req.path.slice(`/r/${token}/`.length))
      } catch {
        return c.notFound()
      }
      if (path === '' || path.endsWith('/')) path += 'index.html'
      const hash = Object.hasOwn(found.pkg.files, path) ? found.pkg.files[path] : undefined
      if (!hash) return c.notFound()
      const bytes = await getBlob(projectDir(dataDir, found.project), hash).catch(() => null)
      if (!bytes) return c.notFound()
      return new Response(new Uint8Array(bytes).buffer, {
        headers: { 'cache-control': 'private, no-store', 'content-type': typeOf(path) },
      })
    })
  }
  app.all('*', (c) => c.notFound())
  return app
}
