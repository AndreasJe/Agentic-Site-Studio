// M8 server side: model endpoints and roles, usage statistics and retention, the backups API, the
// setup checklist, the Projects overview and Project settings.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { openDb } from '../server/db/index.ts'
import type { Endpoint } from '../server/llm/llm.ts'
import { blockedAddress, endpointFor } from '../server/models/models.ts'
import { createProject } from '../server/store/revisions.ts'
import { applyUsageRetention, usageStats } from '../server/usage/stats.ts'
import { mockServer } from './llm/mock-server.ts'

const APP = 'http://localhost:3000'
const root = mkdtempSync(join(tmpdir(), 'studio-ops-'))
const dbs: { close(): void }[] = []
afterAll(() => {
  for (const d of dbs) d.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const OK = '{"ok":true}'

function world(
  fallback?: Endpoint,
  clock = { now: Date.parse('2026-10-22T10:00:00Z') },
  // The mock LLM listens on localhost; only the host-check tests turn this off.
  { localModelHosts = true } = {},
) {
  const dataDir = mkdtempSync(join(root, 'data-'))
  const db = openDb(join(dataDir, 'studio.sqlite'))
  dbs.push(db)
  seedTestAccounts(db)
  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir,
    llmEndpoint: fallback,
    now: () => clock.now,
    testOnly: { localModelHosts },
  })
  const as = (handle: string) => {
    const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
    const s = createSession(db, user.id, Date.now())
    return async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: {
          origin: APP,
          cookie: `${SESSION_COOKIE}=${s.id}`,
          'x-csrf-token': s.csrf,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      // biome-ignore lint/suspicious/noExplicitAny: test responses
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any }
    }
  }
  return { db, dataDir, ctx: { db, dataDir, instanceId: 'qw' }, as, clock }
}

describe('models', () => {
  test('endpoints are Admin only, and the key is sealed and never returned', async () => {
    const w = world()
    const admin = w.as('admina')
    expect((await w.as('alex')('GET', '/api/admin/models')).status).toBe(403)
    expect((await w.as('alex')('POST', '/api/admin/models', {})).status).toBe(403)
    const r = await admin('POST', '/api/admin/models', {
      name: 'main',
      baseUrl: 'http://localhost:9/v1/',
      model: 'm1',
      apiKey: 'sk-secret-123456',
    })
    expect(r.status).toBe(201)
    expect(r.body.endpoint.keySet).toBe(true)
    const list = await admin('GET', '/api/admin/models')
    expect(JSON.stringify(list.body)).not.toContain('sk-secret')
    expect(JSON.stringify(r.body)).not.toContain('sk-secret')
    const stored = w.db.query('select key_sealed from model_endpoints').get() as {
      key_sealed: string
    }
    expect(stored.key_sealed).toStartWith('v1:')
    expect(stored.key_sealed).not.toContain('sk-secret')
    expect(endpointFor(w.ctx, 'writer')?.apiKey).toBe('sk-secret-123456')
    expect((await admin('POST', '/api/admin/models', { name: 'main' })).status).toBe(400)
    expect(
      (
        await admin('POST', '/api/admin/models', {
          name: 'main',
          baseUrl: 'http://x.test',
          model: 'm',
        })
      ).status,
    ).toBe(409)
  })

  test('the .env endpoint is the default until an Admin adds one; roles map to endpoints', async () => {
    const fallback: Endpoint = {
      name: 'llm',
      baseUrl: 'http://env.test/v1',
      apiKey: 'env-key',
      model: 'env-model',
      capability: 'json_schema',
    }
    const w = world(fallback)
    const admin = w.as('admina')
    expect(endpointFor(w.ctx, 'critic', fallback)).toEqual(fallback)
    expect(endpointFor(w.ctx, 'critic')).toBeUndefined()
    const shown = await admin('GET', '/api/admin/models')
    expect(shown.body.fallback.model).toBe('env-model')
    expect(JSON.stringify(shown.body)).not.toContain('env-key')

    const a = await admin('POST', '/api/admin/models', {
      name: 'a',
      baseUrl: 'http://a.test/v1',
      model: 'ma',
    })
    const b = await admin('POST', '/api/admin/models', {
      name: 'b',
      baseUrl: 'http://b.test/v1',
      model: 'mb',
    })
    expect(endpointFor(w.ctx, 'critic', fallback)?.model).toBe('ma') // first added is the default
    const put = await admin('PUT', '/api/admin/models/roles', { critic: b.body.endpoint.id })
    expect(put.status).toBe(200)
    expect(endpointFor(w.ctx, 'critic', fallback)?.model).toBe('mb')
    expect(endpointFor(w.ctx, 'writer', fallback)?.model).toBe('ma')
    expect((await admin('PUT', '/api/admin/models/roles', { nobody: 1 })).status).toBe(400)
    expect((await admin('PUT', '/api/admin/models/roles', { critic: 999 })).status).toBe(404)
    // Removing an endpoint clears its roles.
    await admin('DELETE', `/api/admin/models/${b.body.endpoint.id}`)
    expect(endpointFor(w.ctx, 'critic', fallback)?.model).toBe('ma')
    expect(a.status).toBe(201)
  })

  test('test connection detects json_schema, then json_object, then none', async () => {
    const cases: [string, Parameters<typeof mockServer>[0], string, number][] = [
      ['schema', [{ kind: 'content', content: OK }], 'json_schema', 1],
      [
        'object',
        [
          { kind: 'status', status: 400 },
          { kind: 'content', content: OK },
        ],
        'json_object',
        2,
      ],
      [
        'none',
        [
          { kind: 'status', status: 400 },
          { kind: 'status', status: 422 },
          { kind: 'content', content: OK },
        ],
        'none',
        3,
      ],
    ]
    for (const [name, script, expected, calls] of cases) {
      const mock = mockServer(script)
      try {
        const w = world()
        const admin = w.as('admina')
        const e = await admin('POST', '/api/admin/models', {
          name,
          baseUrl: mock.baseUrl,
          model: 'm',
          apiKey: 'k',
        })
        const t = await admin('POST', `/api/admin/models/${e.body.endpoint.id}/test`)
        expect(t.body.result.ok).toBe(true)
        expect(t.body.result.detected).toBe(expected as never)
        expect(mock.bodies.length).toBe(calls)
        const row = (await admin('GET', '/api/admin/models')).body.endpoints[0]
        expect(row.capability).toBe(expected as never)
        expect(row.lastTestOk).toBe(true)
      } finally {
        mock.stop()
      }
    }
  })

  test('a refused key stops the test; an override keeps its capability', async () => {
    const mock = mockServer([{ kind: 'status', status: 401 }])
    const ok = mockServer([{ kind: 'content', content: OK }])
    try {
      const w = world()
      const admin = w.as('admina')
      const bad = await admin('POST', '/api/admin/models', {
        name: 'bad',
        baseUrl: mock.baseUrl,
        model: 'm',
      })
      const t = await admin('POST', `/api/admin/models/${bad.body.endpoint.id}/test`)
      expect(t.body.result.ok).toBe(false)
      expect(t.body.result.error).toContain('401')
      expect(mock.bodies.length).toBe(1)

      const o = await admin('POST', '/api/admin/models', {
        name: 'forced',
        baseUrl: ok.baseUrl,
        model: 'm',
        capability: 'json_object',
      })
      const t2 = await admin('POST', `/api/admin/models/${o.body.endpoint.id}/test`)
      expect(t2.body.result.detected).toBe('json_schema')
      expect(t2.body.result.capability).toBe('json_object')
      expect(endpointFor(w.ctx, 'writer', undefined)?.name).toBe('bad') // first added
    } finally {
      mock.stop()
      ok.stop()
    }
  })
})

describe('models: review finding 5', () => {
  type As = ReturnType<ReturnType<typeof world>['as']>
  const add = async (admin: As, baseUrl: string, name = 'e') =>
    (await admin('POST', '/api/admin/models', { name, baseUrl, model: 'm', apiKey: 'sk-old' })).body
      .endpoint

  test('a new origin clears the stored key unless a new one comes with it', async () => {
    const w = world()
    const admin = w.as('admina')
    const e = await add(admin, 'https://a.example/v1')
    const put = (b: unknown) => admin('PUT', `/api/admin/models/${e.id}`, b)
    // The same origin, another path: the key stays.
    expect((await put({ baseUrl: 'https://a.example/v2' })).body.endpoint.keySet).toBe(true)
    expect(endpointFor(w.ctx, 'writer')?.apiKey).toBe('sk-old')
    // Another origin: the key is never sent there.
    expect((await put({ baseUrl: 'https://b.example/v2' })).body.endpoint.keySet).toBe(false)
    expect(endpointFor(w.ctx, 'writer')?.apiKey).toBe('')
    const both = await put({ baseUrl: 'https://c.example/v1', apiKey: 'sk-new' })
    expect(both.body.endpoint.keySet).toBe(true)
    expect(endpointFor(w.ctx, 'writer')?.apiKey).toBe('sk-new')
    // A scheme or port is part of the origin too.
    expect((await put({ baseUrl: 'http://c.example/v1' })).body.endpoint.keySet).toBe(false)
  })

  test('Test connection refuses loopback, link-local and metadata hosts', async () => {
    const mock = mockServer([{ kind: 'content', content: OK }])
    try {
      const w = world(undefined, undefined, { localModelHosts: false })
      const admin = w.as('admina')
      const port = new URL(mock.baseUrl).port
      const hosts = [
        mock.baseUrl,
        `http://127.0.0.1:${port}/v1`,
        `http://127.9.9.9:${port}/v1`,
        `http://[::1]:${port}/v1`,
        `http://0x7f000001:${port}/v1`,
        `http://[::ffff:127.0.0.1]:${port}/v1`,
        `http://0.0.0.0:${port}/v1`,
        'http://169.254.169.254/latest',
        'http://169.254.1.1/v1',
        'http://[fe80::1]/v1',
        'http://[fd00:ec2::254]/v1',
        'http://metadata.google.internal/v1',
        'http://metadata/v1',
        'http://app.localhost/v1',
        'http://localhost./v1',
      ]
      for (const [i, baseUrl] of hosts.entries()) {
        // Saving one is refused now (decision #50, item 13); one saved before that still can't
        // be tested.
        const saved = await admin('POST', '/api/admin/models', {
          name: `h${i}`,
          baseUrl,
          model: 'm',
        })
        expect([baseUrl, saved.body.code]).toEqual([baseUrl, 'blocked-host'])
        const e = w.db
          .query(
            "insert into model_endpoints (name, base_url, model, capability, capability_override, created_by, created_at) values (?, ?, 'm', 'json_schema', 0, 'admina', ?) returning id",
          )
          .get(`h${i}`, baseUrl, new Date().toISOString()) as { id: number }
        const t = await admin('POST', `/api/admin/models/${e.id}/test`)
        expect(t.status).toBe(200)
        expect([baseUrl, t.body.result]).toMatchObject([
          baseUrl,
          { ok: false, detected: null, refused: 'blocked-host' },
        ])
      }
      expect(mock.bodies.length).toBe(0)
    } finally {
      mock.stop()
    }
  })

  test('the address checks: public and private-network addresses pass', () => {
    for (const ip of ['8.8.8.8', '10.0.0.5', '192.168.1.10', '[2001:db8::1]', '::ffff:8.8.8.8'])
      expect([ip, blockedAddress(ip)]).toEqual([ip, false])
    for (const ip of ['127.0.0.1', '169.254.169.254', '::1', '::', '[::ffff:7f00:1]', 'fe80::9'])
      expect([ip, blockedAddress(ip)]).toEqual([ip, true])
  })

  test('the .env endpoint’s own origin may be tested, even on localhost', async () => {
    const mock = mockServer([{ kind: 'content', content: OK }])
    try {
      const fallback: Endpoint = {
        name: 'llm',
        baseUrl: mock.baseUrl,
        apiKey: '',
        model: 'env',
        capability: 'json_schema',
      }
      const w = world(fallback, undefined, { localModelHosts: false })
      const admin = w.as('admina')
      const e = await add(admin, mock.baseUrl)
      const t = await admin('POST', `/api/admin/models/${e.id}/test`)
      expect(t.body.result).toMatchObject({ ok: true, detected: 'json_schema', refused: null })
      expect(mock.bodies.length).toBe(1)
    } finally {
      mock.stop()
    }
  })

  test('Test connection returns the status and capability, never the reply bytes', async () => {
    const mock = mockServer([{ kind: 'status', status: 401 }]) // its body is "boom"
    try {
      const w = world()
      const admin = w.as('admina')
      const e = await add(admin, mock.baseUrl)
      const t = await admin('POST', `/api/admin/models/${e.id}/test`)
      expect(t.body.result).toMatchObject({ ok: false, status: 401, detected: null })
      expect(JSON.stringify(t.body)).not.toContain('boom')
      const row = (await admin('GET', '/api/admin/models')).body.endpoints[0]
      expect(JSON.stringify(row)).not.toContain('boom')
      expect(row.lastTestError).toContain('401')
    } finally {
      mock.stop()
    }
  })
})

function addUsage(
  w: ReturnType<typeof world>,
  at: string,
  user: string | null,
  project: string,
  input = 100,
) {
  w.db
    .query(
      `insert into usage (call_id, attempt, status, project, phase, user, model_role, input_tokens, output_tokens, cached_tokens, at)
       values (?, 1, 'ok', ?, 'brief', ?, 'writer', ?, 20, 5, ?)`,
    )
    .run(crypto.randomUUID(), project, user, input, at)
}

describe('usage', () => {
  test('per-person figures: that person and Admins only; project figures for members', async () => {
    const w = world()
    createProject(w.ctx, { name: 'Alpha', by: 'alex' })
    addUsage(w, '2026-10-20T10:00:00Z', 'alex', 'alpha')
    addUsage(w, '2026-10-20T11:00:00Z', 'rune', 'alpha', 50)
    const alex = w.as('alex')
    expect((await alex('GET', '/api/usage/person/alex')).body.stats.totals.inputTokens).toBe(100)
    expect((await alex('GET', '/api/usage/person/rune')).status).toBe(403)
    expect((await w.as('admina')('GET', '/api/usage/person/rune')).body.stats.totals.calls).toBe(1)
    // Site statistics are Admin only; a project's figures are not split by person.
    expect((await alex('GET', '/api/admin/usage')).status).toBe(403)
    const site = await w.as('admina')('GET', '/api/admin/usage')
    expect(site.body.stats.totals.inputTokens).toBe(150)
    expect(site.body.stats.byProject[0].project).toBe('alpha')
    const p = await alex('GET', '/api/p/alpha/usage')
    expect(p.status).toBe(200)
    expect(p.body.stats.totals.calls).toBe(2)
    expect(JSON.stringify(p.body)).not.toContain('rune')
  })

  test('retention aggregates per-person rows into daily project totals, then deletes them', async () => {
    const clock = { now: Date.parse('2026-10-22T10:00:00Z') }
    const w = world(undefined, clock)
    createProject(w.ctx, { name: 'Alpha', by: 'alex' })
    addUsage(w, '2026-06-01T09:00:00Z', 'alex', 'alpha', 100)
    addUsage(w, '2026-06-01T15:00:00Z', 'rune', 'alpha', 40)
    addUsage(w, '2026-06-02T09:00:00Z', 'alex', 'alpha', 10)
    addUsage(w, '2026-10-21T09:00:00Z', 'alex', 'alpha', 7) // recent: stays
    const before = usageStats(w.db, { project: 'alpha' })
    expect(before.totals.inputTokens).toBe(157)

    const r = applyUsageRetention(w.db, () => clock.now)
    expect(r.days).toBe(90)
    expect(r.deleted).toBe(3)
    const after = usageStats(w.db, { project: 'alpha' })
    expect(after.totals).toEqual(before.totals) // totals kept
    expect(after.byDay.map((d) => d.day)).toEqual(before.byDay.map((d) => d.day))
    // The old per-person rows are gone; only the recent one is left to a person.
    expect(usageStats(w.db, { user: 'rune' }).totals.calls).toBe(0)
    expect(usageStats(w.db, { user: 'alex' }).totals.inputTokens).toBe(7)
    expect((w.db.query('select count(*) as n from usage').get() as { n: number }).n).toBe(1)
    // Running again changes nothing.
    expect(applyUsageRetention(w.db, () => clock.now).deleted).toBe(0)
    expect(usageStats(w.db, { project: 'alpha' }).totals).toEqual(before.totals)
    // A month later the recent row ages out too, with the same total.
    clock.now = Date.parse('2027-02-01T00:00:00Z')
    applyUsageRetention(w.db, () => clock.now)
    expect(usageStats(w.db, { project: 'alpha' }).totals.inputTokens).toBe(157)
    expect((w.db.query('select count(*) as n from usage').get() as { n: number }).n).toBe(0)
  })

  test('the retention period is a setting, changed by an Admin only', async () => {
    const w = world()
    expect((await w.as('alex')('PUT', '/api/admin/usage/retention', { days: 30 })).status).toBe(403)
    const admin = w.as('admina')
    expect((await admin('PUT', '/api/admin/usage/retention', { days: 0 })).status).toBe(400)
    expect((await admin('PUT', '/api/admin/usage/retention', { days: 30 })).body.days).toBe(30)
    expect((await admin('GET', '/api/admin/usage/retention')).body.days).toBe(30)
  })
})

describe('backups API', () => {
  const PASS = 'a long passphrase here'

  test('settings, run, list and restore into a new copy; the passphrase is never kept', async () => {
    const w = world()
    createProject(w.ctx, { name: 'Alpha', by: 'alex' })
    const admin = w.as('admina')
    const dir = join(root, 'backup-target')
    expect((await w.as('alex')('GET', '/api/admin/backups')).status).toBe(403)

    expect((await admin('POST', '/api/admin/backups/run', { passphrase: PASS })).status).toBe(409) // no target
    // A target inside the data folder is no backup; a relative path is refused.
    for (const path of [join(w.dataDir, 'b'), 'relative/dir']) {
      expect(
        (await admin('PUT', '/api/admin/backups/settings', { target: { kind: 'folder', path } }))
          .status,
      ).toBe(400)
    }
    const set = await admin('PUT', '/api/admin/backups/settings', {
      target: { kind: 'folder', path: dir },
      scope: { kind: 'all' },
      intervalHours: 24,
      keepLast: 3,
    })
    expect(set.status).toBe(200)
    expect(set.body.schedule.intervalHours).toBe(24)
    expect(
      (await admin('PUT', '/api/admin/backups/settings', { scope: { kind: 'project', id: 'zz' } }))
        .status,
    ).toBe(404)

    expect((await admin('POST', '/api/admin/backups/run', { passphrase: 'short' })).status).toBe(
      400,
    )
    const run = await admin('POST', '/api/admin/backups/run', { passphrase: PASS })
    expect(run.status).toBe(200)
    const list = await admin('GET', '/api/admin/backups')
    expect(list.body.backups.length).toBe(1)
    expect(list.body.backups[0].name).toBe(run.body.result.name)
    expect(list.body.lastResult.ok).toBe(true)

    const dest = join(root, 'restored-copy')
    const bad = await admin('POST', '/api/admin/backups/restore', {
      name: run.body.result.name,
      passphrase: 'not the passphrase',
      destDir: dest,
    })
    expect(bad.status).toBe(422)
    expect(existsSync(dest)).toBe(false)
    const ok = await admin('POST', '/api/admin/backups/restore', {
      name: run.body.result.name,
      passphrase: PASS,
      destDir: dest,
    })
    expect(ok.status).toBe(200)
    expect(existsSync(join(dest, 'studio.sqlite'))).toBe(true)
    expect(existsSync(join(dest, 'alpha', 'project.json'))).toBe(true)
    // The destination must not exist; the data folder is off limits.
    const again = await admin('POST', '/api/admin/backups/restore', {
      name: run.body.result.name,
      passphrase: PASS,
      destDir: dest,
    })
    expect(again.status).toBe(409)
    const inside = await admin('POST', '/api/admin/backups/restore', {
      name: run.body.result.name,
      passphrase: PASS,
      destDir: join(w.dataDir, 'copy'),
    })
    expect(inside.status).toBe(400)

    // The passphrase is nowhere in the database, settings or audit log.
    for (const t of ['settings', 'audit_log', 'inbox_items'])
      expect(JSON.stringify(w.db.query(`select * from ${t}`).all())).not.toContain(PASS)
  })

  test('rclone says it needs rclone', async () => {
    const w = world()
    const admin = w.as('admina')
    await admin('PUT', '/api/admin/backups/settings', {
      target: { kind: 'rclone', remote: 'azure:b' },
    })
    const list = await admin('GET', '/api/admin/backups')
    expect(list.body.needsRclone).toBe(true)
    expect((await admin('POST', '/api/admin/backups/run', { passphrase: PASS })).status).toBe(409)
    expect(w.db.query("select 1 from inbox_items where kind = 'backup-failed'").get()).toBeTruthy()
  })
})

describe('setup and projects', () => {
  test('the checklist comes from real state', async () => {
    const w = world()
    const admin = w.as('admina')
    expect((await w.as('alex')('GET', '/api/admin/setup')).status).toBe(403)
    const done = async () =>
      Object.fromEntries(
        (
          (await admin('GET', '/api/admin/setup')).body.items as { id: string; done: boolean }[]
        ).map((i) => [i.id, i.done]),
      )
    const first = await done()
    expect(Object.values(first).some(Boolean)).toBe(false)
    expect(Object.keys(first)).toContain('backup-run')

    const mock = mockServer([{ kind: 'content', content: OK }])
    try {
      const e = await admin('POST', '/api/admin/models', {
        name: 'm',
        baseUrl: mock.baseUrl,
        model: 'x',
      })
      expect((await done())['model-endpoint-tested']).toBe(false)
      await admin('POST', `/api/admin/models/${e.body.endpoint.id}/test`)
      expect((await done())['model-endpoint-tested']).toBe(true)
    } finally {
      mock.stop()
    }
    await admin('PUT', '/api/mail/settings', {
      host: 'mail.test',
      port: 25,
      security: 'none',
      user: '',
      from: 'studio@example.test',
    })
    expect((await done()).mail).toBe(true)
    await admin('PUT', '/api/admin/backups/settings', {
      target: { kind: 'folder', path: join(root, 'setup-backups') },
    })
    expect((await done())['backup-target']).toBe(true)
    expect((await done())['backup-run']).toBe(false)
    await admin('POST', '/api/admin/backups/run', { passphrase: 'a long passphrase here' })
    expect((await done())['backup-run']).toBe(true)
    w.db
      .query('insert into guide_versions (n, by_user, at, summary) values (2, null, ?, ?)')
      .run('now', 'v2')
    expect((await done())['guide-version']).toBe(true)
    for (const i of (await admin('GET', '/api/admin/setup')).body.items)
      expect(i.link).toStartWith('/')
  })

  test('projects overview and project settings (stricter only)', async () => {
    const w = world()
    createProject(w.ctx, { name: 'Alpha', by: 'alex' })
    const admin = w.as('admina')
    const o = await admin('GET', '/api/admin/projects')
    expect(o.body.projects[0]).toMatchObject({
      id: 'alpha',
      name: 'Alpha',
      staged: null,
      published: null,
    })
    expect(o.body.projects[0].members.map((m: { handle: string }) => m.handle)).toEqual(['alex'])
    expect((await w.as('alex')('GET', '/api/admin/projects')).status).toBe(403)
    expect((await w.as('alex')('GET', '/api/p/alpha/settings')).status).toBe(403)
    expect((await admin('GET', '/api/p/nope/settings')).status).toBe(404)

    const s = await admin('PUT', '/api/p/alpha/settings', {
      structureNeedsAdmin: true,
      twoPerson: { releases: 2 },
      members: ['alex', 'rune'],
    })
    expect(s.status).toBe(200)
    expect(s.body.settings.twoPerson).toEqual({ releases: 2 })
    expect(s.body.members.length).toBe(2)
    expect((await admin('GET', '/api/p/alpha/settings')).body.settings.structureNeedsAdmin).toBe(
      true,
    )
    for (const bad of [
      { members: ['nobody'] },
      { twoPerson: { releases: 3 } },
      { twoPerson: { other: 2 } },
      { checks: { nonsense: 'block' } },
    ])
      expect((await admin('PUT', '/api/p/alpha/settings', bad)).status).toBe(400)
    // Never looser than the install: the install starts every check on block.
    expect((await admin('PUT', '/api/p/alpha/settings', { checks: { axe: 'warn' } })).status).toBe(
      400,
    )
  })
})
