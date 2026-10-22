// Decision #50 (the user's answers of 22 Oct), the security items: the maintenance command (2),
// a refused lowering restores the stricter rule (4), inbox clean-up after the outbox result (10),
// and the endpoint host rule on save (13). The address step-up (5) is in address-languages.test.ts.
// End to end in one process: the app → FolderTransport → the real production agent → the poller.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { openDb } from '../server/db/index.ts'
import { pollAll } from '../server/deploy/outbox.ts'
import type { Endpoint } from '../server/llm/llm.ts'
import { type Fixture, type Json, releaseFixture } from './helpers/release-fixture.ts'

let f: Fixture | undefined
afterEach(async () => {
  await f?.cleanup()
  f = undefined
})

const scan = async (x: Fixture) => {
  await x.agent.scan()
  await pollAll(x.ctx)
}

/** Like the transport: a temp name, then a rename. */
const put = (dir: string, name: string, data: string) => {
  writeFileSync(join(dir, `.tmp-${name}`), data)
  renameSync(join(dir, `.tmp-${name}`), join(dir, name))
}

/** A command or governance signing request, signed by each Admin in turn. */
async function signAll(x: Fixture, start: { status: number; body: Json }, who: string[]) {
  expect(start.status).toBe(201)
  let last: { status: number; body: Json } = start
  for (const h of who) {
    const options =
      h === who[0]
        ? start.body
        : (await x.as(h)('GET', `/api/admin/signing/${start.body.signingId}`)).body.options
    last = await x.as(h)(
      'POST',
      `/api/admin/signing/${start.body.signingId}/sign`,
      await x.sign(h, options.publicKey),
    )
    if (last.status !== 200) return last
  }
  return last
}

const inboxOf = (x: Fixture) => readdirSync(x.inbox).filter((n) => !n.startsWith('.tmp-'))
/** What the app sent: the inbox without the pairing file the fixture wrote itself. */
const sentFiles = (x: Fixture) => inboxOf(x).filter((n) => n !== 'cmd-1.json')
const auditActions = (x: Fixture) =>
  (x.db.query('select action from audit_log order by id').all() as { action: string }[]).map(
    (r) => r.action,
  )
const inboxItems = (x: Fixture) =>
  x.db.query('select kind, ref, title from inbox_items where done_at is null').all() as {
    kind: string
    ref: string
    title: string
  }[]
const policyOf = async (x: Fixture) =>
  (await x.as('admina')('GET', '/api/admin/governance')).body.policy as Json

// ---- item 2: the maintenance page ------------------------------------------------------------

describe('maintenance command', () => {
  test('a Creator gets 403 and nothing reaches production', async () => {
    f = await releaseFixture()
    for (const on of [true, false]) {
      const r = await f.alex('POST', '/api/admin/commands/production/maintenance', { on })
      expect(r.status).toBe(403)
    }
    expect(
      f.db.query("select count(*) as n from signing_requests where kind = 'command'").get(),
    ).toEqual({ n: 0 })
    expect(sentFiles(f)).toEqual([])
  })

  test('it needs an Admin passkey; once signed it is sent and production shows the page', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    for (const bad of [{}, { on: 'yes' }, { on: 1 }, { on: null }]) {
      const r = await a('POST', '/api/admin/commands/production/maintenance', bad)
      expect(r).toMatchObject({ status: 400, body: { code: 'bad-on' } })
    }
    expect((await a('POST', '/api/admin/commands/nowhere/maintenance', { on: true })).status).toBe(
      404,
    )

    const start = await a('POST', '/api/admin/commands/production/maintenance', { on: true })
    expect(start.status).toBe(201)
    expect(start.body).toMatchObject({ purpose: 'maintenance-on', needed: 1 })
    expect(Buffer.from(start.body.publicKey.challenge, 'base64url').subarray(0, 4).toString()).toBe(
      'cmd1',
    )
    // Nothing is sent until an Admin's passkey signs it; no signature, or a bad one, sends nothing.
    expect(sentFiles(f)).toEqual([])
    const sign = (body: unknown) =>
      a('POST', `/api/admin/signing/${start.body.signingId}/sign`, body)
    expect((await sign({})).body.code).toBe('malformed')
    expect(
      (await sign(await f.sign('admina', start.body.publicKey, { uv: false }))).body.code,
    ).toBe('user-not-verified')
    expect(
      (await f.alex('POST', `/api/admin/signing/${start.body.signingId}/sign`, {})).status,
    ).toBe(403)
    expect(sentFiles(f)).toEqual([])

    const ok = await sign(await f.sign('admina', start.body.publicKey))
    expect(ok.body).toMatchObject({ complete: true, sent: true })
    const name = sentFiles(f)[0] as string
    const cmd = JSON.parse(readFileSync(join(f.inbox, name), 'utf8'))
    expect(cmd).toMatchObject({ command: 'maintenance', target: 'production', args: { on: true } })
    expect(cmd.signatures).toEqual([expect.objectContaining({ by: 'admin-passkey' })])
    // The one counter (#26): the next number after the pairing file.
    expect(cmd.sequence).toBe(f.agent.snapshot().trust.lastSequence + 1)

    await scan(f)
    expect(f.agent.snapshot().trust.maintenance).toBe(true)
    f.agent.heartbeat()
    await pollAll(f.ctx)
    const view = (await a('GET', '/api/admin/commands/production')).body
    expect(view.heartbeat).toMatchObject({ maintenance: true, frozen: false })
    expect(view.commands[0]).toMatchObject({ purpose: 'maintenance-on', status: 'accepted' })
    expect(auditActions(f)).toContain('command-maintenance-on')
  })

  test('it works while frozen, and freeze alone keeps the site serving', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    expect((await a('POST', '/api/admin/commands/production/freeze')).status).toBe(200)
    await scan(f)
    expect(f.agent.snapshot().trust).toMatchObject({ frozen: true })
    expect(f.agent.snapshot().trust.maintenance ?? false).toBe(false)

    const on = await signAll(
      f,
      await a('POST', '/api/admin/commands/production/maintenance', { on: true }),
      ['admina'],
    )
    expect(on.body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust).toMatchObject({ frozen: true, maintenance: true })

    const off = await signAll(
      f,
      await f.as('adminb')('POST', '/api/admin/commands/production/maintenance', { on: false }),
      ['adminb'],
    )
    expect(off.body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust).toMatchObject({ frozen: true, maintenance: false })
    f.agent.heartbeat()
    await pollAll(f.ctx)
    expect((await a('GET', '/api/admin/commands/production')).body.heartbeat).toMatchObject({
      frozen: true,
      maintenance: false,
    })
  })
})

// ---- item 4: a lowering production refused restores the stricter rule -------------------------

const STRICT = { releases: 2, keys: 2, domains: 2 } as const
const SMALL = { releases: 1, keys: 1, domains: 1 } as const

/** A lowering from strict to small team, signed by both Admins and delivered; not scanned yet. */
async function deliveredLowering(x: Fixture) {
  const down = await x.as('admina')('POST', '/api/admin/governance/policy', {
    preset: 'small-team',
  })
  expect(down.body.needed).toBe(2)
  const r = await signAll(x, down, ['admina', 'adminb'])
  expect(r.body.sent).toBe(true)
  // It counts in the app once delivered (finding 6).
  expect(await policyOf(x)).toEqual(SMALL)
  const row = x.db
    .query('select id, number from signing_requests where id = ?')
    .get(down.body.signingId) as { id: number; number: number }
  return { ...row, name: `cmd-${row.number}.json` }
}

describe('a refused lowering', () => {
  test('production refuses it: the app restores the stricter rule, audits it and tells the Admins', async () => {
    f = await releaseFixture({ policy: STRICT })
    const low = await deliveredLowering(f)
    // Production refuses it (here: the file was damaged on the way, so a signature fails).
    const file = join(f.inbox, low.name)
    const cmd = JSON.parse(readFileSync(file, 'utf8'))
    cmd.signatures[0].signature = cmd.signatures[1].signature
    put(f.inbox, low.name, JSON.stringify(cmd))
    await scan(f)
    expect(JSON.parse(readFileSync(join(f.outbox, 'results', low.name), 'utf8')).ok).toBe(false)
    expect(f.agent.snapshot().trust.policy).toEqual(STRICT)
    // No signatures needed to go back: stricter is safe.
    expect(await policyOf(f)).toEqual(STRICT)
    expect(auditActions(f)).toContain('policy-restored')
    expect(inboxItems(f).map((i) => i.kind)).toContain('policy-restored')
    // A release now needs two Admins again in the app as well.
    const { requestId } = await f.stageAndRequest()
    const ch = await f.as('admina')('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.body.needed).toBe(2)
  })

  test('only a refusal of that exact signed request restores; forged or unrelated results change nothing', async () => {
    f = await releaseFixture({ policy: STRICT })
    const low = await deliveredLowering(f)
    const results = join(f.outbox, 'results')
    mkdirSync(results, { recursive: true })
    const forged = (name: string, body: Record<string, unknown>) =>
      put(
        results,
        name,
        JSON.stringify({ file: name, kind: 'command', at: new Date().toISOString(), ...body }),
      )

    // A refusal for a number this app never sent.
    forged(`cmd-${low.number + 5}.json`, { ok: false, code: 'bad-signature' })
    // A result that names another file than the one it is stored as.
    put(results, low.name, JSON.stringify({ file: 'cmd-999.json', ok: false, code: 'replayed' }))
    // A malformed one, and one with an unknown code shape.
    put(results, `cmd-${low.number + 6}.json`, '{not json')
    await pollAll(f.ctx)
    expect(await policyOf(f)).toEqual(SMALL)
    expect(auditActions(f)).not.toContain('policy-restored')

    // Production accepts the real file; a refusal forged afterwards changes nothing either.
    rmSync(join(results, low.name))
    await scan(f)
    expect(f.agent.snapshot().trust.policy).toEqual(SMALL)
    expect(await policyOf(f)).toEqual(SMALL)
    forged(low.name, { ok: false, code: 'not-enough-signers' })
    await pollAll(f.ctx)
    expect(await policyOf(f)).toEqual(SMALL)
    expect(auditActions(f)).not.toContain('policy-restored')
  })

  test('a refused raise or another refused command restores nothing', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    const up = await a('POST', '/api/admin/governance/policy', { preset: 'standard' })
    expect((await signAll(f, up, ['admina'])).body.sent).toBe(true)
    const row = f.db
      .query('select number from signing_requests where id = ?')
      .get(up.body.signingId) as { number: number }
    const name = `cmd-${row.number}.json`
    const cmd = JSON.parse(readFileSync(join(f.inbox, name), 'utf8'))
    cmd.signatures[0].signature = 'AAAA'
    put(f.inbox, name, JSON.stringify(cmd))
    await scan(f)
    expect(JSON.parse(readFileSync(join(f.outbox, 'results', name), 'utf8')).ok).toBe(false)
    // The raise counted in the app on delivery and stays: stricter is safe.
    expect(await policyOf(f)).toEqual({ releases: 1, keys: 2, domains: 2 })
    expect(auditActions(f)).not.toContain('policy-restored')
  })
})

// ---- item 10: the app clears handled inbox files ----------------------------------------------

describe('inbox clean-up', () => {
  test('a release and a command are removed only after production’s result for that name', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    const admin = f.as('admina')
    const ch = await admin('POST', `/api/admin/review/${requestId}/challenge`)
    const signed = await admin(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    expect(signed.body.sent).toBe(true)
    expect(sentFiles(f)).toEqual(['release-1.json', 'release-1.tar'])
    // No result yet: polling removes nothing.
    await pollAll(f.ctx)
    await pollAll(f.ctx)
    expect(sentFiles(f)).toEqual(['release-1.json', 'release-1.tar'])

    await f.agent.scan()
    expect(existsSync(join(f.outbox, 'results', 'release-1.json'))).toBe(true)
    expect(sentFiles(f)).toEqual(['release-1.json', 'release-1.tar'])
    await pollAll(f.ctx)
    // The result is there: the release file and its bundle go; the result stays in the outbox.
    expect(sentFiles(f)).toEqual([])
    expect(existsSync(join(f.outbox, 'results', 'release-1.json'))).toBe(true)
    expect(f.agent.snapshot().active).toBe(1)
    // The agent forgets what was cleared away and nothing is handled twice.
    await f.agent.scan()
    expect(f.agent.snapshot().processed['release-1.json']).toBeUndefined()
    expect(f.agent.snapshot().trust.highestRelease).toBe(1)

    // A command: the same.
    const freeze = await admin('POST', '/api/admin/commands/production/freeze')
    const name = `cmd-${freeze.body.sequence}.json`
    await pollAll(f.ctx)
    expect(sentFiles(f)).toEqual([name])
    await scan(f)
    expect(sentFiles(f)).toEqual([])
    expect(f.agent.snapshot().trust.frozen).toBe(true)
    expect(auditActions(f)).toContain('inbox-cleared')
  })

  test('a pairing file waiting for its fingerprint stays until production accepts it', async () => {
    f = await releaseFixture({ pair: false })
    const first = f.admins.admina as NonNullable<Fixture['admins'][string]>
    const { unsigned, challenge } = await f.pairStart()
    const a = await f.sign('admina', { challenge })
    f.db
      .query('update passkeys set sign_count = ? where id = ?')
      .run(first.auth.signCount, first.keyId)
    const name = `cmd-${unsigned.sequence}.json`
    put(
      f.inbox,
      name,
      JSON.stringify({
        ...unsigned,
        signatures: [{ by: 'admin-passkey', adminKeyId: first.keyId, ...a.response }],
      }),
    )
    await scan(f)
    expect(JSON.parse(readFileSync(join(f.outbox, 'results', name), 'utf8')).code).toBe(
      'fingerprint-not-confirmed',
    )
    await pollAll(f.ctx)
    expect(inboxOf(f)).toEqual([name])
  })

  test('a result for a name that is not in the inbox, or an outbox file, removes nothing else', async () => {
    f = await releaseFixture()
    const results = join(f.outbox, 'results')
    mkdirSync(results, { recursive: true })
    put(f.inbox, 'cmd-50.json', '{}')
    put(
      results,
      'cmd-51.json',
      JSON.stringify({ file: 'cmd-51.json', ok: false, code: 'malformed' }),
    )
    put(results, 'release-52.json', JSON.stringify({ file: 'release-52.json', ok: true }))
    await pollAll(f.ctx)
    expect(inboxOf(f)).toContain('cmd-50.json')
    // The outbox is production's: the app never removes from it.
    expect(readdirSync(results).sort()).toEqual(['cmd-1.json', 'cmd-51.json', 'release-52.json'])
    expect(existsSync(join(f.outbox, 'heartbeat.json'))).toBe(true)
  })
})

// ---- item 13: the internal-address block applies when an endpoint is saved --------------------

const APP = 'http://localhost:3000'
const roots: string[] = []
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function modelsWorld(fallback?: Endpoint, localModelHosts = false) {
  const root = mkdtempSync(join(tmpdir(), 'studio-d50-'))
  roots.push(root)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir: root,
    llmEndpoint: fallback,
    testOnly: { localModelHosts },
  })
  const user = db.query("select id from users where handle = 'admina'").get() as { id: number }
  const s = createSession(db, user.id, Date.now())
  const call = async (method: string, path: string, body?: unknown) => {
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
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
  }
  return { db, call }
}

const BLOCKED = [
  'http://localhost:8080/v1',
  'http://127.0.0.1:11434/v1',
  'http://[::1]/v1',
  'http://0x7f000001/v1',
  'http://[::ffff:127.0.0.1]/v1',
  'http://0.0.0.0/v1',
  'http://169.254.169.254/latest',
  'http://[fe80::1]/v1',
  'http://[fd00:ec2::254]/v1',
  'http://metadata.google.internal/v1',
  'http://app.localhost/v1',
]

describe('endpoint save block', () => {
  test('creating an endpoint at a local, link-local or metadata address is refused', async () => {
    const w = modelsWorld()
    for (const baseUrl of BLOCKED) {
      const r = await w.call('POST', '/api/admin/models', { name: 'x', baseUrl, model: 'm' })
      expect([baseUrl, r.status, r.body.code]).toEqual([baseUrl, 400, 'blocked-host'])
    }
    expect(w.db.query('select count(*) as n from model_endpoints').get()).toEqual({ n: 0 })
    // Public and private-network addresses are fine.
    for (const [i, baseUrl] of ['http://8.8.8.8/v1', 'http://10.0.0.5:8000/v1'].entries()) {
      const r = await w.call('POST', '/api/admin/models', { name: `ok${i}`, baseUrl, model: 'm' })
      expect([baseUrl, r.status]).toEqual([baseUrl, 201])
    }
  })

  test('changing the base URL to a blocked address is refused; other changes are not checked', async () => {
    const w = modelsWorld()
    const e = (
      await w.call('POST', '/api/admin/models', {
        name: 'a',
        baseUrl: 'http://8.8.8.8/v1',
        model: 'm',
      })
    ).body.endpoint
    for (const baseUrl of BLOCKED) {
      const r = await w.call('PUT', `/api/admin/models/${e.id}`, { baseUrl })
      expect([baseUrl, r.status, r.body.code]).toEqual([baseUrl, 400, 'blocked-host'])
    }
    expect((await w.call('GET', '/api/admin/models')).body.endpoints[0].baseUrl).toBe(
      'http://8.8.8.8/v1',
    )
    // An endpoint saved before the rule keeps working for its other fields.
    w.db
      .query("update model_endpoints set base_url = 'http://127.0.0.1:9/v1' where id = ?")
      .run(e.id)
    const renamed = await w.call('PUT', `/api/admin/models/${e.id}`, {
      name: 'renamed',
      baseUrl: 'http://127.0.0.1:9/v1',
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body.endpoint.name).toBe('renamed')
  })

  test('the .env endpoint’s origin stays allowed, and so does the tests-only local flag', async () => {
    const fallback: Endpoint = {
      name: 'llm',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'env',
      capability: 'json_schema',
    }
    const w = modelsWorld(fallback)
    const ok = await w.call('POST', '/api/admin/models', {
      name: 'env-copy',
      baseUrl: 'http://localhost:11434/other',
      model: 'm',
    })
    expect(ok.status).toBe(201)
    // Another port on the same host is another origin.
    const other = await w.call('POST', '/api/admin/models', {
      name: 'other',
      baseUrl: 'http://localhost:11435/v1',
      model: 'm',
    })
    expect(other.body.code).toBe('blocked-host')

    const local = modelsWorld(undefined, true)
    const r = await local.call('POST', '/api/admin/models', {
      name: 'mock',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'm',
    })
    expect(r.status).toBe(201)
  })
})
