// The check runner worker: Node + installed Edge. `node --test test/*.node.js`.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { takeShots } from '../src/checks.js'
import { openQueue, startWorker, waitForResult } from '../src/queue.js'
import { runJob } from '../src/run.js'
import { CSP, servePackage } from '../src/server.js'
import { compareRuns } from '../src/visual.js'
import { failedIds, fixture, jobOf, pinsOf, storeArchive, tarOf } from './helpers.js'

const tmp = mkdtempSync(join(tmpdir(), 'check-worker-test-'))
const jobDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('check-job-'))
const check = (r, id) => r.checks.find((c) => c.id === id)
const results = {}

// A secret is built from parts so no token-looking text sits in the repo.
const FAKE_AWS = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')

const NAMES = {
  clean: {},
  'inline-script': {},
  'eval-in-library': {},
  'missing-poster': {},
  'canvas-lcp': {},
  'broken-link': {},
  'bad-svg': {},
  'guide-break': {},
  'axe-fail': {},
  unpinned: { folder: 'clean', over: { pinned: [] } },
  secret: {
    folder: 'clean',
    over: { extraFiles: [{ path: 'notes.txt', data: `aws_key = ${FAKE_AWS}\n` }] },
  },
}

before(async () => {
  // Through the real folders, two at a time.
  const queue = openQueue(join(tmp, 'data-all'))
  const worker = startWorker({ queue, concurrency: 2, run: runJob, pollMs: 100 })
  for (const [n, o] of Object.entries(NAMES))
    queue.enqueue(jobOf(n, fixture(o.folder ?? n), join(tmp, 'blobs'), o.over))
  for (const n of Object.keys(NAMES)) results[n] = await waitForResult(queue, n)
  worker.stop()
  for (const n of Object.keys(NAMES))
    console.log(
      `# ${n}: ${results[n].checks.map((c) => `${c.id}=${c.status}`).join(' ')} memory=${JSON.stringify(results[n].memory)}`,
    )
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('a clean package passes every check', () => {
  const r = results.clean
  assert.equal(r.error, undefined)
  assert.equal(r.hashOk, true)
  assert.deepEqual(failedIds(r), [], JSON.stringify(r.checks, null, 1))
  assert.equal(r.blocked, false)
  assert.equal(r.checks.length, 15)
  assert.equal(check(r, 'performance').status, 'not-run')
  assert.equal(
    check(r, 'performance').findings[0].message,
    'not run (needs sitespeed.io, pending approval)',
  )
  assert.equal(check(r, 'visual').status, 'pass')
  assert.equal(check(r, 'visual').note, 'no baseline yet')
  for (const c of r.checks.filter((c) => c.floor)) assert.equal(c.level, 'block')
  assert.ok(Date.parse(r.startedAt) <= Date.parse(r.finishedAt))
})

const BAD = {
  // The inline script is seen by the CSP (browser), the static scan and the design validator.
  'inline-script': ['csp', 'csp-console', 'inline-code', 'validators'],
  'eval-in-library': ['csp'],
  'missing-poster': ['heavy-profile'],
  'canvas-lcp': ['heavy-profile'],
  'broken-link': ['links'],
  'bad-svg': ['svg'],
  'guide-break': ['validators'],
  'axe-fail': ['axe', 'html'],
  unpinned: ['pinned'],
  secret: ['secrets'],
}
for (const [name, expected] of Object.entries(BAD)) {
  test(`${name} fails ${expected.join(' + ')} and nothing else`, () => {
    const r = results[name]
    assert.deepEqual(failedIds(r), [...expected].sort(), JSON.stringify(r.checks, null, 1))
    assert.equal(r.blocked, true)
  })
}

test('findings name the right rule, file and never print a secret', () => {
  const rules = (n, c) => check(results[n], c).findings.map((f) => f.rule)
  assert.ok(rules('missing-poster', 'heavy-profile').includes('video-no-poster'))
  assert.ok(rules('canvas-lcp', 'heavy-profile').includes('canvas-is-lcp'))
  assert.ok(rules('eval-in-library', 'csp').includes('csp-violation'))
  assert.ok(rules('inline-script', 'inline-code').includes('inline-script'))
  assert.ok(rules('unpinned', 'pinned').includes('unpinned'))
  assert.equal(check(results.unpinned, 'pinned').floor, true)
  const svg = check(results['bad-svg'], 'svg').findings[0]
  assert.equal(svg.file, 'logo.svg')
  assert.match(svg.message, /script/)
  const colour = check(results['guide-break'], 'validators').findings
  assert.ok(
    colour.length > 0 && colour.every((f) => f.file === 'styles.css' || f.file.endsWith('.html')),
  )
  const secret = check(results.secret, 'secrets').findings[0]
  assert.equal(secret.file, 'notes.txt')
  assert.equal(secret.rule, 'aws-key')
  assert.ok(!JSON.stringify(results.secret).includes(FAKE_AWS))
})

test('navigation finds an unreachable page; seo finds a missing h1', async () => {
  const dir = join(tmp, 'orphan')
  cpSync(fixture('clean'), dir, { recursive: true })
  writeFileSync(
    join(dir, 'orphan.html'),
    readFileSync(join(dir, 'about.html'), 'utf8').replace('<h1>About</h1>', ''),
  )
  const r = await runJob(
    jobOf('orphan', dir, join(tmp, 'blobs'), {
      settings: { axe: 'off', 'heavy-profile': 'off', 'csp-console': 'off', visual: 'off' },
    }),
  )
  assert.deepEqual(failedIds(r), ['navigation', 'seo'])
  assert.equal(check(r, 'navigation').findings[0].file, 'orphan.html')
  assert.equal(check(r, 'seo').findings[0].rule, 'h1')
})

test('an axe finding that is accepted by rule and target counts as passed', async () => {
  const f = check(results['axe-fail'], 'axe').findings.find((x) => x.rule === 'image-alt')
  assert.ok(f, JSON.stringify(check(results['axe-fail'], 'axe')))
  const r = await runJob(
    jobOf('accepted', fixture('axe-fail'), join(tmp, 'blobs'), {
      acceptances: [{ rule: 'image-alt', target: f.target }],
      settings: { 'heavy-profile': 'off', 'csp-console': 'off', visual: 'off' },
    }),
  )
  const axe = check(r, 'axe')
  assert.equal(axe.status, 'pass')
  assert.deepEqual(axe.findings, [])
  assert.equal(axe.accepted.length, 1)
  assert.equal(axe.accepted[0].rule, 'image-alt')
  assert.equal(axe.accepted[0].file, 'index.html')
})

test('the visual check compares with the baseline archive', async () => {
  const baseline = storeArchive(tarOf([]), join(tmp, 'blobs')) // replaced below
  const clean = jobOf('v0', fixture('clean'), join(tmp, 'blobs'))
  const changed = join(tmp, 'changed')
  cpSync(fixture('clean'), changed, { recursive: true })
  writeFileSync(
    join(changed, 'styles.css'),
    readFileSync(join(changed, 'styles.css'), 'utf8').replace('#fff', '#ffe0e0'),
  )
  const off = { axe: 'off', 'heavy-profile': 'off', 'csp-console': 'off' }
  const same = await runJob({
    ...clean,
    id: 'v1',
    settings: off,
    baselineArchivePath: clean.archivePath,
  })
  assert.equal(check(same, 'visual').status, 'pass')
  assert.equal(check(same, 'visual').note, undefined)
  const diff = await runJob({
    ...jobOf('v2', changed, join(tmp, 'blobs'), { settings: off }),
    baselineArchivePath: clean.archivePath,
  })
  assert.equal(check(diff, 'visual').status, 'fail')
  assert.equal(check(diff, 'visual').findings[0].rule, 'visual-diff')
  assert.ok(baseline.hash)
})

test('a job whose archive does not match its hash is refused and nothing is unpacked', async () => {
  const before = jobDirs().length
  const job = jobOf('mismatch', fixture('clean'), join(tmp, 'blobs'))
  const tampered = storeArchive(
    tarOf([{ path: 'index.html', data: '<h1>other</h1>' }]),
    join(tmp, 'other'),
  )
  const r = await runJob({ ...job, archivePath: tampered.path })
  assert.equal(r.hashOk, false)
  assert.equal(r.blocked, true)
  assert.deepEqual(r.checks, [])
  assert.match(r.error, /does not hash/)
  assert.equal(jobDirs().length, before) // no temp folder was even made
  const missing = await runJob({ ...job, archivePath: join(tmp, 'nope.tar') })
  assert.equal(missing.hashOk, false)
  assert.equal(missing.blocked, true)
})

test('an archive with an unsafe path is refused after the hash passes', async () => {
  const evil = storeArchive(tarOf([{ path: '../escape.txt', data: 'x' }]), join(tmp, 'evil'))
  const r = await runJob({
    id: 'evil',
    kind: 'package',
    hash: evil.hash,
    archivePath: evil.path,
    settings: {},
  })
  assert.equal(r.hashOk, true)
  assert.equal(r.blocked, true)
  assert.match(r.error, /unsafe path/)
  assert.deepEqual(r.checks, [])
})

test('the security floor cannot be lowered; other checks can', async () => {
  const off = Object.fromEntries(
    [
      'html',
      'links',
      'csp',
      'inline-code',
      'validators',
      'svg',
      'pinned',
      'secrets',
      'axe',
      'visual',
    ].map((c) => [c, 'off']),
  )
  const r = await runJob(
    jobOf('floor', fixture('inline-script'), join(tmp, 'blobs'), { settings: off }),
  )
  for (const id of ['csp', 'inline-code', 'html', 'validators']) {
    const c = check(r, id)
    assert.equal(c.floor, true)
    assert.equal(c.level, 'block', id)
    assert.equal(c.lowered, "can't be lowered", id)
  }
  assert.equal(check(r, 'inline-code').status, 'fail')
  assert.equal(check(r, 'axe').status, 'off')
  assert.equal(check(r, 'axe').lowered, null)
  assert.equal(r.blocked, true)
  const warn = await runJob(
    jobOf('warn', fixture('missing-poster'), join(tmp, 'blobs'), {
      settings: { 'heavy-profile': 'warn', visual: 'off', axe: 'off' },
    }),
  )
  assert.equal(check(warn, 'heavy-profile').status, 'warn')
  assert.equal(check(warn, 'heavy-profile').lowered, null)
  assert.equal(warn.blocked, false)
})

test('a job flows through pending, running and results; the first rename wins', async () => {
  const data = join(tmp, 'data-flow')
  const queue = openQueue(data)
  const job = jobOf('flow', fixture('clean'), join(tmp, 'blobs'), {
    settings: { axe: 'off', 'heavy-profile': 'off', 'csp-console': 'off', visual: 'off' },
  })
  queue.enqueue(job)
  assert.deepEqual(readdirSync(join(data, 'checks', 'pending')), ['flow.json'])
  const claimed = queue.claim()
  assert.equal(claimed.id, 'flow')
  assert.deepEqual(readdirSync(join(data, 'checks', 'running')), ['flow.json'])
  assert.equal(queue.claim(), null)
  queue.recover() // a crashed worker's job goes back
  assert.deepEqual(readdirSync(join(data, 'checks', 'pending')), ['flow.json'])
  const worker = startWorker({ queue, concurrency: 1, run: runJob, pollMs: 50 })
  const r = await waitForResult(queue, 'flow')
  worker.stop()
  assert.equal(r.id, 'flow')
  assert.equal(r.kind, 'package')
  assert.equal(r.hash, job.hash)
  assert.equal(r.blocked, false)
  assert.deepEqual(readdirSync(join(data, 'checks', 'running')), [])
  assert.deepEqual(readdirSync(join(data, 'checks', 'pending')), [])
  assert.ok(!readdirSync(join(data, 'checks', 'results')).some((n) => n.endsWith('.tmp')))
  assert.deepEqual(
    JSON.parse(readFileSync(join(data, 'checks', 'results', 'flow.json'), 'utf8')).id,
    'flow',
  )
})

test('concurrency 2 runs two jobs at once; concurrency 1 does not', async () => {
  const run = async (c) => {
    const queue = openQueue(join(tmp, `data-c${c}`))
    const worker = startWorker({ queue, concurrency: c, run: runJob, pollMs: 50 })
    for (const id of ['x', 'y'])
      queue.enqueue(
        jobOf(id, fixture('clean'), join(tmp, 'blobs'), {
          settings: { axe: 'off', 'heavy-profile': 'off', 'csp-console': 'off', visual: 'off' },
        }),
      )
    const [x, y] = [await waitForResult(queue, 'x'), await waitForResult(queue, 'y')]
    worker.stop()
    const t = (r) => [Date.parse(r.startedAt), Date.parse(r.finishedAt)]
    return t(x)[0] < t(y)[1] && t(y)[0] < t(x)[1] // overlap
  }
  assert.equal(await run(2), true)
  assert.equal(await run(1), false)
})

test('screenshots of the same package are identical across two runs', async () => {
  const s = await servePackage(fixture('clean'))
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const shoot = (tag) =>
      takeShots({ browser, baseUrl: s.url, root: fixture('clean'), outDir: join(tmp, 'diff'), tag })
    const diffs = compareRuns(await shoot('a'), await shoot('b'))
    assert.equal(Object.keys(diffs).length, 6)
    for (const [k, v] of Object.entries(diffs)) assert.ok(v <= 0.0001, `${k}: ${v}`)
  } finally {
    await browser.close()
    await s.close()
  }
})

test('the package is served unchanged with the contract CSP', async () => {
  const s = await servePackage(fixture('clean'))
  const res = await fetch(`${s.url}/index.html`)
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.ok(bytes.equals(readFileSync(join(fixture('clean'), 'index.html'))))
  const csp = res.headers.get('content-security-policy')
  assert.equal(csp, CSP)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal((await fetch(`${s.url}/..%2f..%2fpackage.json`)).status, 403)
  await s.close()
})

const smokeJob = (id, smokeUrl) => ({
  ...jobOf(id, fixture('clean'), join(tmp, 'blobs')),
  kind: 'smoke',
  smokeUrl,
})

test('a smoke job passes against a static server that behaves', async () => {
  const s = await servePackage(fixture('clean'))
  const r = await runJob(smokeJob('smoke-ok', `${s.url}/`))
  await s.close()
  assert.equal(r.kind, 'smoke')
  assert.deepEqual(
    r.checks.map((c) => c.id),
    ['smoke'],
  )
  assert.equal(check(r, 'smoke').status, 'pass', JSON.stringify(r.checks))
  assert.equal(r.blocked, false)
})

test('a smoke job fails on a missing page, a missing CSP header and an outside request', async () => {
  const outside = createServer((_req, res) => res.end('x'))
  await new Promise((ok) => outside.listen(0, '127.0.0.1', ok))
  const outsideUrl = `http://127.0.0.1:${outside.address().port}/x.png`
  const html = `<!doctype html><title>t</title><img src="${outsideUrl}" alt="">`
  const bad = createServer((req, res) => {
    if (req.url.endsWith('about.html')) return res.writeHead(404).end('no')
    res.writeHead(200, { 'content-type': 'text/html' }).end(html) // no CSP header
  })
  await new Promise((ok) => bad.listen(0, '127.0.0.1', ok))
  const r = await runJob(smokeJob('smoke-bad', `http://127.0.0.1:${bad.address().port}/`))
  bad.close()
  outside.close()
  const rules = check(r, 'smoke').findings.map((f) => f.rule)
  assert.equal(check(r, 'smoke').status, 'fail')
  assert.equal(r.blocked, true)
  for (const rule of ['status', 'no-csp-header', 'outside-request'])
    assert.ok(rules.includes(rule), `${rule} in ${rules}`)
})

test('pinned lists are checked by checksum', async () => {
  const wrong = pinsOf(fixture('clean')).map((p) => ({ ...p, sha256: '0'.repeat(64) }))
  const r = await runJob(
    jobOf('wrongsum', fixture('clean'), join(tmp, 'blobs'), {
      pinned: wrong,
      settings: { axe: 'off', 'heavy-profile': 'off', 'csp-console': 'off', visual: 'off' },
    }),
  )
  assert.deepEqual(failedIds(r), ['pinned'])
  assert.equal(check(r, 'pinned').findings[0].rule, 'checksum')
})
