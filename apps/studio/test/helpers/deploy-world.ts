// A whole deployment side on temp folders: the app (real routes, sessions and CSRF), a local SFTP
// server standing in for production's inbox and outbox, and the real production agent
// (apps/agent) reading and writing those same folders. One clock drives both.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromBase64Url } from '@site-studio/shared/bytes'
import { coseKeyIdentity } from '@site-studio/shared/webauthn'
import {
  type Admin,
  APP,
  admin as makeAdmin,
  NOW,
  RP,
} from '../../../../packages/shared/test/release-helpers.ts'
import { Agent } from '../../../agent/src/agent.ts'
import { createApp } from '../../server/app/index.ts'
import { seedTestAccounts } from '../../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../../server/auth/sessions.ts'
import { openDb } from '../../server/db/index.ts'
import { type Issuer, TestIssuer } from '../../server/deploy/certs.ts'
import { closeTransports } from '../../server/deploy/pairing.ts'
import type { MailDeps } from '../../server/mail/send.ts'
import { loadOrCreateClientKey } from '../../server/transport/keys.ts'
import { startSftpServer, type TestSftpServer } from './sftp-server.ts'

export { APP, NOW, RP }

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
export type Json = any

export type World = Awaited<ReturnType<typeof world>>

export async function world(
  opts: { issuer?: Issuer | null; site?: string; agent?: boolean; mail?: MailDeps } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'studio-deploy-'))
  const dataDir = join(root, 'data')
  const clock = { now: NOW }
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const ctx = { db, dataDir, instanceId: 'qw' }
  const sshKey = loadOrCreateClientKey(dataDir)
  const sftp: TestSftpServer = await startSftpServer({ clientPublicKey: sshKey.publicKey })
  const issuer =
    opts.issuer === undefined
      ? await TestIssuer.create({ now: NOW })
      : (opts.issuer as Issuer | null)
  const lines: string[] = []
  const agent = new Agent({
    home: join(root, 'agent'),
    inbox: sftp.inboxDir,
    outbox: sftp.outboxDir,
    site: opts.site ?? 'example.com',
    hostname: '127.0.0.1',
    port: 0,
    heartbeatMs: 0,
    pollMs: 0,
    keep: 3,
    now: () => clock.now,
    print: (l) => lines.push(l),
  })
  if (opts.agent !== false) await agent.start()

  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir,
    deploy: { now: () => clock.now, allowFolder: true, issuer, mail: opts.mail },
  })

  const as = (handle: string) => {
    const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
    const s = createSession(db, user.id, Date.now())
    const headers = { origin: APP, cookie: `${SESSION_COOKIE}=${s.id}`, 'x-csrf-token': s.csrf }
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
    }
    return { call, userId: user.id }
  }

  /**
   * A software passkey registered for an Admin account, as the sign-in flow stores it before
   * pairing (approved), or waiting for approval (#28) with `approved: false`.
   */
  const addPasskey = async (handle: string, o: { approved?: boolean } = {}): Promise<Admin> => {
    const a = await makeAdmin(handle)
    const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
    db.query(
      'insert into passkeys (id, user_id, public_key, alg, sign_count, created_at, identity, approved_at) values (?, ?, ?, ?, 0, ?, ?, ?)',
    ).run(
      a.key.keyId,
      user.id,
      a.key.publicKey,
      a.key.alg,
      new Date().toISOString(),
      coseKeyIdentity(fromBase64Url(a.key.publicKey)),
      o.approved === false ? null : new Date().toISOString(),
    )
    return a
  }

  return {
    root,
    dataDir,
    db,
    ctx,
    clock,
    sftp,
    sshKey,
    agent,
    lines,
    issuer,
    app,
    as,
    addPasskey,
    async cleanup() {
      await closeTransports(ctx)
      await agent.stop()
      await sftp.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

/** The whole wizard, as the Deployment screen runs it; returns what the Admin compared. */
export async function pairProduction(
  w: World,
  handle = 'admina',
  target = 'production',
  o: { passkey?: Admin; domains?: string[]; host?: string; port?: number } = {},
) {
  const passkey = o.passkey ?? (await w.addPasskey(handle))
  const admin = w.as(handle)
  const base = `/api/deploy/targets/${target}`
  const connect = await admin.call('POST', `${base}/connect`, {
    host: o.host ?? w.sftp.host,
    port: o.port ?? w.sftp.port,
    domains: o.domains ?? ['example.com'],
  })
  if (connect.status !== 200) throw new Error(`connect: ${JSON.stringify(connect.body)}`)
  const pin = await admin.call('POST', `${base}/pin-host`, {
    fingerprint: connect.body.hostFingerprint,
  })
  if (pin.status !== 200) throw new Error(`pin: ${JSON.stringify(pin.body)}`)
  const prep = await admin.call('POST', `${base}/pairing/prepare`, {})
  if (prep.status !== 200) throw new Error(`prepare: ${JSON.stringify(prep.body)}`)
  const sig = await passkey.auth.assert({
    challenge: fromBase64Url(prep.body.assertion.challenge),
    origin: APP,
    rpId: RP,
  })
  const { toBase64Url } = await import('@site-studio/shared/bytes')
  const confirm = await admin.call('POST', `${base}/pairing/confirm`, {
    adminKeyId: passkey.key.keyId,
    authenticatorData: toBase64Url(sig.authenticatorData),
    clientDataJSON: toBase64Url(sig.clientDataJSON),
    signature: toBase64Url(sig.signature),
  })
  if (confirm.status !== 200) throw new Error(`confirm: ${JSON.stringify(confirm.body)}`)
  // At the server: the person compares the fingerprint and confirms it there.
  await w.agent.scan()
  w.agent.confirmFingerprint(prep.body.fingerprint)
  await w.agent.scan()
  w.agent.heartbeat()
  const refresh = await admin.call('POST', `${base}/refresh`)
  return {
    admin,
    passkey,
    connect,
    prep,
    confirm,
    refresh,
    fingerprint: prep.body.fingerprint as string,
  }
}
