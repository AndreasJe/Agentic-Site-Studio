// The smoke test after every switch (plan §13.5 step 5): every page in the release answers 200
// with the security headers and the exact package bytes (rule 7). It goes through the running
// server's own handler in this process, so it opens no socket.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { equalBytes } from '@site-studio/shared/bytes'
import { type SiteServer, securityHeaders } from './server.ts'

export type PageResult = { url: string; file: string; status: number; problems: string[] }
export type SmokeResult = { passed: boolean; pages: PageResult[] }

/** The address a visitor uses for a page file. */
export function pageUrl(prefix: string, file: string): string {
  if (file === 'index.html') return `${prefix}/`
  if (file.endsWith('/index.html')) return `${prefix}/${file.slice(0, -'index.html'.length)}`
  return `${prefix}/${file}`
}

export async function smokeTest(
  server: SiteServer,
  dir: string,
  files: Set<string>,
  opts: { prefix: string; csp: string },
): Promise<SmokeResult> {
  const expected = securityHeaders(opts.csp)
  // The home page always, whether or not the package has one: a site without it is broken.
  const pages = new Set(['index.html', ...[...files].filter((f) => f.endsWith('.html'))])
  const results: PageResult[] = []
  for (const file of [...pages].sort()) {
    const url = pageUrl(opts.prefix, file)
    const problems: string[] = []
    let status = 0
    try {
      const res = await server.request(url)
      status = res.status
      if (status !== 200) problems.push(`status ${status}`)
      for (const [name, value] of Object.entries(expected)) {
        const got = res.headers.get(name)
        if (got === null) problems.push(`missing ${name}`)
        else if (got !== value) problems.push(`wrong ${name}`)
      }
      if (res.headers.has('set-cookie')) problems.push('sets a cookie')
      if (status === 200) {
        if (!res.headers.get('content-type')?.startsWith('text/html')) {
          problems.push('not served as HTML')
        }
        const body = new Uint8Array(await res.arrayBuffer())
        if (!files.has(file) || !equalBytes(body, new Uint8Array(readFileSync(join(dir, file))))) {
          problems.push('bytes differ from the package')
        }
      }
    } catch (err) {
      problems.push(`error: ${(err as Error).message}`)
    }
    results.push({ url, file, status, problems })
  }
  return { passed: results.every((r) => r.problems.length === 0), pages: results }
}
