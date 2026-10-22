// M7 release tests, end to end in one process: the real app (createApp), a staged revision with a
// publication request, Admins with software passkeys registered in the app, a FolderTransport
// target, and the real production agent (apps/agent) on temp folders, paired with a genesis file
// signed by an Admin's passkey and confirmed at the "server". Shared by release.test.ts and the
// browser test's server script.
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { commandChallenge, genesisFingerprint, type TrustedKey } from '@site-studio/shared/release'
import { coseKeyIdentity } from '@site-studio/shared/webauthn'
import { SoftAuthenticator } from '../../../../packages/shared/test/soft-authenticator.ts'
import { Agent } from '../../../agent/src/agent.ts'
import { createApp } from '../../server/app/index.ts'
import { seedTestAccounts } from '../../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../../server/auth/sessions.ts'
import { ADVISORY_CHECKS, FLOOR_CHECKS } from '../../server/checks/checks.ts'
import { openDb } from '../../server/db/index.ts'
import { markKeysApproved } from '../../server/governance/keys.ts'
import { appSigningPublicKey } from '../../server/release/keys.ts'
import { nextSequence } from '../../server/release/targets.ts'

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
export type Json = any

export const SITE = 'example.com'
const CSS = 'body{font-family:"PT Sans",sans-serif;color:#2e4163;background:#ffffff}'
const HOME = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><section data-section="s-aaaaaa"><h2>Hello</h2><p>Text</p></section></body></html>`
const ITEMS = ['copy', 'media', 'interactions', 'mobile', 'motion', 'translated', 'tested']

export type SoftAdmin = { handle: string; auth: SoftAuthenticator; keyId: string; key: TrustedKey }

/** A software passkey registered for an Admin straight in the app's passkeys table. */
export async function registerSoftKey(
  db: Database,
  handle: string,
  opts: { approved?: boolean } = {},
): Promise<SoftAdmin> {
  const auth = await SoftAuthenticator.create(-7)
  const cose = await auth.coseKey()
  const keyId = toBase64Url(auth.credentialId)
  const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
  db.query(
    'insert into passkeys (id, user_id, public_key, alg, sign_count, created_at, identity, approved_at) values (?, ?, ?, ?, 0, ?, ?, ?)',
  ).run(
    keyId,
    user.id,
    toBase64Url(cose),
    -7,
    new Date().toISOString(),
    coseKeyIdentity(cose),
    opts.approved === false ? null : new Date().toISOString(),
  )
  return {
    handle,
    auth,
    keyId,
    key: { keyId, adminId: handle, alg: -7, publicKey: toBase64Url(cose) },
  }
}

/** Like a real authenticator: the counter moves forward on every assertion. */
export async function assertFor(
  a: SoftAdmin,
  challenge: string | Uint8Array,
  opts: { origin: string; rpId?: string; uv?: boolean; counter?: number },
) {
  if (opts.counter !== undefined) a.auth.signCount = opts.counter
  else a.auth.signCount++
  const ch = typeof challenge === 'string' ? fromBase64Url(challenge) : new Uint8Array(challenge)
  const s = await a.auth.assert({
    challenge: ch,
    origin: opts.origin,
    rpId: opts.rpId ?? 'localhost',
    uv: opts.uv,
  })
  return {
    rawId: a.keyId,
    response: {
      authenticatorData: toBase64Url(s.authenticatorData),
      clientDataJSON: toBase64Url(s.clientDataJSON),
      signature: toBase64Url(s.signature),
    },
  }
}

export type FixtureOptions = {
  appUrl?: string
  /** Advisory check statuses in the package run, e.g. { axe: 'warn', visual: 'warn' }. */
  advisory?: Record<string, string>
  /** Admins who get a software passkey (and are in the pairing file). */
  admins?: string[]
  policy?: { releases: 1 | 2; keys: 1 | 2; domains: 1 | 2 }
  pair?: boolean
  agentFaults?: { dropHeader?: string }
}

export async function releaseFixture(o: FixtureOptions = {}) {
  const APP = o.appUrl ?? 'http://localhost:3000'
  const root = mkdtempSync(join(tmpdir(), 'studio-release-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir,
    appSecret: 'test-secret-for-release-tests',
    previewUrl: new URL('http://127.0.0.1:3001'),
  })
  const ctx = { db, dataDir, instanceId: 'qw' }
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

  // A project with one approved section, a revision approved for staging, a clean worker result.
  await alex('POST', '/api/projects', { name: 'Go' })
  const D = '/api/p/go/design'
  const board = (
    await alex('POST', `${D}/artboards`, { pageId: 'home', html: HOME, css: CSS, description: 'x' })
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

  const checksDir = join(dataDir, 'checks')
  const fakeWorker = (id: string, checks: Json[]) => {
    const job = JSON.parse(readFileSync(join(checksDir, 'pending', `${id}.json`), 'utf8')) as Json
    mkdirSync(join(checksDir, 'results'), { recursive: true })
    writeFileSync(
      join(checksDir, 'results', `${id}.json`),
      JSON.stringify({ id, kind: job.kind, hash: job.hash, hashOk: true, checks, blocked: false }),
    )
  }
  const passed = (id: string, status = 'pass', findings: Json[] = []) => ({
    id,
    floor: FLOOR_CHECKS.includes(id),
    level: 'block',
    status,
    lowered: null,
    findings,
  })

  /** Save, approve, let the worker pass it, stage it, smoke it, and request publication. */
  const stageAndRequest = async (note = 'Ready for launch') => {
    const rev = (await alex('POST', '/api/p/go/draft/save', { msg: 'Saved' })).body
      .revision as string
    const approved = await alex('POST', `/api/p/go/review/${rev}/approve`)
    if (approved.status !== 200) throw new Error(JSON.stringify(approved.body))
    const runs = (await alex('GET', '/api/p/go/checks/runs')).body.runs as Json[]
    const run = runs.find((x) => x.rev === rev && x.kind === 'package')
    const advisory = Object.entries({
      ...Object.fromEntries(ADVISORY_CHECKS.map((c) => [c, 'pass'])),
      ...o.advisory,
    }).map(([id, status]) =>
      passed(
        id,
        status,
        id === 'visual'
          ? [
              {
                message: '2.0% of the pixels changed at 1280px.',
                file: 'index.html',
                rule: 'visual-diff',
              },
            ]
          : [],
      ),
    )
    fakeWorker(run.id, [...FLOOR_CHECKS.map((c) => passed(c)), ...advisory])
    const staging = (await alex('GET', '/api/p/go/staging')).body
    const smoke = (await alex('GET', '/api/p/go/checks/runs')).body.runs.find(
      (x: Json) => x.kind === 'smoke' && x.rev === rev,
    )
    if (smoke) fakeWorker(smoke.id, [passed('smoke')])
    if (staging.staged?.rev !== rev) throw new Error(`not staged: ${JSON.stringify(staging)}`)
    const req = await alex('POST', '/api/p/go/staging/request', { note })
    if (req.status !== 201) throw new Error(JSON.stringify(req.body))
    return {
      rev,
      hash: approved.body.approval.packageHash as string,
      requestId: req.body.requests[0].id as number,
    }
  }

  const admins: Record<string, SoftAdmin> = {}
  for (const h of o.admins ?? ['admina', 'adminb']) admins[h] = await registerSoftKey(db, h)

  // The target: two folders, and the production agent reading one and writing the other.
  const inbox = join(root, 'inbox')
  const outbox = join(root, 'outbox')
  mkdirSync(inbox)
  mkdirSync(outbox)
  db.query(
    `insert into deploy_targets (target, kind, inbox_dir, outbox_dir, status, created_at, updated_at)
     values ('production', 'folder', ?, ?, 'paired', ?, ?)`,
  ).run(inbox, outbox, new Date().toISOString(), new Date().toISOString())
  const lines: string[] = []
  const agent = new Agent({
    home: join(root, 'agent'),
    inbox,
    outbox,
    site: SITE,
    hostname: '127.0.0.1',
    port: 0,
    heartbeatMs: 0,
    pollMs: 0,
    keep: 3,
    print: (l) => lines.push(l),
    ...(o.agentFaults ? { faults: o.agentFaults } : {}),
  })
  await agent.start()

  /** Pairing as the deployment side does it (#25, #31): genesis, the fingerprint confirmed. */
  /** The genesis file over every Admin passkey in the app (the deployment side's pairing). */
  const pairStart = async () => {
    const keys = db
      .query(
        "select p.id, p.public_key, p.alg, u.handle from passkeys p join users u on u.id = p.user_id where u.role = 'admin' and p.removed_at is null order by u.id, p.id",
      )
      .all() as { id: string; public_key: string; alg: number; handle: string }[]
    const sequence = nextSequence(ctx, 'production')
    const unsigned = {
      command: 'trust-keys',
      target: 'production',
      sequence,
      expires: new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString(),
      args: {
        genesis: true,
        add: keys.map((k) => ({
          keyId: k.id,
          adminId: k.handle,
          alg: k.alg,
          publicKey: k.public_key,
        })),
        pairing: {
          appOrigin: new URL(APP).origin,
          rpId: new URL(APP).hostname,
          target: 'production',
          appSigningKey: await appSigningPublicKey(dataDir),
          from: { sequence: sequence - 1, release: 0 },
        },
        ...(o.policy ? { policy: o.policy } : {}),
      },
    }
    return {
      unsigned,
      challenge: toBase64Url(await commandChallenge(unsigned)),
      keyIds: keys.map((k) => k.id),
    }
  }

  /** Puts the signed genesis in the inbox; the person at the server confirms the fingerprint. */
  const pairFinish = async (
    unsigned: Record<string, unknown>,
    keyId: string,
    a: { authenticatorData: string; clientDataJSON: string; signature: string },
  ) => {
    const signed = { ...unsigned, signatures: [{ by: 'admin-passkey', adminKeyId: keyId, ...a }] }
    const name = `cmd-${unsigned.sequence}.json`
    writeFileSync(join(inbox, `.tmp-${name}`), JSON.stringify(signed))
    renameSync(join(inbox, `.tmp-${name}`), join(inbox, name))
    await agent.scan()
    agent.confirmFingerprint(await genesisFingerprint(signed))
    // As the deployment side does once the heartbeat says paired: the pairing file's keys are trusted.
    markKeysApproved(
      ctx,
      ((unsigned.args as { add: { keyId: string }[] }).add ?? []).map((k) => k.keyId),
    )
    await agent.scan()
    if (!agent.snapshot().trust.keys.length)
      throw new Error(`pairing refused: ${lines.join(' | ')}`)
    if (o.policy)
      db.query("insert or replace into settings (key, value) values ('two_person_rule', ?)").run(
        JSON.stringify(o.policy),
      )
  }

  const pair = async () => {
    const first = Object.values(admins)[0] as SoftAdmin
    const { unsigned, challenge } = await pairStart()
    const a = await assertFor(first, challenge, { origin: new URL(APP).origin })
    // The assertion went through the browser, not the app: keep the app's counter in step.
    db.query('update passkeys set sign_count = ? where id = ?').run(
      first.auth.signCount,
      first.keyId,
    )
    await pairFinish(unsigned, first.keyId, a.response)
  }
  if (o.pair !== false) await pair()

  return {
    APP,
    root,
    dataDir,
    db,
    ctx,
    app,
    as,
    alex,
    admins,
    agent,
    lines,
    inbox,
    outbox,
    pair,
    pairStart,
    pairFinish,
    stageAndRequest,
    /** Sign a server-given WebAuthn request with an Admin's software passkey. */
    sign: (
      who: string,
      publicKey: { challenge: string },
      over: { origin?: string; uv?: boolean; counter?: number } = {},
    ) =>
      assertFor(admins[who] as SoftAdmin, publicKey.challenge, {
        origin: over.origin ?? new URL(APP).origin,
        uv: over.uv,
        counter: over.counter,
      }),
    async cleanup() {
      await agent.stop()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

export type Fixture = Awaited<ReturnType<typeof releaseFixture>>
