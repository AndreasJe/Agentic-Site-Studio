// Spike 1 (docs/spikes/01-passkey-signed-release.md), verifier core: everything production must
// check on a passkey assertion except the release-specific challenge layout (open question A1).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Bytes, concat } from '../src/bytes.ts'
import { decodeCbor } from '../src/webauthn/cbor.ts'
import { type Credential, verifyAssertion, verifyRegistration } from '../src/webauthn/index.ts'
import { derToRaw } from '../src/webauthn/signature.ts'
import { type Alg, encodeCbor, SoftAuthenticator } from './soft-authenticator.ts'

const ORIGIN = 'http://localhost:3000'
const RP_ID = 'localhost'
const ALGS: Alg[] = [-7, -8, -257]

const challenge = () => crypto.getRandomValues(new Uint8Array(32))
const flip = (b: Bytes, i: number) => {
  const c = b.slice()
  c[i] = (c[i] ?? 0) ^ 0x01
  return c
}

async function registered(alg: Alg = -7) {
  const auth = await SoftAuthenticator.create(alg)
  const c = challenge()
  const reg = await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID })
  const result = await verifyRegistration({
    ...reg,
    expectedChallenge: c,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  })
  if (!result.ok) throw new Error(`registration failed: ${result.code}`)
  return { auth, credential: result.credential }
}

async function assertWith(
  auth: SoftAuthenticator,
  credential: Credential,
  tamper: Partial<Parameters<SoftAuthenticator['assert']>[0]> = {},
  expect_: { challenge?: Bytes; origin?: string; rpId?: string } = {},
) {
  const c = challenge()
  const a = await auth.assert({ challenge: c, origin: ORIGIN, rpId: RP_ID, ...tamper })
  return {
    a,
    run: (over: Partial<typeof a> = {}) =>
      verifyAssertion({
        credential,
        ...a,
        ...over,
        expectedChallenge: expect_.challenge ?? c,
        expectedOrigin: expect_.origin ?? ORIGIN,
        rpId: expect_.rpId ?? RP_ID,
      }),
  }
}

describe('registration', () => {
  for (const alg of ALGS) {
    test(`accepts a valid registration (alg ${alg})`, async () => {
      const { auth, credential } = await registered(alg)
      expect(credential.alg).toBe(alg)
      expect(credential.id).toEqual(auth.credentialId)
      expect(credential.signCount).toBe(0)
    })
  }

  test.each([
    ['wrong type', { type: 'webauthn.get' }, 'bad-type'],
    ['another origin', { origin: 'http://127.0.0.1:3001' }, 'origin-mismatch'],
    ['cross-origin iframe', { crossOrigin: true }, 'cross-origin'],
    ['another rpId', { rpIdForHash: 'studio.internal' }, 'rpid-mismatch'],
    ['no user presence', { up: false }, 'user-not-present'],
    ['no user verification', { uv: false }, 'user-not-verified'],
  ] as const)('refuses %s', async (_name, tamper, code) => {
    const auth = await SoftAuthenticator.create()
    const c = challenge()
    const reg = await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID, ...tamper })
    const result = await verifyRegistration({
      ...reg,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code })
  })

  test('refuses another challenge', async () => {
    const auth = await SoftAuthenticator.create()
    const reg = await auth.register({ challenge: challenge(), origin: ORIGIN, rpId: RP_ID })
    const result = await verifyRegistration({
      ...reg,
      expectedChallenge: challenge(),
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'challenge-mismatch' })
  })

  test('refuses an algorithm that was not offered', async () => {
    const auth = await SoftAuthenticator.create(-257)
    const c = challenge()
    const reg = await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    const result = await verifyRegistration({
      ...reg,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
      allowedAlgs: [-7, -8],
    })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-alg' })
  })

  test('refuses an attestation object without credential data', async () => {
    const auth = await SoftAuthenticator.create()
    const c = challenge()
    const reg = await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    const att = decodeCbor(reg.attestationObject) as Map<string, unknown>
    const authData = att.get('authData') as Bytes
    const bare = authData.slice(0, 37)
    bare[32] = (bare[32] ?? 0) & ~0x40
    const attestationObject = encodeCbor(
      new Map<string, never>([
        ['fmt', 'none' as never],
        ['attStmt', new Map() as never],
        ['authData', bare as never],
      ]),
    )
    const result = await verifyRegistration({
      ...reg,
      attestationObject,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'malformed' })
  })

  test('refuses garbage instead of CBOR', async () => {
    const auth = await SoftAuthenticator.create()
    const c = challenge()
    const reg = await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    const result = await verifyRegistration({
      ...reg,
      attestationObject: new Uint8Array([0xbf, 0xff, 0x00]),
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'malformed' })
  })
})

describe('assertion', () => {
  for (const alg of ALGS) {
    test(`accepts a valid assertion (alg ${alg})`, async () => {
      const { auth, credential } = await registered(alg)
      const { run } = await assertWith(auth, credential)
      const result = await run()
      expect(result).toMatchObject({ ok: true, signCount: 0 })
    })

    test(`refuses a changed byte in authenticatorData, clientDataJSON or signature (alg ${alg})`, async () => {
      const { auth, credential } = await registered(alg)
      const { a, run } = await assertWith(auth, credential)
      // byte 33 is in the signed counter, so only the signature check catches the change
      const longer = concat(a.authenticatorData, new Uint8Array([0]))
      expect(await run({ authenticatorData: flip(a.authenticatorData, 33) })).toMatchObject({
        ok: false,
      })
      expect(await run({ authenticatorData: longer })).toMatchObject({ ok: false })
      const json = new TextDecoder().decode(a.clientDataJSON).replace('}', ',"x":1}')
      expect(await run({ clientDataJSON: new TextEncoder().encode(json) })).toMatchObject({
        ok: false,
        code: 'bad-signature',
      })
      expect(await run({ signature: flip(a.signature, a.signature.length - 1) })).toMatchObject({
        ok: false,
      })
    })
  }

  test('refuses another challenge', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, credential, {}, { challenge: challenge() })
    expect(await run()).toMatchObject({ ok: false, code: 'challenge-mismatch' })
  })

  test('refuses another origin, including the preview address', async () => {
    const { auth, credential } = await registered()
    for (const origin of [
      'http://127.0.0.1:3001',
      'http://localhost:3001',
      'https://localhost:3000',
    ]) {
      const { run } = await assertWith(auth, credential, { origin })
      expect(await run()).toMatchObject({ ok: false, code: 'origin-mismatch' })
    }
  })

  test('refuses a cross-origin (framed) assertion', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, credential, { crossOrigin: true })
    expect(await run()).toMatchObject({ ok: false, code: 'cross-origin' })
  })

  test('refuses another rpId hash', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, credential, { rpIdForHash: 'example.com' })
    expect(await run()).toMatchObject({ ok: false, code: 'rpid-mismatch' })
  })

  test('refuses a missing user-verification flag', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, credential, { uv: false })
    expect(await run()).toMatchObject({ ok: false, code: 'user-not-verified' })
  })

  test('refuses a missing user-presence flag', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, credential, { up: false })
    expect(await run()).toMatchObject({ ok: false, code: 'user-not-present' })
  })

  test('refuses a registration ceremony replayed as an assertion', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, credential, { type: 'webauthn.create' })
    expect(await run()).toMatchObject({ ok: false, code: 'bad-type' })
  })

  test('refuses a signature from another key', async () => {
    const { credential } = await registered()
    const other = await SoftAuthenticator.create()
    const { run } = await assertWith(other, credential)
    expect(await run()).toMatchObject({ ok: false, code: 'bad-signature' })
  })

  test('ignores a signature counter of 0 (synced passkeys)', async () => {
    const { auth, credential } = await registered()
    const { run } = await assertWith(auth, { ...credential, signCount: 7 }, { signCount: 0 })
    expect(await run()).toMatchObject({ ok: true, signCount: 0 })
  })

  test('refuses a counter that went backwards, accepts one that went up', async () => {
    const { auth, credential } = await registered()
    const back = await assertWith(auth, { ...credential, signCount: 5 }, { signCount: 5 })
    expect(await back.run()).toMatchObject({ ok: false, code: 'counter-regressed' })
    const up = await assertWith(auth, { ...credential, signCount: 5 }, { signCount: 6 })
    expect(await up.run()).toMatchObject({ ok: true, signCount: 6 })
  })

  test('refuses truncated authenticatorData and an empty signature without throwing', async () => {
    const { auth, credential } = await registered()
    const { a, run } = await assertWith(auth, credential)
    expect(await run({ authenticatorData: a.authenticatorData.slice(0, 36) })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
    expect(await run({ signature: new Uint8Array() })).toMatchObject({ ok: false })
    expect(await run({ clientDataJSON: new TextEncoder().encode('not json') })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })
})

describe('ES256 signature encoding', () => {
  test('rejects DER with trailing bytes, long-form lengths or non-minimal integers', () => {
    const r = new Uint8Array(32).fill(1)
    const s = new Uint8Array(32).fill(2)
    const good = new Uint8Array([0x30, 68, 0x02, 32, ...r, 0x02, 32, ...s])
    expect(derToRaw(good)).toEqual(concat(r, s))
    expect(() => derToRaw(concat(good, new Uint8Array([0])))).toThrow()
    expect(() =>
      derToRaw(new Uint8Array([0x30, 0x81, 68, 0x02, 32, ...r, 0x02, 32, ...s])),
    ).toThrow()
    expect(() => derToRaw(new Uint8Array([0x30, 69, 0x02, 33, 0, ...r, 0x02, 32, ...s]))).toThrow()
    expect(() =>
      derToRaw(new Uint8Array([0x30, 68, 0x02, 32, 0x80, ...r.slice(1), 0x02, 32, ...s])),
    ).toThrow()
  })
})

describe('offline', () => {
  test('the verifier imports no network module and makes no network calls', () => {
    const dir = join(import.meta.dir, '../src/webauthn')
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text).not.toMatch(/from ['"](node:)?(net|http|https|dgram|dns|tls)['"]/)
      expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/)
    }
  })
})
