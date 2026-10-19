// Decisions #27–#35 (answers after the spike 1 security reviews), one block each.
import { describe, expect, test } from 'bun:test'
import { utf8 } from '../src/bytes.ts'
import {
  acceptCommand,
  acceptRelease,
  emptyState,
  genesisFingerprint,
} from '../src/release/trust.ts'
import {
  AT,
  admin,
  appKey,
  bundle,
  command,
  makeBundle,
  NOW,
  ok,
  paired,
  pairingFor,
  release,
  validCommand,
} from './release-helpers.ts'

const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString()

describe('#27 the manifest inside the bundle decides', () => {
  test('a bundle for another target is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const elsewhere = makeBundle('x', { target: 'pre-production' })
    expect(
      await acceptRelease(state, await release(elsewhere, 1, [a]), elsewhere, AT),
    ).toMatchObject({
      ok: false,
      code: 'wrong-target',
    })
  })

  test('release.json must agree with the manifest', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a])
    expect(
      await acceptRelease(state, { ...rel, revision: 'qualiwarego-r9' }, bundle, AT),
    ).toMatchObject({
      ok: false,
      code: 'manifest-mismatch',
    })
    expect(await acceptRelease(state, { ...rel, project: 'othersite' }, bundle, AT)).toMatchObject({
      ok: false,
      code: 'manifest-mismatch',
    })
  })

  test('a bundle that is not a tar with the manifest first is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const raw = utf8.encode('<html>no manifest</html>')
    expect(await acceptRelease(state, await release(raw, 1, [a]), raw, AT)).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })

  test('production records which site each accepted release is', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const go = makeBundle('go', { site: 'go.example.com' })
    const s = ok(await acceptRelease(state, await release(go, 1, [a]), go, AT)).state
    expect(s.releases['1']?.site).toBe('go.example.com')
  })
})

describe('#29 lifetimes', () => {
  test('a release past its validUntil, or valid for more than 7 days, is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const old = makeBundle('old', { validUntil: inHours(-1) })
    expect(await acceptRelease(state, await release(old, 1, [a]), old, AT)).toMatchObject({
      ok: false,
      code: 'expired',
    })
    const forever = makeBundle('forever', { validUntil: '2099-01-01T00:00:00Z' })
    expect(await acceptRelease(state, await release(forever, 1, [a]), forever, AT)).toMatchObject({
      ok: false,
      code: 'too-long-lived',
    })
    const week = makeBundle('week', { validUntil: inHours(7 * 24) })
    ok(await acceptRelease(state, await release(week, 1, [a]), week, AT))
  })

  test('a command that expires more than 24 hours ahead is refused', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    const longFreeze = await app.sign({ command: 'freeze', sequence: 2, expires: inHours(48) })
    expect(await acceptCommand(state, longFreeze, { now: NOW })).toMatchObject({
      ok: false,
      code: 'too-long-lived',
    })
    const day = await app.sign({ command: 'freeze', sequence: 2, expires: inHours(24) })
    ok(await acceptCommand(state, day, { now: NOW }))
  })
})

describe('#28 who can add Admin keys', () => {
  test('an Admin adds a key for themselves on their own', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 1, domains: 1 })
    const phone = await admin('alex')
    const add = await command({ command: 'trust-keys', sequence: 2, args: { add: [phone.key] } }, [
      a,
    ])
    ok(await acceptCommand(state, add, { now: NOW }))
  })

  test("an Admin can't add a key under another Admin's name", async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 1, domains: 1 })
    const fakeB = await admin('bjarke')
    const add = await command({ command: 'trust-keys', sequence: 2, args: { add: [fakeB.key] } }, [
      a,
    ])
    expect(await acceptCommand(state, add, { now: NOW })).toMatchObject({
      ok: false,
      code: 'needs-key-owner',
    })
  })

  test('a key for a new Admin needs as many Admins as a release', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 1, domains: 1 })
    const c = await admin('carol')
    const one = await command({ command: 'trust-keys', sequence: 2, args: { add: [c.key] } }, [a])
    expect(await acceptCommand(state, one, { now: NOW })).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    const two = await command({ command: 'trust-keys', sequence: 2, args: { add: [c.key] } }, [
      a,
      b,
    ])
    ok(await acceptCommand(state, two, { now: NOW }))
  })
})

describe('#31 and #34 one pairing fingerprint, with the starting numbers', () => {
  test('the fingerprint covers the app address, rpId, target, signing key and numbers', async () => {
    const a = await admin('alex')
    const app = await appKey()
    const base = { genesis: true, add: [a.key], pairing: pairingFor(app.publicKey) }
    const fp = await genesisFingerprint({ args: base })
    for (const pairing of [
      { ...base.pairing, appOrigin: 'http://evil.example' },
      { ...base.pairing, rpId: 'example.com' },
      { ...base.pairing, target: 'pre-production' },
      { ...base.pairing, appSigningKey: (await appKey()).publicKey },
      { ...base.pairing, from: { sequence: 0, release: 5 } },
    ]) {
      expect(await genesisFingerprint({ args: { ...base, pairing } })).not.toBe(fp)
    }
  })

  test('genesis installs what the pairing file says, after the fingerprint is confirmed', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    expect(state.appOrigin).toBe('http://localhost:3000')
    expect(state.rpId).toBe('localhost')
    expect(state.target).toBe('production')
    expect(state.appSigningKey).toBe(app.publicKey)
  })

  test('genesis refuses a broken pairing, a target that disagrees, or a missing pairing', async () => {
    const a = await admin('alex')
    const app = await appKey()
    const good = pairingFor(app.publicKey)
    for (const pairing of [
      undefined,
      { ...good, appOrigin: 'not a url' },
      { ...good, appOrigin: 'http://localhost:3000/path' },
      { ...good, appSigningKey: 'AAAA' },
      { ...good, from: { sequence: -1, release: 0 } },
      { ...good, extra: true },
    ]) {
      const g = await command(
        {
          command: 'trust-keys',
          sequence: 1,
          args: { genesis: true, add: [a.key], ...(pairing === undefined ? {} : { pairing }) },
        },
        [a],
      )
      expect(
        await acceptCommand(emptyState(), g, {
          now: NOW,
          confirmedFingerprint: await genesisFingerprint(g),
        }),
      ).toMatchObject({ ok: false, code: 'malformed' })
    }
    const g = await command(
      {
        command: 'trust-keys',
        sequence: 1,
        target: 'staging',
        args: { genesis: true, add: [a.key], pairing: good },
      },
      [a],
    )
    expect(
      await acceptCommand(emptyState(), g, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(g),
      }),
    ).toMatchObject({ ok: false, code: 'wrong-target' })
  })

  test('a replacement host starts from the numbers in the pairing file', async () => {
    const a = await admin('alex')
    const app = await appKey()
    const pairing = pairingFor(app.publicKey, { sequence: 4200, release: 3100 })
    const stale = await command(
      { command: 'trust-keys', sequence: 4200, args: { genesis: true, add: [a.key], pairing } },
      [a],
    )
    expect(
      await acceptCommand(emptyState(), stale, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(stale),
      }),
    ).toMatchObject({ ok: false, code: 'replayed' })
    const g = await command(
      { command: 'trust-keys', sequence: 4201, args: { genesis: true, add: [a.key], pairing } },
      [a],
    )
    expect(validCommand(g)).toBe(true)
    const s = ok(
      await acceptCommand(emptyState(), g, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(g),
      }),
    ).state
    // An old signed release from before the move stays refused; the next one is accepted.
    expect(await acceptRelease(s, await release(bundle, 3100, [a]), bundle, AT)).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
    ok(await acceptRelease(s, await release(bundle, 3101, [a]), bundle, AT))
  })

  test('pairing data can only come with genesis', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    const later = await command(
      {
        command: 'trust-keys',
        sequence: 2,
        args: { policy: { keys: 1 }, pairing: pairingFor(app.publicKey) },
      },
      [a],
    )
    expect(await acceptCommand(state, later, { now: NOW })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })
})

describe('#32 removed keys stay removed', () => {
  test('a removed key is refused when added again, under any ID', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b])
    const drop = await command(
      { command: 'trust-keys', sequence: 2, args: { remove: [b.key.keyId] } },
      [a],
    )
    const s = ok(await acceptCommand(state, drop, { now: NOW })).state
    const back = await command({ command: 'trust-keys', sequence: 3, args: { add: [b.key] } }, [a])
    expect(await acceptCommand(s, back, { now: NOW })).toMatchObject({
      ok: false,
      code: 'revoked-key',
    })
    const renamed = await command(
      { command: 'trust-keys', sequence: 3, args: { add: [{ ...b.key, keyId: 'bmV3aWQ' }] } },
      [a],
    )
    expect(await acceptCommand(s, renamed, { now: NOW })).toMatchObject({
      ok: false,
      code: 'revoked-key',
    })
  })
})

describe('#33 what freeze stops', () => {
  test('while frozen: no release, no activate; key changes and unfreeze still work', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state, app } = await paired([a, b])
    const s1 = ok(await acceptRelease(state, await release(bundle, 1, [a]), bundle, AT)).state
    const frozen = ok(
      await acceptCommand(s1, await app.sign({ command: 'freeze', sequence: 2 }), { now: NOW }),
    ).state
    expect(await acceptRelease(frozen, await release(bundle, 2, [a]), bundle, AT)).toMatchObject({
      ok: false,
      code: 'frozen',
    })
    const activate = await command({ command: 'activate', sequence: 3, args: { release: 1 } }, [a])
    expect(await acceptCommand(frozen, activate, { now: NOW })).toMatchObject({
      ok: false,
      code: 'frozen',
    })
    const dropB = await command(
      { command: 'trust-keys', sequence: 3, args: { remove: [b.key.keyId] } },
      [a],
    )
    const s3 = ok(await acceptCommand(frozen, dropB, { now: NOW })).state
    const unfreeze = await command({ command: 'unfreeze', sequence: 4 }, [a])
    expect(ok(await acceptCommand(s3, unfreeze, { now: NOW })).state.frozen).toBe(false)
  })
})
