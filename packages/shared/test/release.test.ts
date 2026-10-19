// Spike 1, release layer: what production accepts. Pass criteria from
// docs/spikes/01-passkey-signed-release.md and decisions #23–#26.
import { describe, expect, test } from 'bun:test'
import { sha256, utf8 } from '../src/bytes.ts'
import { canonicalJson } from '../src/release/canonical.ts'
import { commandChallenge, releaseChallenge } from '../src/release/challenge.ts'
import {
  acceptCommand,
  acceptRelease,
  emptyState,
  genesisFingerprint,
} from '../src/release/trust.ts'
import {
  type Admin,
  APP,
  admin,
  appKey,
  bundle,
  command,
  hex,
  LATER,
  NOW,
  ok,
  paired,
  passkeySig,
  RP,
  release,
  TARGET,
  validCommand,
  validRelease,
} from './release-helpers.ts'

describe('release challenge and canonical JSON (decisions #23, #24, #26)', () => {
  test('release challenge is the raw hash followed by the number as uint64 big-endian', async () => {
    const hash = await sha256(utf8.encode('abc'))
    const ch = releaseChallenge(hash, 258)
    expect(ch.length).toBe(40)
    expect(hex(ch)).toBe(`${hex(hash)}0000000000000102`)
    expect(() => releaseChallenge(hash, 0)).toThrow()
    expect(() => releaseChallenge(hash, 1.5)).toThrow()
    expect(() => releaseChallenge(hash.subarray(0, 31), 1)).toThrow()
  })

  test('command challenge is "cmd1" + sha256 of the canonical command without signatures', async () => {
    const cmd = { sequence: 2, command: 'freeze', target: 'production', expires: LATER }
    const ch = await commandChallenge({ ...cmd, signatures: [{ by: 'app', value: 'x' }] })
    expect(ch.length).toBe(36)
    expect(utf8.decode(ch.subarray(0, 4))).toBe('cmd1')
    expect(ch.subarray(4)).toEqual(await sha256(utf8.encode(canonicalJson(cmd))))
  })

  test('canonical JSON sorts keys at every level, has no whitespace and refuses non-integers', () => {
    expect(canonicalJson({ b: 1, a: [{ d: true, c: null }], é: 'x', A: 'y' })).toBe(
      '{"A":"y","a":[{"c":null,"d":true}],"b":1,"é":"x"}',
    )
    expect(() => canonicalJson({ a: 1.5 })).toThrow()
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
    expect(() => canonicalJson({ a: undefined })).toThrow()
    expect(() => canonicalJson({ a: 2 ** 60 })).toThrow()
  })

  test('the three challenge kinds never overlap in length', async () => {
    const lengths = new Set([
      32, // sign-in: fresh random bytes
      releaseChallenge(await sha256(bundle), 1).length,
      (await commandChallenge({ command: 'freeze' })).length,
    ])
    expect(lengths.size).toBe(3)
  })
})

describe('releases (spike 1 pass criteria)', () => {
  test('a valid release is accepted and its number becomes the floor', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a])
    expect(validRelease(rel)).toBe(true)
    const r = ok(await acceptRelease(state, rel, bundle))
    expect(r.state.highestRelease).toBe(1)
  })

  test('a changed byte in the bundle is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a])
    const changed = bundle.slice()
    changed[3] = (changed[3] ?? 0) ^ 1
    expect(await acceptRelease(state, rel, changed)).toMatchObject({
      ok: false,
      code: 'hash-mismatch',
    })
  })

  test('a release whose hash was swapped after signing is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const other = utf8.encode('<html>something else</html>')
    const rel = {
      ...(await release(bundle, 1, [a])),
      packageHash: `sha256:${hex(await sha256(other))}`,
    }
    expect(await acceptRelease(state, rel, other)).toMatchObject({
      ok: false,
      code: 'challenge-mismatch',
    })
  })

  test('a lower or equal release number is refused, so an old bundle cannot be replayed', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const s5 = ok(await acceptRelease(state, await release(bundle, 5, [a]), bundle)).state
    expect(await acceptRelease(s5, await release(bundle, 5, [a]), bundle)).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
    expect(await acceptRelease(s5, await release(bundle, 4, [a]), bundle)).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
  })

  test('a number changed after signing is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = { ...(await release(bundle, 1, [a])), releaseNumber: 9 }
    expect(await acceptRelease(state, rel, bundle)).toMatchObject({
      ok: false,
      code: 'challenge-mismatch',
    })
  })

  test('a signature made on another origin is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a], {}, { origin: 'http://127.0.0.1:3001' })
    expect(await acceptRelease(state, rel, bundle)).toMatchObject({
      ok: false,
      code: 'origin-mismatch',
    })
  })

  test('a signature without user verification is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a], {}, { uv: false })
    expect(await acceptRelease(state, rel, bundle)).toMatchObject({
      ok: false,
      code: 'user-not-verified',
    })
  })

  test('a signature by a key production does not trust is refused', async () => {
    const a = await admin('alex')
    const stranger = await admin('mallory')
    const { state } = await paired([a])
    expect(await acceptRelease(state, await release(bundle, 1, [stranger]), bundle)).toMatchObject({
      ok: false,
      code: 'unknown-key',
    })
  })

  test('a sign-in assertion cannot pass as a release signature', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a])
    const signIn = await passkeySig(a, crypto.getRandomValues(new Uint8Array(32)))
    expect(await acceptRelease(state, { ...rel, signatures: [signIn] }, bundle)).toMatchObject({
      ok: false,
      code: 'challenge-mismatch',
    })
  })

  test('nothing is accepted before pairing, or while frozen', async () => {
    const a = await admin('alex')
    const app = await appKey()
    const blank = emptyState({
      appOrigin: APP,
      rpId: RP,
      target: TARGET,
      appSigningKey: app.publicKey,
    })
    expect(await acceptRelease(blank, await release(bundle, 1, [a]), bundle)).toMatchObject({
      ok: false,
      code: 'no-trusted-keys',
    })
    const { state, app: paired_ } = await paired([a])
    const frozen = ok(
      await acceptCommand(state, await paired_.sign({ command: 'freeze', sequence: 2 }), {
        now: NOW,
      }),
    )
    expect(await acceptRelease(frozen.state, await release(bundle, 1, [a]), bundle)).toMatchObject({
      ok: false,
      code: 'frozen',
    })
  })

  test('the release refuses malformed fields without throwing', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a])
    for (const bad of [
      { ...rel, checks: 'failed' },
      { ...rel, releaseNumber: '1' },
      { ...rel, packageHash: 'md5:abc' },
      { ...rel, signatures: [] },
      { ...rel, signatures: [{ adminKeyId: 'x' }] },
      null,
    ]) {
      expect(await acceptRelease(state, bad, bundle)).toMatchObject({ ok: false })
    }
  })
})

describe('the two-person rule', () => {
  test('with two required, one signature is refused and two different Admins are accepted', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 2, domains: 1 })
    expect(await acceptRelease(state, await release(bundle, 1, [a]), bundle)).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    ok(await acceptRelease(state, await release(bundle, 1, [a, b]), bundle))
  })

  test('two keys of the same Admin count as one, and one key listed twice is refused', async () => {
    const a = await admin('alex')
    const a2 = { ...(await admin('alex')) } // a second device of the same Admin
    const b = await admin('bjarke')
    const { state } = await paired([a, a2, b], { releases: 2, keys: 1, domains: 1 })
    expect(await acceptRelease(state, await release(bundle, 1, [a, a2]), bundle)).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    expect(await acceptRelease(state, await release(bundle, 1, [a, a]), bundle)).toMatchObject({
      ok: false,
      code: 'duplicate-signer',
    })
  })

  test('a rollback needs only one Admin, even with two required for releases (plan §13.9)', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 2, domains: 1 })
    const s1 = ok(await acceptRelease(state, await release(bundle, 1, [a, b]), bundle)).state
    ok(await acceptRelease(s1, await release(bundle, 2, [a], { contentOf: 1 }), bundle))
  })
})

describe('key chain and pairing (spike 1 Do 5, decisions #25)', () => {
  test('genesis is accepted only once, and only with the confirmed fingerprint', async () => {
    const a = await admin('alex')
    const app = await appKey()
    const start = emptyState({
      appOrigin: APP,
      rpId: RP,
      target: TARGET,
      appSigningKey: app.publicKey,
    })
    const genesis = await command(
      { command: 'trust-keys', sequence: 1, args: { genesis: true, add: [a.key] } },
      [a],
    )
    expect(validCommand(genesis)).toBe(true)
    expect(await acceptCommand(start, genesis, { now: NOW })).toMatchObject({
      ok: false,
      code: 'fingerprint-not-confirmed',
    })
    expect(
      await acceptCommand(start, genesis, { now: NOW, confirmedFingerprint: 'SHA256:wrong' }),
    ).toMatchObject({ ok: false, code: 'fingerprint-not-confirmed' })
    const fp = await genesisFingerprint(genesis)
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/)
    const s = ok(await acceptCommand(start, genesis, { now: NOW, confirmedFingerprint: fp })).state
    const again = await command(
      { command: 'trust-keys', sequence: 2, args: { genesis: true, add: [a.key] } },
      [a],
    )
    expect(
      await acceptCommand(s, again, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(again),
      }),
    ).toMatchObject({
      ok: false,
      code: 'already-paired',
    })
  })

  test('genesis must be signed by a key it contains', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const app = await appKey()
    const start = emptyState({
      appOrigin: APP,
      rpId: RP,
      target: TARGET,
      appSigningKey: app.publicKey,
    })
    const genesis = await command(
      { command: 'trust-keys', sequence: 1, args: { genesis: true, add: [a.key] } },
      [b],
    )
    expect(
      await acceptCommand(start, genesis, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(genesis),
      }),
    ).toMatchObject({ ok: false, code: 'unknown-key' })
  })

  test('a new Admin key is accepted when an existing Admin signs it, and can then sign releases', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a])
    const add = await command({ command: 'trust-keys', sequence: 2, args: { add: [b.key] } }, [a])
    expect(validCommand(add)).toBe(true)
    const s = ok(await acceptCommand(state, add, { now: NOW })).state
    ok(await acceptRelease(s, await release(bundle, 1, [b]), bundle))
  })

  test('a key that signs its own way in is refused (a compromised app adding its own key)', async () => {
    const a = await admin('alex')
    const evil = await admin('app')
    const { state } = await paired([a])
    const add = await command({ command: 'trust-keys', sequence: 2, args: { add: [evil.key] } }, [
      evil,
    ])
    expect(await acceptCommand(state, add, { now: NOW })).toMatchObject({
      ok: false,
      code: 'unknown-key',
    })
  })

  test('with two required for keys, adding one needs two Admins', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const c = await admin('rune')
    const { state } = await paired([a, b], { releases: 1, keys: 2, domains: 1 })
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

  test('lowering the two-person rule needs the current rule', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 2, keys: 2, domains: 2 })
    const lower = { releases: 1, keys: 1, domains: 1 } as const
    const one = await command({ command: 'trust-keys', sequence: 2, args: { policy: lower } }, [a])
    expect(await acceptCommand(state, one, { now: NOW })).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    const two = await command({ command: 'trust-keys', sequence: 2, args: { policy: lower } }, [
      a,
      b,
    ])
    const s = ok(await acceptCommand(state, two, { now: NOW })).state
    expect(s.policy).toEqual(lower)
  })

  test('removing every key, adding a known key or adding a known public key is refused', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const removeAll = await command(
      { command: 'trust-keys', sequence: 2, args: { remove: [a.key.keyId] } },
      [a],
    )
    expect(await acceptCommand(state, removeAll, { now: NOW })).toMatchObject({
      ok: false,
      code: 'would-remove-all-keys',
    })
    const sameKey = await command(
      { command: 'trust-keys', sequence: 2, args: { add: [{ ...a.key, keyId: 'b3RoZXI' }] } },
      [a],
    )
    expect(await acceptCommand(state, sameKey, { now: NOW })).toMatchObject({
      ok: false,
      code: 'duplicate-key',
    })
  })
})

describe('commands (spike 2 groundwork, decisions #1, #26)', () => {
  test('freeze is accepted on the app signature alone; unfreeze needs a passkey', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    const freeze = await app.sign({ command: 'freeze', sequence: 2 })
    expect(validCommand(freeze)).toBe(true)
    const frozen = ok(await acceptCommand(state, freeze, { now: NOW })).state
    expect(frozen.frozen).toBe(true)
    const appUnfreeze = await app.sign({ command: 'unfreeze', sequence: 3 })
    expect(validCommand(appUnfreeze)).toBe(false)
    expect(await acceptCommand(frozen, appUnfreeze, { now: NOW })).toMatchObject({
      ok: false,
      code: 'passkey-required',
    })
    const unfreeze = await command({ command: 'unfreeze', sequence: 3 }, [a])
    expect(ok(await acceptCommand(frozen, unfreeze, { now: NOW })).state.frozen).toBe(false)
  })

  test('a replayed, older, expired or misaddressed command is refused', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    const freeze = await app.sign({ command: 'freeze', sequence: 2 })
    const s = ok(await acceptCommand(state, freeze, { now: NOW })).state
    expect(await acceptCommand(s, freeze, { now: NOW })).toMatchObject({
      ok: false,
      code: 'replayed',
    })
    expect(
      await acceptCommand(s, await app.sign({ command: 'freeze', sequence: 1 }), { now: NOW }),
    ).toMatchObject({
      ok: false,
      code: 'replayed',
    })
    const expired = await app.sign({
      command: 'freeze',
      sequence: 3,
      expires: '2026-10-19T11:59:59Z',
    })
    expect(await acceptCommand(s, expired, { now: NOW })).toMatchObject({
      ok: false,
      code: 'expired',
    })
    const elsewhere = await app.sign({ command: 'freeze', sequence: 3, target: 'pre-production' })
    expect(await acceptCommand(s, elsewhere, { now: NOW })).toMatchObject({
      ok: false,
      code: 'wrong-target',
    })
  })

  test('a freeze with a changed field or a wrong app key is refused', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    const freeze = await app.sign({ command: 'freeze', sequence: 2 })
    expect(await acceptCommand(state, { ...freeze, sequence: 3 }, { now: NOW })).toMatchObject({
      ok: false,
      code: 'bad-app-signature',
    })
    const other = await appKey()
    expect(
      await acceptCommand(state, await other.sign({ command: 'freeze', sequence: 2 }), {
        now: NOW,
      }),
    ).toMatchObject({
      ok: false,
      code: 'bad-app-signature',
    })
  })

  test('a release signature cannot be reused as a command signature', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const rel = await release(bundle, 1, [a])
    const unfreeze = {
      command: 'unfreeze',
      sequence: 2,
      target: TARGET,
      expires: LATER,
      signatures: [{ by: 'admin-passkey', ...(rel.signatures[0] as object) }],
    }
    expect(await acceptCommand(state, unfreeze, { now: NOW })).toMatchObject({
      ok: false,
      code: 'challenge-mismatch',
    })
  })

  test('an unknown command or a broken file is refused without throwing', async () => {
    const a = await admin('alex')
    const { state, app } = await paired([a])
    expect(
      await acceptCommand(state, await app.sign({ command: 'delete-everything', sequence: 2 }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false })
    expect(await acceptCommand(state, { command: 'freeze' }, { now: NOW })).toMatchObject({
      ok: false,
    })
    expect(await acceptCommand(state, 'nonsense', { now: NOW })).toMatchObject({ ok: false })
  })
})
