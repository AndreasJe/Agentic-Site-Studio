// The preview (preview.internal; here http://127.0.0.1:<port>). Serves package bytes unchanged
// under /r/<rev>/ with the contract CSP as a header, and the review shell at /__review/<rev>/.
// It never sets a cookie.
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { packageFiles } from './revisions.ts'

const CONTRACT = join(import.meta.dir, '../../../contracts/csp.txt')
const SHELL = join(import.meta.dir, '../public/shell')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

/** The contract CSP for preview and staging (decision #38): framed by itself and the app. */
export function previewCsp(contract: string, appOrigin: string): string {
  const video = 'frame-src <approved video platform host>'
  const ancestors = "frame-ancestors 'none'"
  if (!contract.includes(video) || !contract.includes(ancestors))
    throw new Error('contracts/csp.txt no longer has the expected frame-src / frame-ancestors')
  return contract
    .trim()
    .replace(video, "frame-src 'none'")
    .replace(ancestors, `frame-ancestors 'self' ${appOrigin}`)
}

export type PreviewOptions = {
  port: number
  appOrigin: string
  /** rev -> package directory. */
  packages: Record<string, string>
  /** Off only for the second browser run (SameSite, Origin and CSRF on their own). */
  csp?: boolean
}

export function startPreview(opts: PreviewOptions) {
  const csp = previewCsp(readFileSync(CONTRACT, 'utf8'), opts.appOrigin)
  const files = new Map(Object.entries(opts.packages).map(([rev, dir]) => [rev, packageFiles(dir)]))
  const base = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
  const shellHeaders = {
    ...base,
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors ${opts.appOrigin}; base-uri 'none'; form-action 'none'`,
  }
  const notFound = () => new Response('Not found', { status: 404, headers: base })

  const shellPage = (rev: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="app-origin" content="${opts.appOrigin}">
<title>Review shell</title>
<link rel="stylesheet" href="/__review/shell.css">
<script type="module" src="/__review/shell.js"></script>
</head>
<body>
<div id="stage"><iframe id="site" title="Preview" data-src="/r/${rev}/index.html"></iframe><div id="overlays"></div></div>
</body>
</html>
`

  return Bun.serve({
    port: opts.port,
    fetch(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound()
      const path = new URL(req.url).pathname
      if (path === '/__review/shell.js' || path === '/__review/shell.css') {
        const name = path.slice('/__review/'.length)
        return new Response(Bun.file(join(SHELL, name)), {
          headers: { ...shellHeaders, 'content-type': TYPES[extname(name)] ?? 'text/plain' },
        })
      }
      const shell = /^\/__review\/([a-z0-9-]+)\/$/.exec(path)
      if (shell?.[1] && files.has(shell[1]))
        return new Response(shellPage(shell[1]), {
          headers: { ...shellHeaders, 'content-type': TYPES['.html'] as string },
        })
      const pkg = /^\/r\/([a-z0-9-]+)\/(.*)$/.exec(path)
      const rev = pkg?.[1] ? files.get(pkg[1]) : undefined
      if (!pkg || !rev) return notFound()
      let rel: string
      try {
        rel = decodeURIComponent(pkg[2] ?? '') || 'index.html'
      } catch {
        return notFound()
      }
      if (rel.endsWith('/')) rel += 'index.html'
      const abs = rev.get(rel) // only files that are in the package; no path is ever joined
      if (!abs) return notFound()
      return new Response(Bun.file(abs), {
        headers: {
          ...base,
          'content-type': TYPES[extname(rel)] ?? 'application/octet-stream',
          ...(opts.csp === false ? {} : { 'content-security-policy': csp }),
        },
      })
    },
  })
}
