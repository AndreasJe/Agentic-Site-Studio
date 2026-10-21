// The smoke test (plan 13.5, section 3): after staging, every page answers, the security headers
// are present, there are no console errors, and the page makes no requests to other origins.
import { pages } from './package.js'

export async function smokeCheck({ browser, root, job }) {
  if (!job.smokeUrl)
    return { findings: [{ message: 'The smoke job has no smokeUrl.', rule: 'no-url' }] }
  const base = new URL(job.smokeUrl.endsWith('/') ? job.smokeUrl : `${job.smokeUrl}/`)
  const findings = []
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(20000)
  for (const page of pages(root)) {
    const url = new URL(page, base)
    const add = (rule, message) => findings.push({ message, file: page, rule })
    const p = await ctx.newPage()
    p.on('console', (m) => {
      if (m.type() !== 'error' || m.location().url.endsWith('/favicon.ico')) return
      add('console-error', `Console error: ${m.text().slice(0, 200)}`)
    })
    p.on('pageerror', (e) => add('console-error', `Page error: ${String(e).slice(0, 200)}`))
    p.on('request', (r) => {
      const u = new URL(r.url())
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return
      if (u.origin !== base.origin) add('outside-request', `Request to another origin: ${u.origin}`)
    })
    try {
      const res = await p.goto(url.href, { waitUntil: 'load' })
      if (res?.status() !== 200) add('status', `The page answered ${res?.status() ?? 'nothing'}.`)
      else if (!res?.headers()['content-security-policy'])
        add('no-csp-header', 'The response has no Content-Security-Policy header.')
      await p.waitForTimeout(200)
    } catch (e) {
      add('unreachable', `The page could not be loaded: ${String(e.message).split('\n')[0]}`)
    }
    await p.close()
  }
  await ctx.close()
  return { findings }
}
