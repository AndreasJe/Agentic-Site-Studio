// Second security review of the release layer: each defect it found has a test here that fails
// without the fix.
import { describe, expect, test } from 'bun:test'
import { type Bytes, fromBase64Url, toBase64Url, utf8 } from '../src/bytes.ts'
import {
  acceptCommand,
  acceptRelease,
  emptyState,
  genesisFingerprint,
} from '../src/release/trust.ts'
import { decodeCbor } from '../src/webauthn/cbor.ts'
import {
  APP,
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
  RP,
  release,
  TARGET,
} from './release-helpers.ts'

/** The same COSE map with every integer in its longer, non-minimal one-byte form. */
function nonMinimalCose(cose: Uint8Array): Bytes {
  const m = decodeCbor(new Uint8Array(cose)) as Map<number, number | Uint8Array>
  const int = (n: number) => (n >= 0 ? [0x18, n] : [0x38, -1 - n])
  const parts: number[] = [0xa0 | m.size]
  for (const [k, v] of m) {
    parts.push(...int(k))
    if (typeof v === 'number') parts.push(...int(v))
    else parts.push(0x58, v.length, ...v)
  }
  return new Uint8Array(parts)
}

describe('release layer, review 2', () => {
  test('lowering the domains rule needs two Admins even when the key rule is one', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 1, keys: 1, domains: 2 })
    const body = { command: 'trust-keys', sequence: 2, args: { policy: { domains: 1 } } }
    expect(await acceptCommand(state, await command(body, [a]), { now: NOW })).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    ok(await acceptCommand(state, await command(body, [a, b]), { now: NOW }))
  })

  test('an expiry date that does not exist is refused, not treated as never expiring', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    for (const expires of ['2026-13-45T99:99:99Z', '9999-99-99T00:00:00Z']) {
      const cmd = await command({ command: 'unfreeze', sequence: 2, expires }, [a])
      expect(await acceptCommand(state, cmd, { now: NOW })).toMatchObject({
        ok: false,
        code: 'malformed',
      })
    }
  })

  test('lowering the release rule needs two Admins even when the key rule is one', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 1, domains: 1 })
    const body = { command: 'trust-keys', sequence: 2, args: { policy: { releases: 1 } } }
    expect(await acceptCommand(state, await command(body, [a]), { now: NOW })).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    const s = ok(await acceptCommand(state, await command(body, [a, b]), { now: NOW })).state
    expect(s.policy.releases).toBe(1)
  })

  test('the same key re-encoded in CBOR under a new ID is refused as a duplicate', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const reencoded = toBase64Url(nonMinimalCose(fromBase64Url(a.key.publicKey)))
    expect(reencoded).not.toBe(a.key.publicKey)
    const carol = { keyId: 'Y2Fyb2w', adminId: 'carol', alg: a.key.alg, publicKey: reencoded }
    const add = await command({ command: 'trust-keys', sequence: 2, args: { add: [carol] } }, [a])
    expect(await acceptCommand(state, add, { now: NOW })).toMatchObject({
      ok: false,
      code: 'duplicate-key',
    })
  })

  test('numbers can only move forward by a bounded step', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    expect(await acceptRelease(state, await release(bundle, 1001, [a]), bundle, AT)).toMatchObject({
      ok: false,
      code: 'number-jump',
    })
    const huge = await app.sign({ command: 'freeze', sequence: Number.MAX_SAFE_INTEGER })
    expect(await acceptCommand(state, huge, { now: NOW })).toMatchObject({
      ok: false,
      code: 'number-jump',
    })
    ok(await acceptRelease(state, await release(bundle, 1000, [a]), bundle, AT))
  })

  test('removing an unknown key is refused, and a removed key can no longer sign', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b])
    const typo = await command(
      { command: 'trust-keys', sequence: 2, args: { remove: ['dHlwbw'] } },
      [a],
    )
    expect(await acceptCommand(state, typo, { now: NOW })).toMatchObject({
      ok: false,
      code: 'unknown-key',
    })
    const drop = await command(
      { command: 'trust-keys', sequence: 2, args: { remove: [b.key.keyId] } },
      [a],
    )
    const s = ok(await acceptCommand(state, drop, { now: NOW })).state
    expect(await acceptRelease(s, await release(bundle, 1, [b]), bundle, AT)).toMatchObject({
      ok: false,
      code: 'unknown-key',
    })
  })

  test('the rule can never require more Admins than production trusts', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const app = await appKey()
    const start = emptyState()
    const lonely = await command(
      {
        command: 'trust-keys',
        sequence: 1,
        args: {
          genesis: true,
          pairing: pairingFor(app.publicKey),
          add: [a.key],
          policy: { releases: 2 },
        },
      },
      [a],
    )
    expect(
      await acceptCommand(start, lonely, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(lonely),
      }),
    ).toMatchObject({ ok: false, code: 'too-few-admins' })
    const { state } = await paired([a, b], { releases: 1, keys: 2, domains: 1 })
    const dropB = await command(
      { command: 'trust-keys', sequence: 2, args: { remove: [b.key.keyId] } },
      [a, b],
    )
    expect(await acceptCommand(state, dropB, { now: NOW })).toMatchObject({
      ok: false,
      code: 'too-few-admins',
    })
  })

  test('inherited policy names, unknown args and non-UTC expiry are refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const proto = await command(
      { command: 'trust-keys', sequence: 2, args: { policy: { constructor: 1 } } },
      [a],
    )
    expect(await acceptCommand(state, proto, { now: NOW })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
    // A real change next to the typo, so only the unknown-args rule can refuse it.
    const b = await admin('bjarke')
    const typo = await command(
      { command: 'trust-keys', sequence: 2, args: { add: [b.key], polciy: { releases: 2 } } },
      [a],
    )
    expect(await acceptCommand(state, typo, { now: NOW })).toMatchObject({
      ok: false,
      code: 'malformed',
      detail: 'unknown args',
    })
    const local = await command(
      { command: 'unfreeze', sequence: 2, expires: '2026-10-19T13:00:00' },
      [a],
    )
    expect(await acceptCommand(state, local, { now: NOW })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })

  test('activate only points at an accepted release, and needs a passkey', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    const s1 = ok(await acceptRelease(state, await release(bundle, 1, [a]), bundle, AT)).state
    const s5 = ok(await acceptRelease(s1, await release(bundle, 5, [a]), bundle, AT)).state
    const three = await command({ command: 'activate', sequence: 2, args: { release: 3 } }, [a])
    expect(await acceptCommand(s5, three, { now: NOW })).toMatchObject({
      ok: false,
      code: 'unknown-release',
    })
    const appActivate = await app.sign({ command: 'activate', sequence: 2, args: { release: 1 } })
    expect(await acceptCommand(s5, appActivate, { now: NOW })).toMatchObject({
      ok: false,
      code: 'passkey-required',
    })
    const one = await command({ command: 'activate', sequence: 2, args: { release: 1 } }, [a])
    expect(ok(await acceptCommand(s5, one, { now: NOW })).state.activeRequest).toBe(1)
  })

  test('signature counters persist and a counter that goes back is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    a.auth.signCount = 5
    const s = ok(await acceptRelease(state, await release(bundle, 1, [a]), bundle, AT)).state
    expect(s.counters[a.key.keyId]).toBe(5)
    const same = await command({ command: 'unfreeze', sequence: 2 }, [a])
    expect(await acceptCommand(s, same, { now: NOW })).toMatchObject({
      ok: false,
      code: 'counter-regressed',
    })
    a.auth.signCount = 6
    const up = await command({ command: 'unfreeze', sequence: 2 }, [a])
    expect(ok(await acceptCommand(s, up, { now: NOW })).state.counters[a.key.keyId]).toBe(6)
  })

  test('genesis refusals each have their own code', async () => {
    const a = await admin('alex')
    const app = await appKey()
    const start = emptyState()
    const appGenesis = await app.sign({
      command: 'trust-keys',
      sequence: 1,
      args: { genesis: true, pairing: pairingFor(app.publicKey), add: [a.key] },
    })
    expect(await acceptCommand(start, appGenesis, { now: NOW })).toMatchObject({
      ok: false,
      code: 'passkey-required',
    })
    const withRemove = await command(
      {
        command: 'trust-keys',
        sequence: 1,
        args: {
          genesis: true,
          pairing: pairingFor(app.publicKey),
          add: [a.key],
          remove: [a.key.keyId],
        },
      },
      [a],
    )
    expect(await acceptCommand(start, withRemove, { now: NOW })).toMatchObject({
      ok: false,
      code: 'malformed',
      detail: 'genesis needs keys to add and nothing to remove',
    })
    const twice = await command(
      {
        command: 'trust-keys',
        sequence: 1,
        args: { genesis: true, pairing: pairingFor(app.publicKey), add: [a.key, a.key] },
      },
      [a],
    )
    expect(await acceptCommand(start, twice, { now: NOW })).toMatchObject({
      ok: false,
      code: 'duplicate-key',
    })
  })

  test('contentOf is gone: a release that carries it is refused (#35)', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 3, [a])
    expect(await acceptRelease(state, { ...rel, contentOf: 1 }, bundle, AT)).toMatchObject({
      ok: false,
      code: 'malformed',
    })
    expect(await acceptRelease(state, { ...rel, releaseNumber: '3' }, bundle, AT)).toMatchObject({
      ok: false,
      code: 'malformed',
      detail: 'releaseNumber',
    })
  })
})
