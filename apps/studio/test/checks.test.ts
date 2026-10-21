// M6 step 3: check settings, check runs, staging and publication requests (app side).
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { FLOOR_CHECKS } from '../server/checks/checks.ts'
import { openDb } from '../server/db/index.ts'
import { verifyStagingLink } from '../server/preview/review-link.ts'

const APP = 'http://localhost:3000'
const SECRET = 'test-secret-for-checks'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any

const CSS = 'body{font-family:"PT Sans",sans-serif;color:#2e4163;background:#ffffff}'
const HOME = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><section data-section="s-aaaaaa"><h2>Hello</h2><p>Text</p></section></body></html>`
const ITEMS = ['copy', 'media', 'interactions', 'mobile', 'motion', 'translated', 'tested']

async function setup(withPreview = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-checks-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const previewUrl = new URL('http://127.0.0.1:3001')
  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir,
    ...(withPreview ? { appSecret: SECRET, previewUrl } : {}),
  })
  const as = (handle: string) => {
    const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
    const s = createSession(db, user.id, Date.now())
    const headers = { origin: APP, cookie: `${SESSION_COOKIE}=${s.id}`, 'x-csrf-token': s.csrf }
    return async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
    }
  }
  const alex = as('alex')
  const rune = as('rune') // not a member of "go"
  const admin = as('admina')
  await alex('POST', '/api/projects', { name: 'Go' })
  const D = '/api/p/go/design'
  const board = (
    await alex('POST', `${D}/artboards`, {
      pageId: 'home',
      html: HOME,
      css: CSS,
      description: 'x',
    })
  ).body
  await alex('POST', `${D}/artboards`, {
    pageId: 'home',
    html: HOME,
    css: CSS,
    description: 'x',
    role: 'state',
    kind: 'mobile',
    parentId: board.id,
  })
  for (const i of ITEMS)
    await alex('PUT', `${D}/sections/${board.id}/s-aaaaaa/check/${i}`, { on: true })
  await alex('POST', `${D}/sections/${board.id}/s-aaaaaa/approve`)

  /** Save a revision and approve it; returns the rev and the run queued by the approval. */
  const approveNew = async () => {
    const rev = (await alex('POST', '/api/p/go/draft/save', { msg: 'Saved' })).body
      .revision as string
    const r = await alex('POST', `/api/p/go/review/${rev}/approve`)
    if (r.status !== 200) throw new Error(JSON.stringify(r.body))
    const runs = (await alex('GET', '/api/p/go/checks/runs')).body.runs as Json[]
    return {
      rev,
      hash: r.body.approval.packageHash as string,
      run: runs.find((x) => x.rev === rev) as Json,
    }
  }
  const checksDir = join(dataDir, 'checks')
  const job = (id: string) =>
    JSON.parse(readFileSync(join(checksDir, 'pending', `${id}.json`), 'utf8')) as Json
  /** What the worker would write for a job: a result file under results/. */
  const fakeWorker = (id: string, over: Json = {}, failing: string[] = []) => {
    const j = job(id)
    const result = {
      id,
      kind: j.kind,
      hash: j.hash,
      startedAt: 'a',
      finishedAt: 'b',
      hashOk: true,
      checks:
        j.kind === 'smoke'
          ? [
              {
                id: 'smoke',
                floor: false,
                level: 'block',
                status: 'pass',
                lowered: null,
                findings: [],
              },
            ]
          : FLOOR_CHECKS.map((c) => ({
              id: c,
              floor: true,
              level: 'block',
              status: failing.includes(c) ? 'fail' : 'pass',
              lowered: null,
              findings: [],
            })),
      blocked: failing.length > 0,
      ...over,
    }
    mkdirSync(join(checksDir, 'results'), { recursive: true })
    writeFileSync(join(checksDir, 'results', `${id}.json`), JSON.stringify(result))
  }
  return { db, dataDir, alex, rune, admin, approveNew, job, fakeWorker, checksDir }
}

describe('check settings', () => {
  test('a floor setting cannot be lowered; nothing is stored or audited', async () => {
    const t = await setup()
    const r = await t.admin('PUT', '/api/admin/checks/csp', { level: 'warn' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('cant-be-lowered')
    const list = (await t.admin('GET', '/api/admin/checks')).body
    expect(list.checks.find((c: Json) => c.id === 'csp')).toMatchObject({
      floor: true,
      level: 'block',
    })
    expect(t.db.query('select count(*) as n from check_settings').get()).toEqual({ n: 0 })
    expect(t.db.query('select count(*) as n from check_audit').get()).toEqual({ n: 0 })
  })

  test('a non-floor setting changes, is audited, and reaches the job', async () => {
    const t = await setup()
    const r = await t.admin('PUT', '/api/admin/checks/axe', { level: 'warn' })
    expect(r.status).toBe(200)
    const list = (await t.admin('GET', '/api/admin/checks')).body
    expect(list.checks.map((c: Json) => c.id)).toEqual(
      expect.arrayContaining(['html', 'axe', 'smoke']),
    )
    expect(list.checks.find((c: Json) => c.id === 'axe')).toMatchObject({
      floor: false,
      level: 'warn',
    })
    expect(list.failureAnalysis).toBe('analyse-and-fix')
    expect(t.db.query('select who, check_id, from_level, to_level from check_audit').all()).toEqual(
      [{ who: 'admina', check_id: 'axe', from_level: 'block', to_level: 'warn' }],
    )
    expect((await t.admin('PUT', '/api/admin/checks/axe', { level: 'bogus' })).status).toBe(400)
    expect((await t.admin('PUT', '/api/admin/checks/nope', { level: 'off' })).status).toBe(404)
    // failure analysis
    expect(
      (await t.admin('PUT', '/api/admin/checks/failure-analysis', { value: 'analyse' })).status,
    ).toBe(200)
    expect((await t.admin('GET', '/api/admin/checks')).body.failureAnalysis).toBe('analyse')
    expect(
      (await t.admin('PUT', '/api/admin/checks/failure-analysis', { value: 'x' })).status,
    ).toBe(400)
    const { run } = await t.approveNew()
    expect(t.job(run.id).settings).toMatchObject({ axe: 'warn', html: 'block', csp: 'block' })
  })

  test('a Creator cannot read or change settings', async () => {
    const t = await setup()
    expect((await t.alex('PUT', '/api/admin/checks/axe', { level: 'off' })).status).toBe(403)
    expect(
      (await t.alex('PUT', '/api/admin/checks/failure-analysis', { value: 'off' })).status,
    ).toBe(403)
    expect((await t.alex('GET', '/api/admin/checks')).status).toBe(403)
    expect(t.db.query('select count(*) as n from check_settings').get()).toEqual({ n: 0 })
  })
})

describe('check runs and staging', () => {
  test('approving queues a job file with the right hash, settings and acceptances', async () => {
    const t = await setup()
    const { rev, hash, run } = await t.approveNew()
    expect(run).toMatchObject({ kind: 'package', status: 'queued', hash, rev })
    const job = t.job(run.id)
    expect(job).toMatchObject({ id: run.id, kind: 'package', project: 'go', rev, hash, pinned: [] })
    expect(Object.keys(job.settings).sort()).toEqual(
      expect.arrayContaining([...FLOOR_CHECKS, 'axe', 'smoke']),
    )
    expect(Object.values(job.settings).every((v) => v === 'block')).toBe(true)
    expect(existsSync(job.archivePath)).toBe(true)
    expect(job.archivePath).toMatch(/blobs[\\/]sha256[\\/][0-9a-f]{2}[\\/][0-9a-f]{62}$/)
    expect(job.acceptances).toEqual([])
    expect(job.guide).toBeTruthy()
    expect(job.baselineArchivePath).toBeUndefined()
    expect(readdirSync(join(t.checksDir, 'pending')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('a clean result finishes the run, stages the revision and queues the smoke job', async () => {
    const t = await setup()
    const { rev, hash, run } = await t.approveNew()
    t.fakeWorker(run.id)
    const got = (await t.alex('GET', `/api/p/go/checks/runs/${run.id}`)).body.run
    expect(got).toMatchObject({ status: 'done', blocked: false, error: null })
    expect(got.result.checks).toHaveLength(FLOOR_CHECKS.length)
    const s = (await t.alex('GET', '/api/p/go/staging')).body
    expect(s.staged).toMatchObject({ rev, hash })
    const token = new URL(s.url).pathname.split('/')[2] as string
    expect(verifyStagingLink(SECRET, token)).toMatchObject({ project: 'go', rev, hash })
    const runs = (await t.alex('GET', '/api/p/go/checks/runs')).body.runs as Json[]
    const smoke = runs.find((r) => r.kind === 'smoke') as Json
    expect(smoke).toBeTruthy()
    const sj = t.job(smoke.id)
    expect(sj).toMatchObject({ kind: 'smoke', hash })
    expect(sj.smokeUrl).toContain('http://127.0.0.1:3001/staging/')
    expect(s.smoke).toMatchObject({ id: smoke.id, status: 'queued' })
    t.fakeWorker(smoke.id)
    expect((await t.alex('GET', '/api/p/go/staging')).body.smoke).toMatchObject({ status: 'done' })
    // reading again changes nothing: one staged row, one smoke job
    expect((await t.alex('GET', '/api/p/go/checks/runs')).body.runs).toHaveLength(2)
    // the next approval carries the staged package as the baseline
    const second = await t.approveNew()
    expect(t.job(second.run.id).baselineArchivePath).toBe(sj.archivePath)
    const last = (await t.admin('GET', '/api/admin/checks')).body.checks
    expect(last.find((c: Json) => c.id === 'smoke').last.status).toBe('pass')
    expect(last.find((c: Json) => c.id === 'html').last.status).toBe('pass')
  })

  test('a result with the wrong hash is refused: blocked, an error, nothing staged', async () => {
    const t = await setup()
    const { run } = await t.approveNew()
    t.fakeWorker(run.id, { hash: 'f'.repeat(64) })
    const got = (await t.alex('GET', `/api/p/go/checks/runs/${run.id}`)).body.run
    expect(got).toMatchObject({ status: 'done', blocked: true, error: 'hash-mismatch' })
    expect((await t.alex('GET', '/api/p/go/staging')).body.staged).toBeNull()
  })

  test('a blocked or failing result does not stage; one rerun is allowed', async () => {
    const t = await setup()
    const { run } = await t.approveNew()
    t.fakeWorker(run.id, {}, ['links'])
    expect((await t.alex('GET', `/api/p/go/checks/runs/${run.id}`)).body.run).toMatchObject({
      status: 'done',
      blocked: true,
    })
    expect((await t.alex('GET', '/api/p/go/staging')).body.staged).toBeNull()
    // blocked is false but a floor check did not pass: still no staging
    const second = await t.approveNew()
    t.fakeWorker(second.run.id, { blocked: false }, ['links'])
    expect((await t.alex('GET', '/api/p/go/staging')).body.staged).toBeNull()
    // the rerun: same package, once
    const re = await t.alex('POST', `/api/p/go/checks/runs/${run.id}/rerun`)
    expect(re.status).toBe(201)
    expect(re.body.run).toMatchObject({ rerunOf: run.id, hash: run.hash, status: 'queued' })
    expect(t.job(re.body.run.id).hash).toBe(run.hash)
    expect((await t.alex('POST', `/api/p/go/checks/runs/${run.id}/rerun`)).status).toBe(409)
  })

  test('only the newest revision stages', async () => {
    const t = await setup()
    const first = await t.approveNew()
    const second = await t.approveNew()
    t.fakeWorker(first.run.id)
    expect((await t.alex('GET', '/api/p/go/staging')).body.staged).toBeNull()
    t.fakeWorker(second.run.id)
    expect((await t.alex('GET', '/api/p/go/staging')).body.staged.rev).toBe(second.rev)
  })

  test('staging without a preview config answers 503', async () => {
    const t = await setup(false)
    const { run } = await t.approveNew()
    t.fakeWorker(run.id)
    const r = await t.alex('GET', '/api/p/go/staging')
    expect(r.status).toBe(503)
    expect(r.body.staged).toBeTruthy()
  })
})

describe('publication requests', () => {
  test('a newer request supersedes the older, in one step; notes are checked', async () => {
    const t = await setup()
    const q = '/api/p/go/staging/request'
    expect((await t.alex('POST', q, { note: 'Early' })).status).toBe(409) // nothing staged yet
    const { run, hash, rev } = await t.approveNew()
    t.fakeWorker(run.id)
    expect((await t.alex('POST', q, { note: '   ' })).status).toBe(400)
    expect((await t.alex('POST', q, {})).status).toBe(400)
    expect((await t.alex('POST', q, { note: 'x'.repeat(2001) })).status).toBe(400)
    const a = await t.alex('POST', q, { note: '  First <b>note</b>  ' })
    expect(a.status).toBe(201)
    const b = await t.admin('POST', q, { note: 'x'.repeat(2000) })
    expect(b.status).toBe(201)
    const reqs = (await t.alex('GET', '/api/p/go/staging')).body.requests as Json[]
    expect(reqs.map((r) => [r.by, r.status, r.hash, r.rev])).toEqual([
      ['admina', 'open', hash, rev],
      ['alex', 'superseded', hash, rev],
    ])
    expect(reqs[1].note).toBe('First <b>note</b>')
  })
})

describe('members only', () => {
  test('every project route is a 404 for a non-member', async () => {
    const t = await setup()
    const { run } = await t.approveNew()
    for (const [m, p] of [
      ['GET', '/api/p/go/checks/runs'],
      ['GET', `/api/p/go/checks/runs/${run.id}`],
      ['POST', `/api/p/go/checks/runs/${run.id}/rerun`],
      ['GET', '/api/p/go/staging'],
      ['POST', '/api/p/go/staging/request'],
    ] as const) {
      const r = await t.rune(m, p, m === 'POST' ? { note: 'hi' } : undefined)
      expect([m, p, r.status]).toEqual([m, p, 404])
    }
    // an Admin sees every project
    expect((await t.admin('GET', '/api/p/go/checks/runs')).status).toBe(200)
    // nobody without a session
    const r = await createAppless()
    expect(r).toBe(401)
  })
})

async function createAppless() {
  const app = createApp({ appUrl: new URL(APP), instanceId: 'qw' })
  return (await app.request(`${APP}/api/p/go/staging`)).status
}
