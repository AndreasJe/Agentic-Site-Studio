// M6 step 4: the analyst, against the mock model (plan §13.5; decision #21).
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { redact } from '../server/checks/analyst.ts'
import { FLOOR_CHECKS } from '../server/checks/checks.ts'
import { openDb } from '../server/db/index.ts'
import { mockServer, type Reply } from './llm/mock-server.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
let stop = () => {}
afterEach(() => stop())
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any

const CSS = 'body{font-family:"PT Sans",sans-serif;color:#2e4163;background:#ffffff}'
const ITEMS = ['copy', 'media', 'interactions', 'mobile', 'motion', 'translated', 'tested']
const sec = (id: string, inner = '<h2>Hello</h2><p>Text</p>') =>
  `<section data-section="${id}">${inner}</section>`
const page = (...s: string[]) =>
  `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${s.join('')}</body></html>`
const GOOD = page(sec('s-aaaaaa'), sec('s-bbbbbb', '<h2>Proof</h2><a href="x.html">x</a>'))

const PLANTED = {
  key: 'sk_live_Zx9Qw8Er7Ty6Ui5Op4',
  token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  email: 'bob.private@example.com',
}

const answer = (o: Json = {}): Reply => ({
  kind: 'content',
  content: JSON.stringify({
    issues: [
      {
        check: 'links',
        cause: 'A link points to a page that does not exist.',
        severity: 'high',
        confidence: 'high',
        evidence: ['broken link x.html'],
      },
    ],
    recommendation: 'fix',
    patch: null,
    ...o,
  }),
})
const patchOf = (o: Json = {}) => ({
  artboardId: 1,
  sectionId: 's-bbbbbb',
  html: sec('s-bbbbbb', '<h2>Proof</h2><a href="index.html">Home</a>'),
  css: CSS,
  ...o,
})

async function setup(script: Reply[]) {
  const mock = mockServer(script)
  stop = mock.stop
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-analyst-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir,
    llmEndpoint: {
      name: 'mock',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      model: 'm',
      capability: 'json_schema',
    },
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
  const admin = as('admina')
  await alex('POST', '/api/projects', { name: 'Go' })
  const D = '/api/p/go/design'
  const board = (
    await alex('POST', `${D}/artboards`, { pageId: 'home', html: GOOD, css: CSS, description: 'x' })
  ).body
  let n = 0
  /** A finished, failed run, as the worker's result would leave it. */
  const failRun = (
    over: {
      failing?: string[]
      rerunOf?: string
      findings?: Json[]
      rev?: string
      blocked?: number
    } = {},
  ) => {
    const id = `run-${++n}`
    const failing = over.failing ?? ['links']
    const result = {
      hash: 'h',
      hashOk: true,
      blocked: true,
      checks: [...FLOOR_CHECKS, 'axe'].map((c) => ({
        id: c,
        status: failing.includes(c) ? 'fail' : 'pass',
        findings: failing.includes(c)
          ? (over.findings ?? [{ message: 'broken link x.html in s-bbbbbb', file: 'index.html' }])
          : [],
      })),
    }
    db.query(
      "insert into check_runs (id, project_id, rev, hash, kind, status, blocked, result_json, rerun_of, at) values (?, 'go', ?, 'h', 'package', 'done', ?, ?, ?, ?)",
    ).run(
      id,
      over.rev ?? 'go-r1',
      over.blocked ?? 1,
      JSON.stringify(result),
      over.rerunOf ?? null,
      new Date(Date.now() + n).toISOString(),
    )
    return id
  }
  const F = (id: string) => `/api/admin/failures/${id}`
  const revisions = () => {
    const dir = join(dataDir, 'go', 'revisions')
    return existsSync(dir) ? readdirSync(dir).length : 0
  }
  const setMode = (value: string) => admin('PUT', '/api/admin/checks/failure-analysis', { value })
  const bodies = () => mock.bodies as unknown as Json[]
  const count = (table: string) =>
    (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n
  return { db, alex, admin, board, failRun, F, revisions, setMode, bodies, count }
}

describe('redaction', () => {
  test('masks keys, tokens, emails and long runs', () => {
    const out = redact(
      `api_key=${PLANTED.key} ${PLANTED.token} ${PLANTED.email} AKIAABCDEFGHIJKLMNOP xoxb-12345678-abcdefgh eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig ${'a1'.repeat(20)} -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----`,
    )
    for (const s of [
      PLANTED.key,
      PLANTED.token,
      PLANTED.email,
      'AKIAABCDEFGHIJKLMNOP',
      'xoxb-',
      'eyJhbG',
      'MIIEow',
      'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    ])
      expect(out).not.toContain(s)
    expect(out).toContain('[redacted]')
  })

  test('the model receives nothing planted, and the data sits inside the marker', async () => {
    const s = await setup([answer()])
    const findings = [
      {
        message: `broken link in s-bbbbbb; api_key=${PLANTED.key} token ${PLANTED.token} mail ${PLANTED.email}`,
        file: 'index.html',
      },
    ]
    const id = s.failRun({ findings })
    const r = await s.admin('POST', `${s.F(id)}/analyse`)
    expect(r.status).toBe(200)
    const sent = JSON.stringify(s.bodies()[0])
    for (const v of Object.values(PLANTED)) expect(sent).not.toContain(v)
    expect(sent).toContain('broken link')
    const data = (s.bodies()[0]?.messages ?? []).find((m: Json) => m.role === 'user')?.content ?? ''
    expect(data).toContain('quoted data')
    expect(data).toContain('s-bbbbbb')
  })
})

describe('the answer and what code does with it', () => {
  test('let-through on a floor failure becomes hold', async () => {
    const s = await setup([answer({ recommendation: 'let-through' })])
    const id = s.failRun({ failing: ['csp'] })
    const r = await s.admin('POST', `${s.F(id)}/analyse`)
    expect(r.body.floorFailed).toBe(true)
    expect(r.body.analysis.recommendation).toBe('hold')
    expect(r.body.analysis.note).toContain('Security-floor failure: a person decides')
    expect(r.body.analysis.status).toBe('ready')
    expect(r.body.analysis.attempt).toBe(1)
  })

  test('let-through stays for an advisory failure', async () => {
    const s = await setup([answer({ recommendation: 'let-through' })])
    const id = s.failRun({ failing: ['axe'] })
    const r = await s.admin('POST', `${s.F(id)}/analyse`)
    expect(r.body.floorFailed).toBe(false)
    expect(r.body.analysis.recommendation).toBe('let-through')
  })

  test('the cost cap is in the call, and the model is given no tools', async () => {
    const s = await setup([answer()])
    await s.admin('POST', `${s.F(s.failRun())}/analyse`)
    const body = s.bodies()[0]
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.max_tokens).toBeLessThanOrEqual(8000)
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  test('a result over the size cap is refused', async () => {
    const s = await setup([answer()])
    const id = s.failRun({ findings: [{ message: 'x '.repeat(150_000) }] })
    const r = await s.admin('POST', `${s.F(id)}/analyse`)
    expect(r.status).toBe(413)
    expect(s.bodies().length).toBe(0)
  })

  test('a good patch is kept', async () => {
    const s = await setup([answer({ patch: patchOf() })])
    const r = await s.admin('POST', `${s.F(s.failRun())}/analyse`)
    expect(r.body.analysis.recommendation).toBe('fix')
    expect(r.body.analysis.patch.sectionId).toBe('s-bbbbbb')
  })

  test('a bad patch is dropped and the recommendation becomes hold', async () => {
    const bad = [
      patchOf({ html: sec('s-bbbbbb', '<h2>x</h2><script>alert(1)</script>') }),
      patchOf({ html: sec('s-bbbbbb', '<h2 onclick="x()">x</h2>') }),
      patchOf({ artboardId: 999 }),
      patchOf({ sectionId: 's-zzzzzz', html: sec('s-zzzzzz') }),
    ]
    for (const patch of bad) {
      const s = await setup([answer({ patch })])
      const r = await s.admin('POST', `${s.F(s.failRun())}/analyse`)
      expect(r.status).toBe(200)
      expect(r.body.analysis.patch).toBeNull()
      expect(r.body.analysis.recommendation).toBe('hold')
      expect(r.body.analysis.note).toContain('patch was dropped')
      stop()
    }
  })

  test('a reply that breaks the schema is retried, then stored as failed', async () => {
    const junk: Reply = { kind: 'content', content: '{"issues":[]}' }
    const s = await setup([junk])
    const r = await s.admin('POST', `${s.F(s.failRun())}/analyse`)
    expect(r.status).toBe(200)
    expect(r.body.analysis.status).toBe('failed')
    expect(s.bodies().length).toBe(3)
  })

  test('analyse only drops the patch', async () => {
    const s = await setup([answer({ patch: patchOf() })])
    await s.setMode('analyse')
    const r = await s.admin('POST', `${s.F(s.failRun())}/analyse`)
    expect(r.body.analysis.patch).toBeNull()
    expect(r.body.analysis.note).toContain('no patch')
    expect(r.body.analysis.issues.length).toBe(1)
  })

  test('off refuses to analyse', async () => {
    const s = await setup([answer()])
    await s.setMode('off')
    const r = await s.admin('POST', `${s.F(s.failRun())}/analyse`)
    expect(r.status).toBe(409)
    expect(s.bodies().length).toBe(0)
  })
})

describe('two analyses per failing lineage', () => {
  test('the third gives 409 person-takes-over', async () => {
    const s = await setup([answer()])
    const id = s.failRun()
    expect((await s.admin('POST', `${s.F(id)}/analyse`)).body.analysis.attempt).toBe(1)
    expect((await s.admin('POST', `${s.F(id)}/analyse`)).body.analysis.attempt).toBe(2)
    const third = await s.admin('POST', `${s.F(id)}/analyse`)
    expect(third.status).toBe(409)
    expect(third.body.code).toBe('person-takes-over')
    expect(s.bodies().length).toBe(2)
  })

  test('a rerun belongs to the same lineage', async () => {
    const s = await setup([answer()])
    const a = s.failRun()
    const b = s.failRun({ rerunOf: a })
    await s.admin('POST', `${s.F(a)}/analyse`)
    await s.admin('POST', `${s.F(b)}/analyse`)
    const third = await s.admin('POST', `${s.F(a)}/analyse`)
    expect(third.status).toBe(409)
  })

  test('the next revision after a sent fix belongs to it', async () => {
    const s = await setup([answer({ patch: patchOf() })])
    const a = s.failRun({ rev: 'go-r1' })
    await s.admin('POST', `${s.F(a)}/analyse`)
    expect((await s.admin('POST', `${s.F(a)}/send-fix`)).status).toBe(200)
    const b = s.failRun({ rev: 'go-r2' })
    expect((await s.admin('POST', `${s.F(b)}/analyse`)).body.analysis.attempt).toBe(2)
    const c = s.failRun({ rev: 'go-r3' })
    expect((await s.admin('POST', `${s.F(c)}/analyse`)).status).toBe(409)
  })
})

describe('send fix and hold', () => {
  test('send-fix makes a take and no revision', async () => {
    const s = await setup([answer({ patch: patchOf() })])
    const id = s.failRun()
    await s.admin('POST', `${s.F(id)}/analyse`)
    const before = s.revisions()
    const takes = s.count('takes')
    const r = await s.admin('POST', `${s.F(id)}/send-fix`)
    expect(r.status).toBe(200)
    expect(r.body.analysis.status).toBe('sent')
    expect(r.body.analysis.takeId).toBeGreaterThan(0)
    expect(s.count('takes')).toBe(takes + 1)
    const take = s.db.query('select * from takes where id = ?').get(r.body.analysis.takeId) as Json
    expect(take.level).toBe('follow')
    expect(take.scope).toBe('s-bbbbbb')
    expect(take.applied).toBe(1)
    expect(s.revisions()).toBe(before)
    const art = await s.alex('GET', `/api/p/go/design/artboards/${s.board.id}`)
    expect(JSON.stringify(art.body)).toContain('index.html')
    // Sending twice is refused.
    expect((await s.admin('POST', `${s.F(id)}/send-fix`)).status).toBe(409)
  })

  test('send-fix on a locked section gives 409', async () => {
    const s = await setup([answer({ patch: patchOf() })])
    const id = s.failRun()
    await s.admin('POST', `${s.F(id)}/analyse`)
    const D = '/api/p/go/design'
    await s.alex('POST', `${D}/artboards`, {
      pageId: 'home',
      html: GOOD,
      css: CSS,
      description: 'x',
      role: 'state',
      kind: 'mobile',
      parentId: s.board.id,
    })
    for (const i of ITEMS)
      await s.alex('PUT', `${D}/sections/${s.board.id}/s-bbbbbb/check/${i}`, { on: true })
    expect((await s.alex('POST', `${D}/sections/${s.board.id}/s-bbbbbb/approve`)).status).toBe(200)
    const takes = s.count('takes')
    const r = await s.admin('POST', `${s.F(id)}/send-fix`)
    expect(r.status).toBe(409)
    expect(s.count('takes')).toBe(takes)
    expect((await s.admin('GET', s.F(id))).body.analysis.status).toBe('ready')
  })

  test('send-fix needs a patch', async () => {
    const s = await setup([answer()])
    const id = s.failRun()
    await s.admin('POST', `${s.F(id)}/analyse`)
    expect((await s.admin('POST', `${s.F(id)}/send-fix`)).status).toBe(409)
  })

  test('hold records the comment', async () => {
    const s = await setup([answer()])
    const id = s.failRun()
    await s.admin('POST', `${s.F(id)}/analyse`)
    const r = await s.admin('POST', `${s.F(id)}/hold`, { comment: 'I will look <b>myself</b>' })
    expect(r.status).toBe(200)
    expect(r.body.analysis.status).toBe('held')
    expect(r.body.analysis.comment).toBe('I will look <b>myself</b>')
    expect((await s.admin('GET', s.F(id))).body.analysis.status).toBe('held')
    expect((await s.admin('POST', `${s.F(id)}/hold`, { comment: '' })).status).toBe(400)
    expect((await s.admin('POST', `${s.F(id)}/hold`, { comment: 'x'.repeat(2001) })).status).toBe(
      400,
    )
  })

  test('hold works with no analysis and does not use up an analysis', async () => {
    const s = await setup([answer()])
    const id = s.failRun()
    const r = await s.admin('POST', `${s.F(id)}/hold`, { comment: 'Mine' })
    expect(r.body.analysis.status).toBe('held')
    expect(r.body.analysis.attempt).toBe(1)
    expect((await s.admin('POST', `${s.F(id)}/analyse`)).body.analysis.attempt).toBe(1)
  })
})

describe('who may', () => {
  test('Admin only', async () => {
    const s = await setup([answer({ patch: patchOf() })])
    const id = s.failRun()
    const calls: [string, string, Json?][] = [
      ['GET', '/api/admin/failures'],
      ['GET', s.F(id)],
      ['POST', `${s.F(id)}/analyse`],
      ['POST', `${s.F(id)}/send-fix`],
      ['POST', `${s.F(id)}/hold`, { comment: 'x' }],
    ]
    for (const [m, p, b] of calls) expect((await s.alex(m, p, b)).status).toBe(403)
    expect(s.bodies().length).toBe(0)
    const list = await s.admin('GET', '/api/admin/failures')
    expect(list.status).toBe(200)
    expect(list.body.failures[0].id).toBe(id)
    expect(list.body.failures[0].analysis).toBeNull()
  })

  test('a run that did not fail is not found', async () => {
    const s = await setup([answer()])
    const id = s.failRun({ failing: [], blocked: 0 })
    expect((await s.admin('GET', s.F(id))).status).toBe(404)
    expect((await s.admin('POST', `${s.F(id)}/analyse`)).status).toBe(404)
  })
})
