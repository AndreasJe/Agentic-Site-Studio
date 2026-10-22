// M7 release side, end to end in one process: the app (createApp) → FolderTransport → the real
// production agent (apps/agent) on temp folders → the app's outbox poller. Passkeys are software
// authenticators (the agent tests' kind); the browser ceremony is in release.e2e.ts.
// permission-cases.md: a Creator can't publish; production refuses an unsigned or replayed
// release; the two-person rule; freeze on the app's signature; unfreeze needs a passkey; lowering
// the rule needs the current rule; a key for a new Admin needs N Admins; the audit log is append-only.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toBase64Url } from '@site-studio/shared/bytes'
import { SoftAuthenticator } from '../../../packages/shared/test/soft-authenticator.ts'
import { pollAll, pollOutbox } from '../server/deploy/outbox.ts'
import { saveMailSettings } from '../server/mail/settings.ts'
import { createPasskeyCommand } from '../server/release/commands.ts'
import { signAppCommand } from '../server/release/keys.ts'
import { addSignature, getSigning, setStatus } from '../server/release/signing.ts'
import { FolderTransport } from '../server/transport/folder.ts'
import {
  type Fixture,
  type Json,
  registerSoftKey,
  releaseFixture,
} from './helpers/release-fixture.ts'
import { startSmtpSink, subjectOf } from './helpers/smtp-sink.ts'

let f: Fixture | undefined
afterEach(async () => {
  await f?.cleanup()
  f = undefined
})

const scan = async (x: Fixture) => {
  await x.agent.scan()
  await pollAll(x.ctx)
}

/** Challenge, then each Admin signs; returns the last sign response. */
async function approve(x: Fixture, requestId: number, who: string[]) {
  let last: { status: number; body: Json } = { status: 0, body: {} }
  for (const h of who) {
    const admin = x.as(h)
    const ch = await admin('POST', `/api/admin/review/${requestId}/challenge`)
    if (ch.status !== 200) return ch
    last = await admin(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await x.sign(h, ch.body.publicKey),
    )
    if (last.status !== 200) return last
  }
  return last
}

/** A command or governance signing request, signed by each Admin in turn. */
async function signAll(x: Fixture, start: { status: number; body: Json }, who: string[]) {
  expect(start.status).toBe(201)
  let last: { status: number; body: Json } = start
  for (const h of who) {
    last = await x.as(h)(
      'POST',
      `/api/admin/signing/${start.body.signingId}/sign`,
      await x.sign(h, start.body.publicKey),
    )
    if (last.status !== 200) return last
  }
  return last
}

const result = (x: Fixture, name: string) =>
  JSON.parse(readFileSync(join(x.outbox, 'results', name), 'utf8')) as Json

const inboxKinds = async (x: Fixture) =>
  ((await x.as('admina')('GET', '/api/admin/inbox')).body.items as Json[]).map((i) => i.kind)

describe('roles', () => {
  test('a Creator cannot publish, sign, freeze, unfreeze, roll back, or touch governance and keys', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    const paths: [string, string, unknown?][] = [
      ['GET', `/api/admin/review/${requestId}`],
      ['POST', `/api/admin/review/${requestId}/acknowledge`, { check: 'axe', reason: 'x' }],
      ['POST', `/api/admin/review/${requestId}/challenge`],
      ['POST', `/api/admin/review/${requestId}/sign`, {}],
      ['POST', `/api/admin/review/${requestId}/deliver`],
      ['POST', `/api/admin/review/${requestId}/send-back`, { note: 'no' }],
      ['GET', '/api/admin/inbox'],
      ['GET', '/api/admin/commands/production'],
      ['POST', '/api/admin/commands/production/freeze'],
      ['POST', '/api/admin/commands/production/unfreeze'],
      ['POST', '/api/admin/commands/production/activate', { release: 1 }],
      ['GET', '/api/admin/signing/1'],
      ['POST', '/api/admin/signing/1/sign', {}],
      ['GET', '/api/admin/governance'],
      ['POST', '/api/admin/governance/policy', { preset: 'small-team' }],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/keys'],
      ['POST', '/api/admin/keys/register/options'],
      ['POST', `/api/admin/keys/${f.admins.admina?.keyId}/remove`],
    ]
    for (const [method, path, body] of paths) {
      const r = await f.alex(method, path, body)
      expect({ path, status: r.status }).toEqual({ path, status: 403 })
    }
    // Nothing reached production.
    await f.agent.scan()
    expect(f.agent.snapshot().trust.highestRelease).toBe(0)
    expect(f.agent.snapshot().trust.frozen).toBe(false)
  })
})

describe('releases', () => {
  test('one Admin: the review page, the bundle, the passkey, production accepts, the request is published', async () => {
    f = await releaseFixture()
    const { requestId, rev, hash } = await f.stageAndRequest()
    expect(await inboxKinds(f)).toContain('publication-request')
    const admin = f.as('admina')
    const review = (await admin('GET', `/api/admin/review/${requestId}`)).body
    expect(review.request).toMatchObject({
      rev,
      hash,
      note: 'Ready for launch',
      by: 'alex',
      status: 'open',
    })
    expect(review.checks.floorPassed).toBe(true)
    expect(review.canSign).toBe(true)
    expect(review.visual.pages[0]).toMatchObject({ page: 'home', sections: [{ id: 's-aaaaaa' }] })

    const ch = await admin('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.status).toBe(200)
    expect(ch.body.needed).toBe(1)
    expect(ch.body.publicKey).toMatchObject({ rpId: 'localhost', userVerification: 'required' })
    // The challenge is exactly the 40 bytes of #23: the bundle hash and release number 1.
    const challenge = Buffer.from(ch.body.publicKey.challenge, 'base64url')
    expect(challenge.length).toBe(40)
    expect(challenge.readBigUInt64BE(32)).toBe(1n)

    const signed = await admin(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    expect(signed.status).toBe(200)
    expect(signed.body).toMatchObject({ complete: true, sent: true })
    const json = JSON.parse(readFileSync(join(f.inbox, 'release-1.json'), 'utf8'))
    expect(json).toMatchObject({
      project: 'go',
      revision: rev,
      releaseNumber: 1,
      approvedBy: 'admina',
      checks: 'passed',
    })
    expect(json.signatures).toHaveLength(1)

    await scan(f)
    expect(result(f, 'release-1.json')).toMatchObject({ ok: true, release: 1, revision: rev })
    const after = (await admin('GET', `/api/admin/review/${requestId}`)).body
    expect(after.request.status).toBe('published')
    expect(after.signing).toMatchObject({
      status: 'accepted',
      releaseNumber: 1,
      outcome: 'accepted',
    })
    expect(after.signing.smoke).toMatchObject({ passed: true, switchedBack: false })
    expect(f.agent.snapshot().active).toBe(1)
    // The manifest names the M6 package: site.tar is the archive byte for byte (#47, #48).
    const audit = (await admin('GET', '/api/admin/audit')).body.entries as Json[]
    expect(audit.find((e) => e.action === 'release-prepared')?.detail.packageHash).toBe(
      `sha256:${hash}`,
    )
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(['release-sent', 'release-accepted']),
    )
    // Waiting for you: the request is dealt with.
    expect(await inboxKinds(f)).not.toContain('publication-request')
  })

  test('two Admins: the first signature waits, the same Admin cannot count twice, the second sends it', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    const ch = await a('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.body.needed).toBe(2)
    const first = await a(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    expect(first.body).toMatchObject({ complete: false, sent: false })
    expect(
      (await a('GET', `/api/admin/review/${requestId}`)).body.signers.map((s: Json) => s.adminId),
    ).toEqual(['admina'])
    const again = await a('POST', `/api/admin/review/${requestId}/challenge`)
    expect(again.body.signingId).toBe(ch.body.signingId)
    const twice = await a(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', again.body.publicKey),
    )
    expect(twice).toMatchObject({ status: 409, body: { code: 'already-signed' } })
    expect(readdir(f.inbox)).not.toContain('release-1.json')

    const b = f.as('adminb')
    const ch2 = await b('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch2.body.publicKey.challenge).toBe(ch.body.publicKey.challenge)
    const second = await b(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('adminb', ch2.body.publicKey),
    )
    expect(second.body).toMatchObject({ complete: true, sent: true })
    await scan(f)
    expect(result(f, 'release-1.json')).toMatchObject({ ok: true })
    expect((await a('GET', `/api/admin/review/${requestId}`)).body.request.status).toBe('published')
  })

  test('production checks the rule itself: one signature under a two-Admin rule is refused, and the app shows it', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 2, domains: 2 } })
    // The app believes one is enough (a taken-over app, say); production does not.
    f.db
      .query("update settings set value = ? where key = 'two_person_rule'")
      .run(JSON.stringify({ releases: 1, keys: 2, domains: 2 }))
    const { requestId } = await f.stageAndRequest()
    const r = await approve(f, requestId, ['admina'])
    expect(r.body.sent).toBe(true)
    await scan(f)
    expect(result(f, 'release-1.json')).toMatchObject({ ok: false, code: 'not-enough-signers' })
    const review = (await f.as('admina')('GET', `/api/admin/review/${requestId}`)).body
    expect(review.signing).toMatchObject({ status: 'refused', outcome: 'not-enough-signers' })
    expect(review.request.status).toBe('open')
    expect(await inboxKinds(f)).toContain('release-refused')
  })

  test('an unsigned or replayed release is refused by production, and the app shows the refusal', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    expect((await approve(f, requestId, ['admina'])).body.sent).toBe(true)
    await scan(f)
    expect(result(f, 'release-1.json').ok).toBe(true)

    // Replayed: the same signed files put in the inbox again (not by the app).
    const tar = readFileSync(join(f.inbox, 'release-1.tar'))
    const json = readFileSync(join(f.inbox, 'release-1.json'))
    put(f.inbox, 'release-1.tar', tar)
    put(f.inbox, 'release-1.json', json)
    // Unsigned: a next number with no passkey signature at all.
    const unsigned = { ...JSON.parse(json.toString()), releaseNumber: 2, signatures: [] }
    put(f.inbox, 'release-2.tar', tar)
    put(f.inbox, 'release-2.json', JSON.stringify(unsigned))
    await scan(f)
    expect(result(f, 'release-1.json')).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
    expect(result(f, 'release-2.json')).toMatchObject({ ok: false, code: 'malformed' })
    expect(f.agent.snapshot().trust.highestRelease).toBe(1)
    // The app's own release stays accepted; both refusals are waiting for the Admins.
    const review = (await f.as('admina')('GET', `/api/admin/review/${requestId}`)).body
    expect(review.signing.status).toBe('accepted')
    const items = (await f.as('admina')('GET', '/api/admin/inbox')).body.items as Json[]
    expect(
      items
        .filter((i) => i.kind === 'outbox-refusal')
        .map((i) => i.ref)
        .sort(),
    ).toEqual(['production:release-1.json', 'production:release-2.json'])
  })

  test('an assertion is checked by the app: wrong origin, no user verification, a reused one, another Admin’s key', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    const ch = await a('POST', `/api/admin/review/${requestId}/challenge`)
    const sign = (body: unknown) => a('POST', `/api/admin/review/${requestId}/sign`, body)
    expect(
      (await sign(await f.sign('admina', ch.body.publicKey, { origin: 'https://evil.example' })))
        .body.code,
    ).toBe('origin-mismatch')
    expect((await sign(await f.sign('admina', ch.body.publicKey, { uv: false }))).body.code).toBe(
      'user-not-verified',
    )
    expect((await sign(await f.sign('adminb', ch.body.publicKey))).body.code).toBe('not-your-key')
    expect((await sign({ rawId: 'x' })).body.code).toBe('malformed')
    const good = await f.sign('admina', ch.body.publicKey)
    // The counter went backwards (a replayed or cloned assertion): refused (#30).
    const old = await f.sign('admina', ch.body.publicKey, { counter: 1 })
    expect((await sign(old)).body.code).toBe('counter-regressed')
    expect((await sign(good)).status).toBe(200)
    expect(readdir(f.inbox)).toContain('release-1.json')
  })

  test('a later signature that overtakes a pending one is refused by production; the app asks to sign again (#30)', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    const ch = await a('POST', `/api/admin/review/${requestId}/challenge`)
    await a(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    // admina signs an unfreeze meanwhile: a higher counter reaches production first.
    const unfreeze = await signAll(f, await a('POST', '/api/admin/commands/production/unfreeze'), [
      'admina',
    ])
    expect(unfreeze.body.sent).toBe(true)
    await scan(f)
    const b = f.as('adminb')
    const ch2 = await b('POST', `/api/admin/review/${requestId}/challenge`)
    expect(
      (
        await b(
          'POST',
          `/api/admin/review/${requestId}/sign`,
          await f.sign('adminb', ch2.body.publicKey),
        )
      ).body.sent,
    ).toBe(true)
    await scan(f)
    expect(result(f, 'release-1.json')).toMatchObject({ ok: false, code: 'counter-regressed' })
    const review = (await a('GET', `/api/admin/review/${requestId}`)).body
    expect(review.reSign).toBe(true)
    // Signing again: a new challenge with the next number, both Admins, accepted.
    const r = await approve(f, requestId, ['admina', 'adminb'])
    expect(r.body.sent).toBe(true)
    await scan(f)
    expect(result(f, 'release-2.json')).toMatchObject({ ok: true })
  })

  test('warnings are acknowledged with a reason before anyone signs; the visual comparison is per section', async () => {
    f = await releaseFixture({ advisory: { axe: 'warn', visual: 'warn', seo: 'pass' } })
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    const review = (await a('GET', `/api/admin/review/${requestId}`)).body
    expect(review.warnings.map((w: Json) => w.check).sort()).toEqual(['axe', 'visual'])
    expect(review.canSign).toBe(false)
    expect(review.visual.pages[0]).toMatchObject({
      page: 'home',
      status: 'changed',
      sections: [{ id: 's-aaaaaa' }],
      findings: [{ rule: 'visual-diff' }],
    })
    expect((await a('POST', `/api/admin/review/${requestId}/challenge`)).body.code).toBe(
      'warnings-not-acknowledged',
    )
    expect(
      (await a('POST', `/api/admin/review/${requestId}/acknowledge`, { check: 'axe' })).body.code,
    ).toBe('reason-required')
    expect(
      (
        await a('POST', `/api/admin/review/${requestId}/acknowledge`, {
          check: 'html',
          reason: 'x',
        })
      ).body.code,
    ).toBe('no-such-warning')
    for (const w of review.warnings as Json[]) {
      const r = await a('POST', `/api/admin/review/${requestId}/acknowledge`, {
        check: w.check,
        reason: 'Checked by hand',
      })
      expect(r.status).toBe(200)
    }
    expect(
      (await a('POST', `/api/admin/review/${requestId}/acknowledge`, { check: 'axe', reason: 'x' }))
        .status,
    ).toBe(409)
    const after = (await a('GET', `/api/admin/review/${requestId}`)).body
    expect(after.warnings.every((w: Json) => w.acknowledged?.by === 'admina')).toBe(true)
    expect(after.canSign).toBe(true)
    expect((await approve(f, requestId, ['admina'])).body.sent).toBe(true)
  })

  test('send back needs a note and closes the request', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    expect(
      (await a('POST', `/api/admin/review/${requestId}/send-back`, { note: ' ' })).body.code,
    ).toBe('note-required')
    const r = await a('POST', `/api/admin/review/${requestId}/send-back`, {
      note: 'The hero image is wrong',
    })
    expect(r.status).toBe(200)
    expect(r.body.review.request).toMatchObject({
      status: 'sent-back',
      closed: { by: 'admina', note: 'The hero image is wrong' },
    })
    expect((await a('POST', `/api/admin/review/${requestId}/challenge`)).body.code).toBe(
      'request-closed',
    )
    expect(
      (await a('POST', `/api/admin/review/${requestId}/send-back`, { note: 'again' })).status,
    ).toBe(409)
  })

  test('a newer request supersedes an older one; an open signature on the old one is never sent', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    const first = await f.stageAndRequest()
    const a = f.as('admina')
    const ch = await a('POST', `/api/admin/review/${first.requestId}/challenge`)
    await a(
      'POST',
      `/api/admin/review/${first.requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    const second = await f.stageAndRequest('Second round')
    expect((await a('GET', `/api/admin/review/${first.requestId}`)).body.request.status).toBe(
      'superseded',
    )
    const b = f.as('adminb')
    expect((await b('POST', `/api/admin/review/${first.requestId}/challenge`)).body.code).toBe(
      'request-closed',
    )
    expect((await approve(f, second.requestId, ['admina', 'adminb'])).body.sent).toBe(true)
  })
})

describe('notifications', () => {
  test('release accepted and refused, and a new Admin key: Waiting for you and a mail to the Admins', async () => {
    const sink = await startSmtpSink()
    try {
      f = await releaseFixture({ policy: { releases: 1, keys: 1, domains: 1 } })
      saveMailSettings(f.ctx, {
        host: '127.0.0.1',
        port: sink.port,
        security: 'none',
        from: 'studio@example.com',
      })
      f.db.query("update users set email = 'admina@example.com' where handle = 'admina'").run()
      const one = await f.stageAndRequest('one')
      expect((await approve(f, one.requestId, ['admina'])).body.sent).toBe(true)
      await scan(f)
      await f.as('admina')('POST', '/api/admin/commands/production/freeze')
      await scan(f)
      const two = await f.stageAndRequest('two')
      expect((await approve(f, two.requestId, ['admina'])).body.sent).toBe(true)
      await scan(f)
      f.db
        .query(
          "insert into users (handle, name, role, created_at) values ('adminc', 'Adminc', 'admin', ?)",
        )
        .run(new Date().toISOString())
      const c = await registerSoftKey(f.db, 'adminc', { approved: false })
      const start = await f.as('admina')('POST', `/api/admin/keys/${c.keyId}/approve`)
      expect((await signAll(f, start, ['admina'])).body.sent).toBe(true)
      await scan(f)
      expect(await inboxKinds(f)).toEqual(
        expect.arrayContaining(['release-accepted', 'release-refused', 'admin-key-added']),
      )
      for (let i = 0; i < 100 && sink.messages.length < 3; i++) await Bun.sleep(50)
      expect(sink.messages.map((m) => m.to[0])).toEqual([
        'admina@example.com',
        'admina@example.com',
        'admina@example.com',
      ])
      expect(sink.messages.map((m) => subjectOf(m.data)).length).toBe(3)
    } finally {
      await sink.close()
    }
  })
})

describe('commands', () => {
  test('freeze works on the app signature alone; a release while frozen is refused', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    const r = await a('POST', '/api/admin/commands/production/freeze')
    expect(r.status).toBe(200)
    const cmd = JSON.parse(readFileSync(join(f.inbox, `cmd-${r.body.sequence}.json`), 'utf8'))
    expect(cmd).toMatchObject({ command: 'freeze', target: 'production' })
    expect(cmd.signatures).toEqual([{ by: 'app', value: expect.any(String) }])
    await scan(f)
    expect(f.agent.snapshot().trust.frozen).toBe(true)
    const view = (await a('GET', '/api/admin/commands/production')).body
    expect(view.heartbeat.frozen).toBe(true)
    expect(view.commands[0]).toMatchObject({ purpose: 'freeze', status: 'accepted' })

    const { requestId } = await f.stageAndRequest()
    expect((await approve(f, requestId, ['admina'])).body.sent).toBe(true)
    await scan(f)
    expect(result(f, 'release-1.json')).toMatchObject({ ok: false, code: 'frozen' })
    expect((await a('GET', `/api/admin/review/${requestId}`)).body.signing.outcome).toBe('frozen')
  })

  test('unfreeze without a passkey is refused, here and by production; with one it is accepted', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    await a('POST', '/api/admin/commands/production/freeze')
    await scan(f)
    // Production: an unfreeze signed by the app's key only.
    const seq = f.agent.snapshot().trust.lastSequence + 1
    f.db.query("update deploy_targets set last_sequence = ? where target = 'production'").run(seq)
    const forged = await signAppCommand(f.dataDir, {
      command: 'unfreeze',
      target: 'production',
      sequence: seq,
      expires: new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString(),
    })
    put(f.inbox, `cmd-${seq}.json`, JSON.stringify(forged))
    await scan(f)
    expect(result(f, `cmd-${seq}.json`)).toMatchObject({ ok: false, code: 'passkey-required' })
    expect(f.agent.snapshot().trust.frozen).toBe(true)

    // The app: no assertion, or one without user verification, sends nothing.
    const start = await a('POST', '/api/admin/commands/production/unfreeze')
    expect(start.status).toBe(201)
    expect(Buffer.from(start.body.publicKey.challenge, 'base64url').subarray(0, 4).toString()).toBe(
      'cmd1',
    )
    const sign = (body: unknown) =>
      a('POST', `/api/admin/signing/${start.body.signingId}/sign`, body)
    expect((await sign({})).body.code).toBe('malformed')
    expect(
      (await sign(await f.sign('admina', start.body.publicKey, { uv: false }))).body.code,
    ).toBe('user-not-verified')
    expect(
      (await f.alex('POST', `/api/admin/signing/${start.body.signingId}/sign`, {})).status,
    ).toBe(403)
    const ok = await sign(await f.sign('admina', start.body.publicKey))
    expect(ok.body).toMatchObject({ complete: true, sent: true })
    await scan(f)
    expect(f.agent.snapshot().trust.frozen).toBe(false)
  })

  test('a freeze sent meanwhile means an older, unsent unfreeze has to be signed again (#26)', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    const start = await a('POST', '/api/admin/commands/production/unfreeze')
    await a('POST', '/api/admin/commands/production/freeze')
    const r = await a(
      'POST',
      `/api/admin/signing/${start.body.signingId}/sign`,
      await f.sign('admina', start.body.publicKey),
    )
    expect(r).toMatchObject({ status: 409, body: { code: 'needs-re-signing' } })
    expect((await a('GET', `/api/admin/signing/${start.body.signingId}`)).body.status).toBe('stale')
    await scan(f)
    expect(f.agent.snapshot().trust.frozen).toBe(true)
    const again = await signAll(f, await a('POST', '/api/admin/commands/production/unfreeze'), [
      'admina',
    ])
    expect(again.body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust.frozen).toBe(false)
  })

  test('activate (rollback, #35): one Admin switches production back to a kept release', async () => {
    f = await releaseFixture()
    const one = await f.stageAndRequest('one')
    expect((await approve(f, one.requestId, ['admina'])).body.sent).toBe(true)
    await scan(f)
    const two = await f.stageAndRequest('two')
    expect((await approve(f, two.requestId, ['admina'])).body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().active).toBe(2)
    const a = f.as('admina')
    expect(
      (await a('POST', '/api/admin/commands/production/activate', { release: 0 })).status,
    ).toBe(400)
    const start = await a('POST', '/api/admin/commands/production/activate', { release: 1 })
    const cmd = getSigning(f.ctx, start.body.signingId)
    const body = JSON.parse(cmd?.body ?? '{}')
    expect(body).toMatchObject({ command: 'activate', args: { release: 1 } })
    // 24 hours at most (#29, #35).
    expect(Date.parse(body.expires) - Date.now()).toBeLessThanOrEqual(24 * 3600_000)
    const r = await signAll(f, start, ['adminb'])
    expect(r.body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().active).toBe(1)
    expect((await a('GET', '/api/admin/commands/production')).body.heartbeat.activeRelease).toBe(1)
  })
})

describe('governance', () => {
  test('presets; raising needs one Admin, lowering the two-person rule needs the current rule (two)', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    const g = (await a('GET', '/api/admin/governance')).body
    expect(g).toMatchObject({ policy: { releases: 1, keys: 1, domains: 1 }, preset: 'small-team' })
    expect(Object.keys(g.presets)).toEqual(['small-team', 'standard', 'strict'])

    const up = await a('POST', '/api/admin/governance/policy', { preset: 'strict' })
    expect(up.body.needed).toBe(1)
    expect((await signAll(f, up, ['admina'])).body.sent).toBe(true)
    // Stricter counts at once; production confirms it.
    expect((await a('GET', '/api/admin/governance')).body.preset).toBe('strict')
    await scan(f)
    expect(f.agent.snapshot().trust.policy).toEqual({ releases: 2, keys: 2, domains: 2 })

    const down = await a('POST', '/api/admin/governance/policy', { preset: 'small-team' })
    expect(down.body.needed).toBe(2)
    const one = await signAll(f, down, ['admina'])
    expect(one.body).toMatchObject({ complete: false, sent: false })
    expect((await a('GET', '/api/admin/governance')).body.preset).toBe('strict')
    const two = await signAll(
      f,
      {
        status: 201,
        body: (await f.as('adminb')('GET', `/api/admin/signing/${down.body.signingId}`)).body
          .options,
      },
      ['adminb'],
    )
    expect(two.body.sent).toBe(true)
    // Lowered counts once it is delivered: its signatures met the current rule (two). The outbox
    // result that follows only shows how it went.
    expect((await a('GET', '/api/admin/governance')).body.preset).toBe('small-team')
    await scan(f)
    expect(f.agent.snapshot().trust.policy).toEqual({ releases: 1, keys: 1, domains: 1 })
    expect((await a('GET', '/api/admin/governance')).body.preset).toBe('small-team')
    const actions = ((await a('GET', '/api/admin/audit')).body.entries as Json[]).map(
      (e) => e.action,
    )
    expect(actions.filter((x) => x === 'policy-changed')).toHaveLength(2)
  })

  test('production refuses a lowering signed by fewer Admins than the current rule', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 2, domains: 2 } })
    const admina = f.db.query("select * from users where handle = 'admina'").get() as Json
    const deps = { appOrigin: f.APP, rpId: 'localhost', now: Date.now }
    // Bypass the app's own count, as a taken-over app could.
    const row = await createPasskeyCommand(f.ctx, deps, {
      target: 'production',
      command: 'trust-keys',
      args: { policy: { releases: 1, keys: 1, domains: 1 } },
      purpose: 'policy',
      ref: 'forged',
      needed: 1,
      who: 'admina',
    })
    const user = {
      id: admina.id,
      handle: 'admina',
      name: 'admina',
      role: 'admin' as const,
      language: 'en' as const,
    }
    expect(
      (
        await addSignature(
          f.ctx,
          deps,
          row,
          user,
          await f.sign('admina', { challenge: row.challenge }),
        )
      ).ok,
    ).toBe(true)
    const signed = JSON.parse(row.body)
    const sigs = f.db
      .query('select * from signing_signatures where request_id = ?')
      .all(row.id) as Json[]
    put(
      f.inbox,
      `cmd-${signed.sequence}.json`,
      JSON.stringify({
        ...signed,
        signatures: sigs.map((s) => ({
          by: 'admin-passkey',
          adminKeyId: s.key_id,
          authenticatorData: s.authenticator_data,
          clientDataJSON: s.client_data_json,
          signature: s.signature,
        })),
      }),
    )
    await scan(f)
    expect(result(f, `cmd-${signed.sequence}.json`)).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    expect(f.agent.snapshot().trust.policy).toEqual({ releases: 2, keys: 2, domains: 2 })
  })

  test('before pairing (app only): one Admin raises the rule, lowering it needs two', async () => {
    f = await releaseFixture({ pair: false })
    f.db.query("delete from deploy_targets where target = 'production'").run()
    const a = f.as('admina')
    const up = await a('POST', '/api/admin/governance/policy', {
      policy: { releases: 2, keys: 1, domains: 1 },
    })
    expect(Buffer.from(up.body.publicKey.challenge, 'base64url').subarray(0, 4).toString()).toBe(
      'stp1',
    )
    expect((await signAll(f, up, ['admina'])).body.complete).toBe(true)
    expect((await a('GET', '/api/admin/governance')).body.policy.releases).toBe(2)
    const down = await a('POST', '/api/admin/governance/policy', { preset: 'small-team' })
    expect(down.body.needed).toBe(2)
    await signAll(f, down, ['admina'])
    expect((await a('GET', '/api/admin/governance')).body.policy.releases).toBe(2)
    await signAll(f, { status: 201, body: down.body }, ['adminb'])
    expect((await a('GET', '/api/admin/governance')).body.preset).toBe('small-team')
    expect(
      (await a('POST', '/api/admin/governance/policy', { preset: 'small-team' })).body.code,
    ).toBe('no-change')
    expect(
      (await a('POST', '/api/admin/governance/policy', { policy: { releases: 3 } })).body.code,
    ).toBe('bad-policy')
  })

  test('the audit log is append-only', async () => {
    f = await releaseFixture({ pair: false })
    await f.as('admina')('POST', '/api/admin/commands/production/freeze')
    expect(() => f?.db.query('delete from audit_log').run()).toThrow(/append-only/)
    expect(() => f?.db.query("update audit_log set who = 'x'").run()).toThrow(/append-only/)
  })
})

describe('keys', () => {
  test('a key for a new Admin needs as many Admins as the strictest rule (#28)', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    f.db
      .query(
        "insert into users (handle, name, role, created_at) values ('adminc', 'Adminc', 'admin', ?)",
      )
      .run(new Date().toISOString())
    const c = await registerSoftKey(f.db, 'adminc', { approved: false })
    f.admins.adminc = c
    const a = f.as('admina')
    const keys = (await a('GET', '/api/admin/keys')).body
    expect(keys.keys.find((k: Json) => k.keyId === c.keyId).status).toBe('waiting')
    const start = await a('POST', `/api/admin/keys/${c.keyId}/approve`)
    expect(start.body).toMatchObject({ needed: 2, owner: null })
    // The new key can't sign for itself.
    const self = await f.as('adminc')(
      'POST',
      `/api/admin/signing/${start.body.signingId}/sign`,
      await f.sign('adminc', start.body.publicKey),
    )
    expect(self).toMatchObject({ status: 403, body: { code: 'not-your-key' } })
    expect((await signAll(f, start, ['admina'])).body).toMatchObject({ complete: false })
    expect((await signAll(f, start, ['adminb'])).body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust.keys.map((k) => k.adminId)).toContain('adminc')
    expect(
      (await a('GET', '/api/admin/keys')).body.keys.find((k: Json) => k.keyId === c.keyId).status,
    ).toBe('approved')
  })

  test('production refuses a new Admin key with fewer signatures than the strictest rule', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    f.db
      .query(
        "insert into users (handle, name, role, created_at) values ('adminc', 'Adminc', 'admin', ?)",
      )
      .run(new Date().toISOString())
    const c = await registerSoftKey(f.db, 'adminc', { approved: false })
    const deps = { appOrigin: f.APP, rpId: 'localhost', now: Date.now }
    const row = await createPasskeyCommand(f.ctx, deps, {
      target: 'production',
      command: 'trust-keys',
      args: { add: [c.key] },
      purpose: 'key-add',
      ref: 'forged',
      needed: 1,
      who: 'admina',
    })
    const admina = f.db.query("select id from users where handle = 'admina'").get() as {
      id: number
    }
    const user = {
      id: admina.id,
      handle: 'admina',
      name: 'admina',
      role: 'admin' as const,
      language: 'en' as const,
    }
    await addSignature(f.ctx, deps, row, user, await f.sign('admina', { challenge: row.challenge }))
    const sigs = f.db
      .query('select * from signing_signatures where request_id = ?')
      .all(row.id) as Json[]
    const body = JSON.parse(row.body)
    put(
      f.inbox,
      `cmd-${body.sequence}.json`,
      JSON.stringify({
        ...body,
        signatures: sigs.map((s) => ({
          by: 'admin-passkey',
          adminKeyId: s.key_id,
          authenticatorData: s.authenticator_data,
          clientDataJSON: s.client_data_json,
          signature: s.signature,
        })),
      }),
    )
    await scan(f)
    expect(result(f, `cmd-${body.sequence}.json`)).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
  })

  test('an Admin adds their own device, signed by their own key; a removed key stays removed (#28, #32)', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    // Register a second passkey for admina through the API.
    const phone = await SoftAuthenticator.create(-7)
    const opts = await registerOptions(f, 'admina')
    const reg = await phone.register({
      challenge: Buffer.from(opts.publicKey.challenge, 'base64url'),
      origin: f.APP,
      rpId: 'localhost',
    })
    const regBody = {
      challengeId: opts.challengeId,
      response: {
        attestationObject: toBase64Url(reg.attestationObject),
        clientDataJSON: toBase64Url(reg.clientDataJSON),
      },
    }
    const added = await a('POST', '/api/admin/keys/register', regBody)
    expect(added.status).toBe(201)
    const keyId = added.body.keyId as string
    f.admins.phone = {
      handle: 'admina',
      auth: phone,
      keyId,
      key: { keyId, adminId: 'admina', alg: -7, publicKey: '' },
    }

    const start = await a('POST', `/api/admin/keys/${keyId}/approve`)
    expect(start.body).toMatchObject({ needed: 1, owner: 'admina' })
    // The owner must sign: another Admin alone is not enough.
    expect((await signAll(f, start, ['adminb'])).body).toMatchObject({ complete: false })
    expect((await signAll(f, start, ['admina'])).body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust.keys.map((k) => k.keyId)).toContain(keyId)

    // Remove it.
    const rm = await a('POST', `/api/admin/keys/${keyId}/remove`)
    expect((await signAll(f, rm, ['adminb'])).body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust.keys.map((k) => k.keyId)).not.toContain(keyId)
    expect(f.agent.snapshot().trust.revoked.map((k) => k.keyId)).toContain(keyId)
    expect(
      (await a('GET', '/api/admin/keys')).body.keys.find((k: Json) => k.keyId === keyId).status,
    ).toBe('removed')
    // The removed key signs nothing in the app, and can't be registered again.
    const freeze = await a('POST', '/api/admin/commands/production/unfreeze')
    const bySelf = await a(
      'POST',
      `/api/admin/signing/${freeze.body.signingId}/sign`,
      await f.sign('phone', freeze.body.publicKey),
    )
    expect(bySelf.body.code).toBe('not-your-key')
    const opts2 = await registerOptions(f, 'admina')
    const reg2 = await phone.register({
      challenge: Buffer.from(opts2.publicKey.challenge, 'base64url'),
      origin: f.APP,
      rpId: 'localhost',
    })
    const again = await a('POST', '/api/admin/keys/register', {
      challengeId: opts2.challengeId,
      response: {
        attestationObject: toBase64Url(reg2.attestationObject),
        clientDataJSON: toBase64Url(reg2.clientDataJSON),
      },
    })
    expect(again).toMatchObject({ status: 409, body: { code: 'credential-exists' } })
    // Nor sign in.
    const signIn = await f.app.request(`${f.APP}/api/passkey/sign-in/options`, {
      method: 'POST',
      headers: { origin: f.APP },
    })
    const allowed = ((await signIn.json()) as Json).publicKey.allowCredentials.map(
      (k: Json) => k.id,
    )
    expect(allowed).not.toContain(keyId)
  })

  test('a signed removal counts in the app at once, even when delivery fails (review)', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    const keyId = f.admins.adminb?.keyId as string
    const status = async () =>
      (await a('GET', '/api/admin/keys')).body.keys.find((k: Json) => k.keyId === keyId).status
    // The inbox can't be written: the upload fails.
    const inbox = f.inbox
    renameSync(inbox, `${inbox}-away`)
    writeFileSync(inbox, 'not a folder')
    const rm = await a('POST', `/api/admin/keys/${keyId}/remove`)
    const signed = await signAll(f, rm, ['admina'])
    expect(signed.status).toBe(502)
    expect(signed.body.signing.status).toBe('signed')
    // Removed in the app already: it counts for nothing and signs nothing.
    expect(await status()).toBe('removed')
    const freeze = await a('POST', '/api/admin/commands/production/unfreeze')
    const byRemoved = await f.as('adminb')(
      'POST',
      `/api/admin/signing/${freeze.body.signingId}/sign`,
      await f.sign('adminb', freeze.body.publicKey),
    )
    expect(byRemoved.body.code).toBe('not-your-key')
    const db = f.db
    const audits = () =>
      (
        db.query("select count(*) as n from audit_log where action = 'key-removed'").get() as {
          n: number
        }
      ).n
    expect(audits()).toBe(1)

    // The upload is tried again later and reaches production; nothing is applied twice.
    rmSync(inbox)
    renameSync(`${inbox}-away`, inbox)
    const again = await a('POST', `/api/admin/signing/${rm.body.signingId}/deliver`)
    expect(again.body.sent).toBe(true)
    expect(audits()).toBe(1)
    await scan(f)
    expect(f.agent.snapshot().trust.revoked.map((k) => k.keyId)).toContain(keyId)
    // Once it has reached production, a second removal is refused.
    expect((await a('POST', `/api/admin/keys/${keyId}/remove`)).body.code).toBe('key-removed')
  })

  test('a removal that went stale before delivery can be started again', async () => {
    f = await releaseFixture()
    const a = f.as('admina')
    const keyId = f.admins.adminb?.keyId as string
    const inbox = f.inbox
    renameSync(inbox, `${inbox}-away`)
    writeFileSync(inbox, 'not a folder')
    const rm = await a('POST', `/api/admin/keys/${keyId}/remove`)
    expect((await signAll(f, rm, ['admina'])).status).toBe(502)
    setStatus(f.ctx, rm.body.signingId, 'stale', { outcome: 'expired' })
    rmSync(inbox)
    renameSync(`${inbox}-away`, inbox)
    const next = await a('POST', `/api/admin/keys/${keyId}/remove`)
    expect(next.status).toBe(201)
    expect((await signAll(f, next, ['admina'])).body.sent).toBe(true)
    await scan(f)
    expect(f.agent.snapshot().trust.revoked.map((k) => k.keyId)).toContain(keyId)
  })

  test('removing a key that would leave fewer Admins than the rule is refused', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    const r = await f.as('admina')('POST', `/api/admin/keys/${f.admins.adminb?.keyId}/remove`)
    expect(r).toMatchObject({ status: 409, body: { code: 'too-few-admins' } })
  })
})

describe('waiting keys', () => {
  test('a key waiting for approval signs nothing: no step-up, no release, no command', async () => {
    f = await releaseFixture()
    const w = await registerSoftKey(f.db, 'admina', { approved: false })
    f.admins.waiting = w
    const a = f.as('admina')
    const ask = await a('PUT', '/api/admin/checks/axe', { level: 'warn' })
    expect(ask.body.stepUp.publicKey.allowCredentials.map((k: Json) => k.id)).not.toContain(w.keyId)
    const bad = { id: ask.body.stepUp.id, ...(await f.sign('waiting', ask.body.stepUp.publicKey)) }
    expect(await a('PUT', '/api/admin/checks/axe', { level: 'warn', stepUp: bad })).toMatchObject({
      status: 403,
      body: { code: 'not-your-key' },
    })
    const cmd = await a('POST', '/api/admin/commands/production/unfreeze')
    expect(cmd.body.publicKey.allowCredentials.map((k: Json) => k.id)).not.toContain(w.keyId)
    const r = await a(
      'POST',
      `/api/admin/signing/${cmd.body.signingId}/sign`,
      await f.sign('waiting', cmd.body.publicKey),
    )
    expect(r.body.code).toBe('not-your-key')
    // Approving it needs admina's approved key, not the waiting one.
    const start = await a('POST', `/api/admin/keys/${w.keyId}/approve`)
    const self = await a(
      'POST',
      `/api/admin/signing/${start.body.signingId}/sign`,
      await f.sign('waiting', start.body.publicKey),
    )
    expect(self.status).toBe(403)
    // Registering another device needs a step-up first.
    expect((await a('POST', '/api/admin/keys/register/options')).status).toBe(428)
  })

  test('a rule change makes requests still waiting for signatures stale', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    const ch = await a('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.body.needed).toBe(1)
    const up = await a('POST', '/api/admin/governance/policy', { preset: 'strict' })
    expect((await signAll(f, up, ['admina'])).body.sent).toBe(true)
    const late = await a(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    expect(late.body.code).toBe('needs-re-signing')
    const again = await a('POST', `/api/admin/review/${requestId}/challenge`)
    expect(again.body.needed).toBe(2)
  })
})

describe('the outbox poller', () => {
  test('reports only new items, and ignores malformed, mismatched or oversize files', async () => {
    f = await releaseFixture()
    const t = new FolderTransport({ inboxDir: f.inbox, outboxDir: f.outbox })
    const first = await pollOutbox(f.ctx, 'production', t)
    expect(first.map((e) => e.kind)).toContain('heartbeat')
    expect(first.find((e) => e.kind === 'result')).toMatchObject({ name: 'cmd-1.json', ok: true })
    expect(first.find((e) => e.kind === 'csr')).toMatchObject({ host: 'example.com' })
    expect(await pollOutbox(f.ctx, 'production', t)).toEqual([])

    const before = (await f.as('admina')('GET', '/api/admin/commands/production')).body.heartbeat
    writeFileSync(
      join(f.outbox, 'heartbeat.json'),
      JSON.stringify({ at: new Date().toISOString(), pad: 'x'.repeat(70_000) }),
    )
    writeFileSync(join(f.outbox, 'results', 'cmd-50.json'), '{not json')
    writeFileSync(
      join(f.outbox, 'results', 'cmd-51.json'),
      JSON.stringify({ file: 'cmd-51.json', ok: 'yes' }),
    )
    writeFileSync(
      join(f.outbox, 'results', 'cmd-52.json'),
      JSON.stringify({ file: 'cmd-99.json', ok: false, code: 'frozen' }),
    )
    writeFileSync(
      join(f.outbox, 'results', 'cmd-53.json'),
      JSON.stringify({ file: 'cmd-53.json', ok: false, code: '<script>' }),
    )
    writeFileSync(
      join(f.outbox, 'results', 'cmd-54.json'),
      JSON.stringify({ file: 'cmd-54.json', ok: false }),
    )
    writeFileSync(
      join(f.outbox, 'results', 'cmd-55.json'),
      JSON.stringify({ file: 'cmd-55.json', ok: true, pad: 'x'.repeat(70_000) }),
    )
    mkdirSync(join(f.outbox, 'smoke'), { recursive: true })
    writeFileSync(
      join(f.outbox, 'smoke', '7.json'),
      JSON.stringify({ release: 8, passed: false, switchedBack: true }),
    )
    writeFileSync(join(f.outbox, 'csr', 'evil.pem'), 'not a CSR')
    writeFileSync(join(f.outbox, 'evil.txt'), 'hello')
    expect(await pollOutbox(f.ctx, 'production', t)).toEqual([])
    expect(await pollOutbox(f.ctx, 'production', t)).toEqual([])
    // The oversize heartbeat changed nothing the app shows.
    expect((await f.as('admina')('GET', '/api/admin/commands/production')).body.heartbeat.at).toBe(
      before.at,
    )
    expect(await inboxKinds(f)).not.toContain('outbox-refusal')
  })
})

describe('check settings step-up', () => {
  test('lowering a check from Block needs a fresh passkey assertion for exactly that change, once', async () => {
    f = await releaseFixture({ pair: false })
    const a = f.as('admina')
    const ask = await a('PUT', '/api/admin/checks/axe', { level: 'warn' })
    expect(ask.status).toBe(428)
    expect(ask.body.code).toBe('step-up-required')
    const challenge = Buffer.from(ask.body.stepUp.publicKey.challenge, 'base64url')
    expect(challenge.length).toBe(36)
    expect(challenge.subarray(0, 4).toString()).toBe('stp1')
    const answer = {
      id: ask.body.stepUp.id,
      ...(await f.sign('admina', ask.body.stepUp.publicKey)),
    }
    // Not for another change.
    expect(
      (await a('PUT', '/api/admin/checks/axe', { level: 'off', stepUp: answer })).body.code,
    ).toBe('step-up-mismatch')
    const ask2 = await a('PUT', '/api/admin/checks/axe', { level: 'warn' })
    const answer2 = {
      id: ask2.body.stepUp.id,
      ...(await f.sign('admina', ask2.body.stepUp.publicKey)),
    }
    expect(
      (await a('PUT', '/api/admin/checks/axe', { level: 'warn', stepUp: answer2 })).status,
    ).toBe(200)
    // Raising back needs no step-up.
    expect((await a('PUT', '/api/admin/checks/axe', { level: 'block' })).status).toBe(200)
    // Used once: the same answer for the same change again is refused.
    expect(
      await a('PUT', '/api/admin/checks/axe', { level: 'warn', stepUp: answer2 }),
    ).toMatchObject({
      status: 403,
      body: { code: 'step-up-expired' },
    })
    // Another Admin's session can't use one made for admina.
    const ask3 = await a('PUT', '/api/admin/checks/axe', { level: 'warn' })
    const answer3 = {
      id: ask3.body.stepUp.id,
      ...(await f.sign('admina', ask3.body.stepUp.publicKey)),
    }
    expect(
      (await f.as('adminb')('PUT', '/api/admin/checks/axe', { level: 'warn', stepUp: answer3 }))
        .status,
    ).toBe(403)
    expect(
      (await a('GET', '/api/admin/checks')).body.checks.find((c: Json) => c.id === 'axe').level,
    ).toBe('block')
    const audit = ((await a('GET', '/api/admin/audit')).body.entries as Json[]).map((e) => e.action)
    expect(audit.filter((x) => x === 'check-level')).toHaveLength(2)
  })
})

/** Adding a device starts with a step-up by one of the Admin's approved keys. */
async function registerOptions(x: Fixture, who: string) {
  const ask = await x.as(who)('POST', '/api/admin/keys/register/options')
  expect(ask.status).toBe(428)
  const answer = { id: ask.body.stepUp.id, ...(await x.sign(who, ask.body.stepUp.publicKey)) }
  const r = await x.as(who)('POST', '/api/admin/keys/register/options', { stepUp: answer })
  expect(r.status).toBe(200)
  return r.body
}

function put(dir: string, name: string, data: string | Uint8Array) {
  writeFileSync(join(dir, `.tmp-${name}`), data)
  renameSync(join(dir, `.tmp-${name}`), join(dir, name))
}

const readdir = (dir: string): string[] => readdirSync(dir)

describe('M7 security review', () => {
  test('a forged ok result in the outbox lowers no rule and approves no key (finding 6)', async () => {
    const strict = { releases: 2, keys: 2, domains: 2 } as const
    f = await releaseFixture({ policy: strict })
    f.db
      .query(
        "insert into users (handle, name, role, created_at) values ('adminc', 'Adminc', 'admin', ?)",
      )
      .run(new Date().toISOString())
    const c = await registerSoftKey(f.db, 'adminc', { approved: false })
    const deps = { appOrigin: f.APP, rpId: 'localhost', now: Date.now }
    const lower = await createPasskeyCommand(f.ctx, deps, {
      target: 'production',
      command: 'trust-keys',
      args: { policy: { releases: 1, keys: 1, domains: 1 } },
      purpose: 'policy',
      ref: 'forged-policy',
      needed: 2,
      effect: { type: 'policy', from: strict, to: { releases: 1, keys: 1, domains: 1 } },
      who: 'admina',
    })
    const key = await createPasskeyCommand(f.ctx, deps, {
      target: 'production',
      command: 'trust-keys',
      args: { add: [c.key] },
      purpose: 'key-add',
      ref: 'forged-key',
      needed: 2,
      effect: { type: 'key-add', keyId: c.keyId, adminId: 'adminc' },
      who: 'admina',
    })
    // As if both had gone out unsigned; whoever writes the outbox then claims production took them.
    for (const row of [lower, key]) {
      setStatus(f.ctx, row.id, 'sent', { sent: true })
      writeFileSync(
        join(f.outbox, 'results', `cmd-${row.number}.json`),
        JSON.stringify({ file: `cmd-${row.number}.json`, kind: 'command', ok: true }),
      )
    }
    await pollAll(f.ctx)
    const a = f.as('admina')
    // Shown as accepted, and nothing else.
    expect(getSigning(f.ctx, lower.id)?.status).toBe('accepted')
    expect(getSigning(f.ctx, key.id)?.status).toBe('accepted')
    expect((await a('GET', '/api/admin/governance')).body.preset).toBe('strict')
    expect(
      (await a('GET', '/api/admin/keys')).body.keys.find((k: Json) => k.keyId === c.keyId).status,
    ).toBe('waiting')
  })

  test('a key approval counts on delivery, before any outbox result (finding 6)', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    f.db
      .query(
        "insert into users (handle, name, role, created_at) values ('adminc', 'Adminc', 'admin', ?)",
      )
      .run(new Date().toISOString())
    const c = await registerSoftKey(f.db, 'adminc', { approved: false })
    const a = f.as('admina')
    const start = await a('POST', `/api/admin/keys/${c.keyId}/approve`)
    expect((await signAll(f, start, ['admina'])).body).toMatchObject({ complete: false })
    expect((await signAll(f, start, ['adminb'])).body.sent).toBe(true)
    expect(
      (await a('GET', '/api/admin/keys')).body.keys.find((k: Json) => k.keyId === c.keyId).status,
    ).toBe('approved')
  })

  test('a release whose signer’s key was removed before delivery is not sent (finding 8)', async () => {
    f = await releaseFixture({ policy: { releases: 2, keys: 1, domains: 1 } })
    const { requestId } = await f.stageAndRequest()
    const a = f.as('admina')
    const ch = await a('POST', `/api/admin/review/${requestId}/challenge`)
    const first = await a(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    expect(first.body).toMatchObject({ complete: false })
    f.db
      .query('update passkeys set removed_at = ? where id = ?')
      .run(new Date().toISOString(), f.admins.admina?.keyId as string)
    const b = f.as('adminb')
    const ch2 = await b('POST', `/api/admin/review/${requestId}/challenge`)
    const second = await b(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('adminb', ch2.body.publicKey),
    )
    expect(second).toMatchObject({ status: 409, body: { code: 'needs-re-signing' } })
    expect(second.body.signing).toMatchObject({ status: 'stale', outcome: 'key-removed' })
    expect(readdir(f.inbox)).not.toContain('release-1.json')
    expect(readdir(f.inbox)).not.toContain('release-1.tar')
  })
})
