import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getBlob } from '../store/blobs.ts'
import { projectDir } from '../store/revisions.ts'
import { verifyArtboardLink } from './artboard-link.ts'

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

// The shell page is ours, not generated: it frames the artboard as stored and loads shell.js.
const shellPage = (appOrigin: string) =>
  `<!doctype html><html lang="en" data-app="${appOrigin}"><head><meta charset="utf-8"><title>Preview</title><style>html,body{margin:0}iframe{display:block;width:100%;border:0}</style><script src="/_shell/shell.js" defer></script></head><body><iframe id="page" title="Page" src="index.html"></iframe></body></html>`

// No cookies are ever set here, and there is deliberately no switch for the CSP.
export function createPreview({ appUrl, appSecret, dataDir }: PreviewOptions) {
  const csp = previewCsp(appUrl)
  // Only the shell page (our code, at exactly /a/<token>/) may frame: it frames the artboard on
  // this same origin. The artboard itself keeps the contract's frame-src.
  const shellCsp = csp.replace("frame-src 'none'", "frame-src 'self'")
  const isShell = (path: string) => /^\/a\/[^/]+\/$/.test(path)
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

  // Revisions do not exist yet, so nothing matches.
  app.get('/r/:rev/*', (c) => c.notFound())
  app.all('*', (c) => c.notFound())
  return app
}
