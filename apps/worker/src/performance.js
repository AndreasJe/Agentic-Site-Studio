// The speed check (plan 8.1): Lighthouse, run from Node against the worker's package server (which
// sends the contract CSP), using the installed Edge. sitespeed.io is not used.
// Advisory: its level comes from settings (default Block), it never touches the security floor.
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import { pages } from './package.js'

// "Good" thresholds. Plan 8.1 says "good" without numbers, so these are the published Core Web
// Vitals "good" limits (https://web.dev/articles/vitals): LCP <= 2.5 s, CLS <= 0.1, with Total
// Blocking Time <= 200 ms as the lab stand-in for INP (Lighthouse's "good" TBT band) and the
// Lighthouse performance score >= 90 ("good" band). Override per job with job.budgets.
export const DEFAULT_BUDGETS = { lcpMs: 2500, cls: 0.1, tbtMs: 200, score: 90 }
const MAX_PAGES = 3

export function edgePath() {
  const fromEnv = process.env.EDGE_PATH || process.env.CHROME_PATH
  if (fromEnv) return fromEnv // an explicit path is used as given; a bad one fails to launch (not-run)
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ].filter(Boolean)
  for (const r of roots) {
    const p = join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (existsSync(p)) return p
  }
  for (const p of [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/msedge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ])
    if (existsSync(p)) return p
  return null
}

/** index.html plus one page per page type (job.pageTypes: [{ name, page }]), else up to two more. */
export function pickPages(root, job) {
  const all = pages(root)
  const chosen = ['index.html'].filter((p) => all.includes(p))
  const types = Array.isArray(job.pageTypes) ? job.pageTypes : null
  if (types?.length) {
    for (const t of types) {
      const p = typeof t === 'string' ? t : t?.page
      if (p && all.includes(p) && !chosen.includes(p)) chosen.push(p)
    }
  } else {
    for (const p of all) if (chosen.length < MAX_PAGES && !chosen.includes(p)) chosen.push(p)
  }
  return chosen.length ? chosen : all.slice(0, 1)
}

// Edge does not report a dynamic debugging port to chrome-launcher on Windows, so give it a free one.
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const round = (n, d = 0) => Number(n.toFixed(d))

export async function performanceCheck({ baseUrl, root, job }) {
  const budgets = { ...DEFAULT_BUDGETS, ...(job.budgets ?? {}) }
  const chromePath = edgePath()
  if (!chromePath || !existsSync(chromePath))
    return notRun(`Edge was not found${chromePath ? ` at ${chromePath}` : ''} (set EDGE_PATH).`)
  let chrome
  try {
    chrome = await launch({
      chromePath,
      port: await freePort(),
      chromeFlags: ['--headless=new', '--disable-gpu', '--no-first-run'],
    })
  } catch (e) {
    return notRun(`Edge could not be started for Lighthouse: ${e.message}`)
  }
  const findings = []
  const scores = []
  try {
    // Plan 8.1 names no form factor, so mobile (the Lighthouse default and Core Web Vitals' basis).
    for (const page of pickPages(root, job)) {
      let lhr
      try {
        const run = await lighthouse(`${baseUrl}/${page}`, {
          port: chrome.port,
          output: 'json',
          logLevel: 'silent',
          onlyCategories: ['performance'],
          formFactor: 'mobile',
        })
        lhr = run?.lhr
      } catch (e) {
        return notRun(`Lighthouse failed on ${page}: ${e.message}`)
      }
      if (!lhr || lhr.runtimeError || lhr.categories?.performance?.score == null)
        return notRun(
          `Lighthouse gave no result for ${page}: ${lhr?.runtimeError?.message ?? 'no score'}`,
        )
      const a = lhr.audits
      const m = {
        lcpMs: a['largest-contentful-paint'].numericValue,
        cls: a['cumulative-layout-shift'].numericValue,
        tbtMs: a['total-blocking-time'].numericValue,
      }
      const score = Math.round(lhr.categories.performance.score * 100)
      scores.push({
        page,
        score,
        lcpMs: round(m.lcpMs),
        cls: round(m.cls, 3),
        tbtMs: round(m.tbtMs),
      })
      const over = (rule, label, value, budget, unit) =>
        findings.push({
          message: `${label} is ${unit === 'ms' ? `${round(value)} ms` : round(value, 3)}, budget ${unit === 'ms' ? `${budget} ms` : budget}.`,
          file: page,
          rule,
          measured: unit === 'ms' ? round(value) : round(value, 3),
          budget,
        })
      if (m.lcpMs > budgets.lcpMs)
        over('lcp', 'Largest Contentful Paint', m.lcpMs, budgets.lcpMs, 'ms')
      if (m.cls > budgets.cls) over('cls', 'Cumulative Layout Shift', m.cls, budgets.cls, '')
      if (m.tbtMs > budgets.tbtMs) over('tbt', 'Total Blocking Time', m.tbtMs, budgets.tbtMs, 'ms')
      if (score < budgets.score)
        findings.push({
          message: `The Lighthouse performance score is ${score}, budget ${budgets.score}.`,
          file: page,
          rule: 'performance-score',
          measured: score,
          budget: budgets.score,
        })
    }
  } finally {
    // kill() also removes the temporary profile; on Windows a lingering lock must not fail the check.
    try {
      await chrome.kill()
    } catch {}
  }
  return {
    findings,
    note: `Lighthouse (mobile): ${scores.map((s) => `${s.page} score ${s.score}, LCP ${s.lcpMs} ms, CLS ${s.cls}, TBT ${s.tbtMs} ms`).join('; ')}`,
    scores,
  }
}

const notRun = (reason) => ({
  status: 'not-run',
  findings: [{ message: `Not run: ${reason}`, rule: 'not-run' }],
})
