// M7.5: pairing (decisions #1, #25, #31, #34). The app runs the wizard against a local SFTP server
// and the real production agent on temp folders.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { appSigningPublicKey } from '../server/deploy/app-key.ts'
import { allocateSequence, getTarget, transportFor } from '../server/deploy/pairing.ts'
import { APP, pairProduction, RP, type World, world } from './helpers/deploy-world.ts'

let w: World
afterEach(async () => {
  await w?.cleanup()
})

describe('pairing wizard', () => {
  test('shows both public keys, pins the host key, writes one pairing file and one fingerprint', async () => {
    w = await world()
    const admin = w.as('admina')
    const keys = await admin.call('GET', '/api/deploy/keys')
    expect(keys.body.keys.ssh).toBe(w.sshKey.publicKey)
    expect(keys.body.keys.signing).toBe(await appSigningPublicKey(w.dataDir))
    expect(JSON.stringify(keys.body)).not.toContain('PRIVATE')

    const r = await pairProduction(w)
    // The host key the app showed is the one the server has; it is pinned.
    expect(r.connect.body.hostFingerprint).toBe(w.sftp.hostFingerprint)
    expect(r.connect.body.heartbeat).toMatchObject({ paired: false, site: 'example.com' })
    expect(r.connect.body.target.domains).toEqual(['example.com'])
    const row = getTarget(w.ctx, 'production')
    expect(row?.host_fp).toBe(w.sftp.hostFingerprint)

    // The agent saw the file, waited for the fingerprint, and accepted it once confirmed.
    expect(w.lines.some((l) => l.includes(r.fingerprint))).toBe(true)
    const snap = w.agent.snapshot()
    expect(snap.trust.keys).toHaveLength(1)
    expect(snap.trust.appOrigin).toBe(APP)
    expect(snap.trust.rpId).toBe(RP)
    expect(snap.trust.target).toBe('production')
    expect(snap.trust.appSigningKey).toBe(await appSigningPublicKey(w.dataDir))
    expect(r.refresh.body.target.status).toBe('paired')
    expect(r.refresh.body.heartbeat.paired).toBe(true)
    expect(r.prep.body.assertion.rpId).toBe(RP)
    // Production trusts the key now, so the release side counts it as approved.
    const key = w.db.query('select approved_at from passkeys').get() as {
      approved_at: string | null
    }
    expect(key.approved_at).not.toBeNull()
  })

  test('the pairing file leaves only through the inbox, as one named command, atomically', async () => {
    w = await world()
    await pairProduction(w)
    const names = readdirSync(w.sftp.inboxDir)
    expect(names.some((n) => /^cmd-1\.json$/.test(n))).toBe(true)
    expect(names.every((n) => !n.startsWith('.tmp-'))).toBe(true)
    const file = JSON.parse(readFileSync(join(w.sftp.inboxDir, 'cmd-1.json'), 'utf8'))
    expect(file.command).toBe('trust-keys')
    expect(file.args.genesis).toBe(true)
    expect(file.args.pairing).toMatchObject({
      appOrigin: APP,
      rpId: RP,
      target: 'production',
      from: { sequence: 0, release: 0 },
    })
    // No private key anywhere in it.
    expect(JSON.stringify(file)).not.toContain('PRIVATE')
  })

  test('transportFor gives the paired transport, and null for an unknown or unsent target', async () => {
    w = await world()
    expect(transportFor(w.ctx, 'production')).toBeNull()
    await pairProduction(w)
    const t = transportFor(w.ctx, 'production')
    expect(t).not.toBeNull()
    expect(await t?.listOutbox('heartbeat')).toContain('heartbeat.json')
    expect(transportFor(w.ctx, 'nowhere')).toBeNull()
  })

  test('only Admins reach the wizard', async () => {
    w = await world()
    const alex = w.as('alex')
    for (const [m, p] of [
      ['GET', '/api/deploy/keys'],
      ['GET', '/api/deploy/targets'],
      ['POST', '/api/deploy/targets/production/connect'],
      ['POST', '/api/deploy/targets/production/pin-host'],
      ['POST', '/api/deploy/targets/production/pairing/prepare'],
      ['POST', '/api/deploy/targets/production/pairing/confirm'],
    ] as const) {
      expect((await alex.call(m, p, {})).status).toBe(403)
    }
    // And a request with no session gets nowhere.
    const r = await w.app.request(`${APP}/api/deploy/keys`)
    expect(r.status).toBe(401)
  })

  test('the host key must be compared and pinned before the file is prepared; a wrong one is not pinned', async () => {
    w = await world()
    const passkey = await w.addPasskey('admina')
    const admin = w.as('admina')
    const base = '/api/deploy/targets/production'
    const c = await admin.call('POST', `${base}/connect`, { host: w.sftp.host, port: w.sftp.port })
    expect(c.status).toBe(200)
    expect((await admin.call('POST', `${base}/pairing/prepare`, {})).body.code).toBe(
      'host-not-pinned',
    )
    const other = `SHA256:${'A'.repeat(43)}`
    expect((await admin.call('POST', `${base}/pin-host`, { fingerprint: other })).body.code).toBe(
      'fingerprint-mismatch',
    )
    expect(getTarget(w.ctx, 'production')?.host_fp).toBeNull()
    expect(
      (await admin.call('POST', `${base}/pin-host`, { fingerprint: c.body.hostFingerprint }))
        .status,
    ).toBe(200)
    expect((await admin.call('POST', `${base}/pairing/prepare`, {})).status).toBe(200)
    expect(passkey.key.keyId).toBeTruthy()
  })

  test('a changed host key after pinning is refused, never re-pinned', async () => {
    w = await world()
    await pairProduction(w)
    // The pin is what the Admin compared; swap it for another and the transport must refuse.
    w.db
      .query("update deploy_targets set host_fp = ? where target = 'production'")
      .run(`SHA256:${'B'.repeat(43)}`)
    const t = transportFor(w.ctx, 'production')
    await expect(t?.listOutbox()).rejects.toMatchObject({ code: 'host-key-changed' })
    expect(getTarget(w.ctx, 'production')?.host_fp).toBe(`SHA256:${'B'.repeat(43)}`)
  })

  test('confirm checks the passkey answer like production will: a wrong challenge sends nothing', async () => {
    w = await world()
    const passkey = await w.addPasskey('admina')
    const admin = w.as('admina')
    const base = '/api/deploy/targets/production'
    const c = await admin.call('POST', `${base}/connect`, { host: w.sftp.host, port: w.sftp.port })
    await admin.call('POST', `${base}/pin-host`, { fingerprint: c.body.hostFingerprint })
    const prep = await admin.call('POST', `${base}/pairing/prepare`, {})
    const wrong = await passkey.auth.assert({
      challenge: crypto.getRandomValues(new Uint8Array(40)),
      origin: APP,
      rpId: RP,
    })
    const bad = await admin.call('POST', `${base}/pairing/confirm`, {
      adminKeyId: passkey.key.keyId,
      authenticatorData: toBase64Url(wrong.authenticatorData),
      clientDataJSON: toBase64Url(wrong.clientDataJSON),
      signature: toBase64Url(wrong.signature),
    })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toStartWith('refused-')
    expect(readdirSync(w.sftp.inboxDir)).toEqual([])
    expect(getTarget(w.ctx, 'production')?.status).toBe('prepared')

    // Someone else's key, or nothing at all, is refused too.
    expect(
      (await admin.call('POST', `${base}/pairing/confirm`, { adminKeyId: 'nope' })).body.code,
    ).toBe('bad-assertion')
    const adminB = w.as('adminb')
    const other = await adminB.call('POST', `${base}/pairing/confirm`, {
      adminKeyId: passkey.key.keyId,
      authenticatorData: 'AA',
      clientDataJSON: 'AA',
      signature: 'AA',
    })
    expect(other.body.code).toBe('other-admin')
    expect(prep.status).toBe(200)
  })

  test('without an approved passkey of your own the pairing file cannot be made', async () => {
    w = await world()
    const admin = w.as('admina')
    const base = '/api/deploy/targets/production'
    const c = await admin.call('POST', `${base}/connect`, { host: w.sftp.host, port: w.sftp.port })
    await admin.call('POST', `${base}/pin-host`, { fingerprint: c.body.hostFingerprint })
    expect((await admin.call('POST', `${base}/pairing/prepare`, {})).body.code).toBe('no-passkey')
  })

  test('re-pairing keeps the target numbers, so files from the old host stay refused (#34)', async () => {
    w = await world()
    await pairProduction(w)
    // Command 1 was the pairing file, 2 the certificate that followed; two more, and a release number, are used up.
    expect(allocateSequence(w.ctx, 'production')).toBe(3)
    expect(allocateSequence(w.ctx, 'production')).toBe(4)
    w.db.query("update deploy_targets set last_release = 4 where target = 'production'").run()
    const admin = w.as('admina')
    const base = '/api/deploy/targets/production'
    const c = await admin.call('POST', `${base}/connect`, { host: w.sftp.host, port: w.sftp.port })
    expect(c.body.target.status).toBe('connecting')
    expect(c.body.target.lastSequence).toBe(4)
    await admin.call('POST', `${base}/pin-host`, { fingerprint: c.body.hostFingerprint })
    const prep = await admin.call('POST', `${base}/pairing/prepare`, {})
    expect(prep.body.sequence).toBe(5)
    const row = getTarget(w.ctx, 'production')
    const pending = JSON.parse(row?.pending ?? '{}')
    expect(pending.unsigned.args.pairing.from).toEqual({ sequence: 4, release: 4 })
  })

  test('the fingerprint changes if anything in the file changes (origin, key set, rule)', async () => {
    w = await world()
    await w.addPasskey('admina')
    await w.addPasskey('adminb')
    const admin = w.as('admina')
    const base = '/api/deploy/targets/production'
    const c = await admin.call('POST', `${base}/connect`, { host: w.sftp.host, port: w.sftp.port })
    await admin.call('POST', `${base}/pin-host`, { fingerprint: c.body.hostFingerprint })
    const one = await admin.call('POST', `${base}/pairing/prepare`, {})
    const two = await admin.call('POST', `${base}/pairing/prepare`, { policy: { releases: 2 } })
    expect(one.body.fingerprint).not.toBe(two.body.fingerprint)
    expect(one.body.admins).toEqual(['admina', 'adminb'])
    const bad = await admin.call('POST', `${base}/pairing/prepare`, { policy: { releases: 3 } })
    expect(bad.body.code).toBe('bad-policy')
    expect(fromBase64Url(one.body.assertion.challenge)).toHaveLength(36)
    expect(existsSync(w.sftp.inboxDir)).toBe(true)
  })

  test('a folder target is for development only', async () => {
    w = await world()
    const admin = w.as('admina')
    const ok = await admin.call('POST', '/api/deploy/targets/dev/connect', {
      kind: 'folder',
      inboxDir: w.sftp.inboxDir,
      outboxDir: w.sftp.outboxDir,
    })
    expect(ok.status).toBe(200)
    expect(ok.body.target.status).toBe('pinned')
    const bad = await admin.call('POST', '/api/deploy/targets/Bad_Name/connect', { kind: 'folder' })
    expect(bad.body.code).toBe('bad-target')
  })
})
