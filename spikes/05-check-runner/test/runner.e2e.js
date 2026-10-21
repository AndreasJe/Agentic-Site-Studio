// Spike 5: the check runner worker. Node + installed Edge: `node --test test/*.e2e.js`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openQueue, startWorker, waitForResult } from '../src/queue.js'
import { runJob } from '../src/run.js'
import { CSP, servePackage } from '../src/server.js'
import { compareRuns } from '../src/visual.js'

const fx = (n) => fileURLToPath(new URL(`../fixtures/${n}/`, import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'check-runner-spike-'))
const results = {}
const NAMES = [
  'clean',
  'inline-script',
  'eval-in-library',
  'missing-poster',
  'canvas-lcp',
  'broken-link',
]

before(async () => {
  // Two at a time, through the real queue and worker.
  const queue = openQueue(join(tmp, 'q-all'))
  const worker = startWorker({ queue, concurrency: 2, run: runJob })
  for (const n of NAMES)
    queue.enqueue({ id: n, packageDir: fx(n), settings: {}, outDir: join(tmp, 'out', n) })
  for (const n of NAMES) results[n] = await waitForResult(queue, n)
  worker.stop()
  for (const n of NAMES) {
    const m = Object.entries(results[n].checks)
      .map(
        ([id, c]) =>
          `${id}=${c.outcome}(${c.peakRssMB?.worker ?? '-'}/${c.peakRssMB?.browser ?? '-'}MB)`,
      )
      .join(' ')
    console.log(`# ${n}: ${m}`)
  }
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const failed = (r) =>
  Object.entries(r.checks)
    .filter(([, c]) => c.status === 'fail')
    .map(([id]) => id)
    .sort()

test('a clean package passes every check', () => {
  const r = results.clean
  assert.equal(r.error, undefined)
  assert.deepEqual(failed(r), [], JSON.stringify(r.checks, null, 1))
  assert.equal(r.passed, true)
  assert.equal(r.checks.performance.note, 'not run (needs sitespeed.io, pending approval)')
})

const BAD = {
  'inline-script': ['csp', 'inline-code'], // both floor checks see an inline script
  'eval-in-library': ['csp'],
  'missing-poster': ['heavy-profile'],
  'canvas-lcp': ['heavy-profile'],
  'broken-link': ['links'],
}
for (const [name, expected] of Object.entries(BAD)) {
  test(`${name} fails ${expected.join(' + ')} and nothing else`, () => {
    const r = results[name]
    assert.deepEqual(failed(r), [...expected].sort(), JSON.stringify(r.checks, null, 1))
    assert.equal(r.passed, false)
  })
}

test('findings name the right rule', () => {
  const rules = (n, c) => results[n].checks[c].findings.map((f) => f.rule)
  assert.ok(rules('missing-poster', 'heavy-profile').includes('video-no-poster'))
  assert.ok(rules('canvas-lcp', 'heavy-profile').includes('canvas-is-lcp'))
  assert.ok(rules('eval-in-library', 'csp').includes('csp-violation'))
  assert.ok(rules('inline-script', 'inline-code').includes('inline-script'))
})

test('screenshots of the same package are identical across two runs', async () => {
  for (const name of ['clean', 'canvas-lcp']) {
    const run = (tag) =>
      runJob({ id: tag, packageDir: fx(name), settings: {}, outDir: join(tmp, 'diff', name), tag })
    const [a, b] = [await run('a'), await run('b')]
    const diffs = compareRuns(a.checks.screenshots.shots, b.checks.screenshots.shots)
    assert.equal(Object.keys(diffs).length, 3 * (name === 'clean' ? 2 : 2))
    console.log(`# diff ratios ${name}:`, JSON.stringify(diffs))
    for (const [k, v] of Object.entries(diffs)) assert.ok(v <= 0.0001, `${name} ${k}: ${v}`)
  }
})

test('the security floor cannot be lowered; other checks can', async () => {
  const off = {
    checks: Object.fromEntries(
      ['html', 'links', 'inline-code', 'csp', 'axe', 'heavy-profile', 'screenshots'].map((c) => [
        c,
        'off',
      ]),
    ),
  }
  const r = await runJob({
    id: 'floor',
    packageDir: fx('inline-script'),
    settings: off,
    outDir: join(tmp, 'floor'),
  })
  assert.equal(r.checks.csp.outcome, 'block')
  assert.equal(r.checks.csp.configured, 'off')
  assert.match(r.checks.csp.note, /can't be lowered/)
  assert.equal(r.checks['inline-code'].outcome, 'block')
  assert.match(r.checks['inline-code'].note, /can't be lowered/)
  assert.equal(r.checks.axe.outcome, 'off')
  assert.equal(r.passed, false)
  const warn = await runJob({
    id: 'warn',
    packageDir: fx('inline-script'),
    settings: { checks: { csp: 'warn', 'inline-code': 'warn' } },
    outDir: join(tmp, 'floor2'),
  })
  assert.deepEqual(warn.blocked.sort(), ['csp', 'inline-code'])
})

test('a lowered non-floor check warns instead of blocking', async () => {
  const r = await runJob({
    id: 'w',
    packageDir: fx('missing-poster'),
    settings: { checks: { 'heavy-profile': 'warn' } },
    outDir: join(tmp, 'warn'),
  })
  assert.equal(r.checks['heavy-profile'].outcome, 'warn')
  assert.equal(r.passed, true)
})

test('concurrency 2 runs two jobs at once; concurrency 1 does not', async () => {
  const run = async (c) => {
    const queue = openQueue(join(tmp, `q-c${c}`))
    const worker = startWorker({ queue, concurrency: c, run: runJob })
    for (const id of ['x', 'y'])
      queue.enqueue({ id, packageDir: fx('clean'), settings: { checks: { screenshots: 'off' } } })
    const [x, y] = [await waitForResult(queue, 'x'), await waitForResult(queue, 'y')]
    worker.stop()
    return x.startedAt < y.finishedAt && y.startedAt < x.finishedAt // overlap
  }
  assert.equal(await run(2), true)
  assert.equal(await run(1), false)
})

test('the package is served unchanged with the contract CSP', async () => {
  const s = await servePackage(fx('clean'))
  const res = await fetch(`${s.url}/index.html`)
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.ok(bytes.equals(readFileSync(join(fx('clean'), 'index.html'))))
  const csp = res.headers.get('content-security-policy')
  assert.equal(csp, CSP)
  assert.match(csp, /frame-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal((await fetch(`${s.url}/..%2f..%2fpackage.json`)).status, 403)
  await s.close()
})
