// Runs all checks on one package job. Node, playwright-core, installed Edge.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import * as C from './checks.js'
import { edgeProcesses, sampler } from './memory.js'
import { servePackage } from './server.js'
import { resolveSettings } from './settings.js'

const BROWSER_CHECKS = new Set(['csp', 'axe', 'heavy-profile', 'screenshots'])

const IMPL = {
  html: C.htmlCheck,
  links: C.linksCheck,
  'inline-code': C.inlineCodeCheck,
  csp: C.cspCheck,
  axe: C.axeCheck,
  'heavy-profile': C.heavyProfileCheck,
  screenshots: C.screenshotsCheck,
  performance: C.performanceCheck,
}

const pick = (s) => ({
  configured: s.configured,
  effective: s.effective,
  ...(s.note ? { note: s.note } : {}),
})
const mb = (b) => Math.round(b / 1048576)

export async function runJob(job) {
  const resolved = resolveSettings(job.settings)
  const outDir = job.outDir ?? mkdtempSync(join(tmpdir(), 'check-out-'))
  const before = new Set((await edgeProcesses()).keys())
  const server = await servePackage(job.packageDir)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const checks = {}
  try {
    for (const [id, setting] of Object.entries(resolved)) {
      if (setting.effective === 'off') {
        checks[id] = { status: 'skipped', outcome: 'off', ...pick(setting) }
        continue
      }
      if (process.env.DEBUG_CHECKS) console.error('check', id)
      const mem = sampler(before)
      await mem.sample()
      const timer = setInterval(() => mem.sample(), 500)
      const t0 = Date.now()
      let r
      try {
        r = await IMPL[id]({
          root: job.packageDir,
          baseUrl: server.url,
          browser: BROWSER_CHECKS.has(id) ? browser : undefined,
          outDir,
          tag: job.tag,
        })
      } catch (e) {
        r = { status: 'fail', findings: [{ rule: 'check-crashed', msg: String(e) }] }
      }
      clearInterval(timer)
      await mem.sample()
      let outcome = r.status
      if (r.status === 'fail') outcome = setting.effective === 'block' ? 'block' : 'warn'
      else if (r.status === 'pass') outcome = 'ok'
      checks[id] = {
        ...r,
        outcome,
        ...pick(setting),
        ms: Date.now() - t0,
        peakRssMB: { worker: mb(mem.peak.worker), browser: mb(mem.peak.browser) },
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  const blocked = Object.entries(checks)
    .filter(([, c]) => c.outcome === 'block')
    .map(([id]) => id)
  return { id: job.id, passed: blocked.length === 0, blocked, checks }
}
