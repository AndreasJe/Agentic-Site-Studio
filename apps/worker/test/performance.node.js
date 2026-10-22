// The speed check (Lighthouse, mobile, installed Edge). Few jobs, because each page takes seconds.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_BUDGETS, edgePath } from '../src/performance.js'
import { runJob } from '../src/run.js'
import { fixture, jobOf } from './helpers.js'

const tmp = mkdtempSync(join(tmpdir(), 'check-perf-test-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// Only the speed check, at the given level, so the test stays short.
const perfJob = (id, folder, level, over = {}) =>
  jobOf(id, fixture(folder), join(tmp, 'blobs'), {
    settings: {
      performance: level,
      axe: 'off',
      'heavy-profile': 'off',
      'csp-console': 'off',
      visual: 'off',
    },
    pageTypes: [{ name: 'home', page: 'index.html' }],
    ...over,
  })
const perf = (r) => r.checks.find((c) => c.id === 'performance')

test('Edge is found for Lighthouse', () => {
  assert.ok(edgePath(), 'no Edge executable')
})

test('the clean fixture is within the budgets', async () => {
  const r = await runJob(perfJob('perf-clean', 'clean', 'block'))
  const c = perf(r)
  console.log(`# clean: ${c.status} ${c.note}`)
  assert.equal(c.status, 'pass', JSON.stringify(c))
  assert.equal(c.level, 'block')
  assert.match(c.note, /index\.html score \d+, LCP \d+ ms/)
})

test('a heavy package fails the speed budgets per page and metric, and blocks by default', async () => {
  const r = await runJob(perfJob('perf-slow', 'slow', 'block'))
  const c = perf(r)
  console.log(`# slow: ${c.status} ${c.note}`)
  assert.equal(c.status, 'fail')
  const tbt = c.findings.find((f) => f.rule === 'tbt')
  assert.ok(tbt, JSON.stringify(c.findings))
  assert.equal(tbt.file, 'index.html')
  assert.equal(tbt.budget, DEFAULT_BUDGETS.tbtMs)
  assert.ok(tbt.measured > tbt.budget)
  assert.ok(c.findings.some((f) => f.rule === 'performance-score'))
  assert.equal(r.blocked, true)

  // Warn reports the same findings without blocking; a job budget can raise the limits.
  const warn = await runJob(perfJob('perf-warn', 'slow', 'warn'))
  assert.equal(perf(warn).status, 'warn')
  assert.equal(perf(warn).level, 'warn')
  assert.equal(perf(warn).floor, false)
  assert.equal(warn.blocked, false)
})

test('Off does not run Lighthouse; job budgets override the defaults', async () => {
  const off = await runJob(perfJob('perf-off', 'slow', 'off'))
  assert.equal(perf(off).status, 'off')
  assert.deepEqual(perf(off).findings, [])
  assert.equal(off.blocked, false)

  const loose = await runJob(
    perfJob('perf-loose', 'slow', 'block', {
      budgets: { lcpMs: 60000, cls: 1, tbtMs: 600000, score: 0 },
    }),
  )
  assert.equal(perf(loose).status, 'pass', JSON.stringify(perf(loose)))
})

test('a Lighthouse that cannot start reports not-run, never a pass', async () => {
  const saved = [process.env.EDGE_PATH, process.env.CHROME_PATH]
  // Point at a file that is not a browser: Edge itself is not needed for this case.
  process.env.EDGE_PATH = join(tmp, 'not-a-browser.exe')
  try {
    const { performanceCheck } = await import('../src/performance.js')
    const r = await performanceCheck({
      baseUrl: 'http://127.0.0.1:1',
      root: fixture('clean'),
      job: {},
    })
    assert.equal(r.status, 'not-run')
    assert.match(r.findings[0].message, /^Not run: /)
  } finally {
    for (const [k, v] of [
      ['EDGE_PATH', saved[0]],
      ['CHROME_PATH', saved[1]],
    ])
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
})
