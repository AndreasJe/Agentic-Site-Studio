import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'

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

export type PreviewOptions = { appUrl: URL }

// No cookies are ever set here, and there is deliberately no switch for the CSP.
export function createPreview({ appUrl }: PreviewOptions) {
  const csp = previewCsp(appUrl)
  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    c.res.headers.delete('set-cookie')
    c.res.headers.set('content-security-policy', csp)
  })

  // Revisions do not exist yet, so nothing matches.
  app.get('/r/:rev/*', (c) => c.notFound())
  app.all('*', (c) => c.notFound())
  return app
}
