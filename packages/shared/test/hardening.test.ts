// Checks the first security review found untested, plus a mutation fuzz: hostile input must always
// be refused, never accepted and never thrown.
import { describe, expect, test } from 'bun:test'
import { type Bytes, concat, sha256, toBase64Url, utf8 } from '../src/bytes.ts'
import { CborError, decodeCbor } from '../src/webauthn/cbor.ts'
import { importCoseKey, isSmallOrderEd25519 } from '../src/webauthn/cose.ts'
import {
  parseAuthenticatorData,
  verifyAssertion,
  verifyRegistration,
} from '../src/webauthn/index.ts'
import { derToRaw } from '../src/webauthn/signature.ts'
import { encodeCbor, SoftAuthenticator } from './soft-authenticator.ts'

const ORIGIN = 'http://localhost:3000'
const RP_ID = 'localhost'
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16))
const challenge = () => crypto.getRandomValues(new Uint8Array(32))

async function setup(alg: -7 | -8 | -257 = -7) {
  const auth = await SoftAuthenticator.create(alg)
  const c = challenge()
  const reg = await verifyRegistration({
    ...(await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID })),
    expectedChallenge: c,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  })
  if (!reg.ok) throw new Error(reg.code)
  return { auth, credential: reg.credential }
}

describe('COSE keys', () => {
  const cose = (entries: [number, number | Bytes][]) => encodeCbor(new Map(entries))

  test('refuses a wrong curve, a kty/alg mismatch and an unknown algorithm', async () => {
    const x = new Uint8Array(32).fill(1)
    await expect(
      importCoseKey(
        cose([
          [1, 2],
          [3, -7],
          [-1, 2],
          [-2, x],
          [-3, x],
        ]),
      ),
    ).rejects.toThrow('P-256')
    await expect(
      importCoseKey(
        cose([
          [1, 2],
          [3, -8],
          [-1, 1],
          [-2, x],
          [-3, x],
        ]),
      ),
    ).rejects.toThrow()
    await expect(
      importCoseKey(
        cose([
          [1, 1],
          [3, -8],
          [-1, 7],
          [-2, x],
        ]),
      ),
    ).rejects.toThrow('Ed25519')
    await expect(
      importCoseKey(
        cose([
          [1, 2],
          [3, -35],
          [-1, 2],
          [-2, x],
          [-3, x],
        ]),
      ),
    ).rejects.toThrow()
  })

  test('refuses an EC point that is not on the curve', async () => {
    const x = new Uint8Array(32).fill(1)
    await expect(
      importCoseKey(
        cose([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, x],
          [-3, x],
        ]),
      ),
    ).rejects.toThrow()
  })

  test('refuses RSA moduli under 2048 bits, even when padded with zeros, and exponents other than 65537', async () => {
    const n2048 = concat(new Uint8Array([0xc1]), crypto.getRandomValues(new Uint8Array(255)))
    const e = new Uint8Array([1, 0, 1])
    const short = crypto.getRandomValues(new Uint8Array(128))
    const padded = concat(new Uint8Array(128), short)
    await expect(
      importCoseKey(
        cose([
          [1, 3],
          [3, -257],
          [-1, short],
          [-2, e],
        ]),
      ),
    ).rejects.toThrow('2048')
    await expect(
      importCoseKey(
        cose([
          [1, 3],
          [3, -257],
          [-1, padded],
          [-2, e],
        ]),
      ),
    ).rejects.toThrow('2048')
    await expect(
      importCoseKey(
        cose([
          [1, 3],
          [3, -257],
          [-1, n2048],
          [-2, new Uint8Array([3])],
        ]),
      ),
    ).rejects.toThrow('65537')
  })

  test('refuses every small-order Ed25519 key, with and without the sign bit', async () => {
    const blocked = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ]
    for (const k of blocked) {
      const x = hex(k)
      const signed = x.slice()
      signed[31] = (signed[31] ?? 0) | 0x80
      expect(isSmallOrderEd25519(x)).toBe(true)
      expect(isSmallOrderEd25519(signed)).toBe(true)
      await expect(
        importCoseKey(
          cose([
            [1, 1],
            [3, -8],
            [-1, 6],
            [-2, x],
          ]),
        ),
      ).rejects.toThrow('small order')
    }
  })

  test('an identity-point key with the universal forged signature is refused at assertion', async () => {
    const { auth, credential } = await setup(-8)
    const identity = cose([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, hex(`01${'00'.repeat(31)}`)],
    ])
    const c = challenge()
    const a = await auth.assert({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    const forged = concat(hex(`01${'00'.repeat(31)}`), new Uint8Array(32))
    const result = await verifyAssertion({
      credential: { ...credential, publicKey: identity },
      ...a,
      signature: forged,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'bad-signature' })
  })
})

describe('assertion rules', () => {
  test('refuses when the stored algorithm differs from the key', async () => {
    const { auth, credential } = await setup(-7)
    const c = challenge()
    const a = await auth.assert({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    const result = await verifyAssertion({
      credential: { ...credential, alg: -8 },
      ...a,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-alg' })
  })

  test('refuses a stored credential whose algorithm is no longer allowed', async () => {
    const { auth, credential } = await setup(-257)
    const c = challenge()
    const a = await auth.assert({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    const result = await verifyAssertion({
      credential,
      ...a,
      allowedAlgs: [-7, -8],
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-alg' })
  })

  // Build signed assertions with hand-set flags, so only the flag rule can refuse them.
  async function withFlags(flags: number, extra: Bytes = new Uint8Array()) {
    const { credential } = await setup(-8)
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
    const x = Uint8Array.from(atob((jwk.x ?? '').replaceAll('-', '+').replaceAll('_', '/')), (ch) =>
      ch.charCodeAt(0),
    )
    const publicKey = encodeCbor(
      new Map<number, number | Bytes>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, x],
      ]),
    )
    const c = challenge()
    const authenticatorData = concat(
      await sha256(utf8.encode(RP_ID)),
      new Uint8Array([flags, 0, 0, 0, 0]),
      extra,
    )
    const clientDataJSON = utf8.encode(
      JSON.stringify({ type: 'webauthn.get', challenge: toBase64Url(c), origin: ORIGIN }),
    )
    const signed = concat(authenticatorData, await sha256(clientDataJSON))
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, signed),
    )
    return verifyAssertion({
      credential: { ...credential, publicKey },
      authenticatorData,
      clientDataJSON,
      signature,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    })
  }

  test('accepts the hand-built baseline (UP + UV)', async () => {
    expect(await withFlags(0x05)).toMatchObject({ ok: true })
  })

  test('refuses "backed up" without "backup eligible"', async () => {
    expect(await withFlags(0x05 | 0x10)).toMatchObject({ ok: false, code: 'malformed' })
    expect(await withFlags(0x05 | 0x10 | 0x08)).toMatchObject({ ok: true, backedUp: true })
  })

  test('refuses credential data inside an assertion', async () => {
    const attested = concat(
      new Uint8Array(16),
      new Uint8Array([0, 1, 7]),
      encodeCbor(new Map([[1, 1]])),
    )
    expect(await withFlags(0x05 | 0x40, attested)).toMatchObject({ ok: false, code: 'malformed' })
  })

  test('accepts an extensions map and refuses extensions that are not a map', async () => {
    expect(await withFlags(0x05 | 0x80, encodeCbor(new Map([['credProtect', 1]])))).toMatchObject({
      ok: true,
    })
    expect(await withFlags(0x05 | 0x80, encodeCbor('x'))).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })
})

describe('authenticator data bounds', () => {
  const base = new Uint8Array(37)
  base[32] = 0x45 // UP, UV, AT
  const att = (idLen: number, rest: Bytes) =>
    concat(base, new Uint8Array(16), new Uint8Array([idLen >> 8, idLen & 0xff]), rest)

  test('refuses a credential ID of length 0, over 1023, or past the end', () => {
    const key = encodeCbor(new Map([[1, 2]]))
    expect(() => parseAuthenticatorData(att(0, key))).toThrow('credential id length')
    expect(() => parseAuthenticatorData(att(1024, concat(new Uint8Array(1024), key)))).toThrow(
      'credential id length',
    )
    expect(() => parseAuthenticatorData(att(50, new Uint8Array(10)))).toThrow(
      'credential id length',
    )
  })
})

describe('CBOR', () => {
  const bad: [string, number[]][] = [
    ['duplicate map keys', [0xa2, 0x01, 0x01, 0x01, 0x02]],
    ['a tag', [0xc0, 0x01]],
    ['a float', [0xf9, 0x00, 0x00]],
    ['a byte-string map key', [0xa1, 0x41, 0x00, 0x01]],
    ['an integer beyond 2^53', [0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]],
    ['trailing bytes', [0x01, 0x02]],
    ['a truncated byte string', [0x45, 0x01]],
    ['a huge array length', [0x9a, 0xff, 0xff, 0xff, 0xff]],
    ['indefinite length', [0x9f, 0xff]],
    ['reserved additional info', [0x1c]],
  ]
  for (const [name, bytes] of bad) {
    test(`refuses ${name}`, () => {
      expect(() => decodeCbor(new Uint8Array(bytes))).toThrow(CborError)
    })
  }

  test('refuses nesting deeper than 8', () => {
    expect(() => decodeCbor(new Uint8Array([...Array(10).fill(0x81), 0x01]))).toThrow('nested')
  })

  test('refuses invalid UTF-8 in text', () => {
    expect(() => decodeCbor(new Uint8Array([0x61, 0xff]))).toThrow()
  })
})

describe('DER', () => {
  test('refuses a zero-length integer and an over-long one', () => {
    const r = new Uint8Array(32).fill(1)
    expect(() => derToRaw(new Uint8Array([0x30, 36, 0x02, 0, 0x02, 32, ...r]))).toThrow(
      'integer length',
    )
    const long = new Uint8Array(33).fill(1)
    expect(() => derToRaw(new Uint8Array([0x30, 69, 0x02, 33, ...long, 0x02, 32, ...r]))).toThrow(
      'too large',
    )
  })
})

describe('mutation fuzz', () => {
  // Deterministic, so a failure reproduces.
  let seed = 0x5eed
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const mutate = (b: Bytes): Bytes => {
    const out = b.slice()
    const kind = rand(3)
    if (kind === 0 && out.length > 0) out[rand(out.length)] = rand(256)
    if (kind === 1) return out.slice(0, rand(out.length + 1))
    if (kind === 2) return concat(out, new Uint8Array([rand(256)]))
    return out
  }

  for (const alg of [-7, -8, -257] as const) {
    test(`mutated assertions are refused and never throw (alg ${alg})`, async () => {
      const { auth, credential } = await setup(alg)
      const c = challenge()
      const a = await auth.assert({ challenge: c, origin: ORIGIN, rpId: RP_ID })
      const fields = ['authenticatorData', 'clientDataJSON', 'signature'] as const
      for (let i = 0; i < 150; i++) {
        const field = fields[i % 3] as (typeof fields)[number]
        const mutated = mutate(a[field])
        if (mutated.length === a[field].length && mutated.every((v, j) => v === a[field][j]))
          continue
        const result = await verifyAssertion({
          credential,
          ...a,
          [field]: mutated,
          expectedChallenge: c,
          expectedOrigin: ORIGIN,
          rpId: RP_ID,
        })
        expect(result.ok).toBe(false)
      }
    })
  }

  test('mutated registrations never throw', async () => {
    const auth = await SoftAuthenticator.create()
    const c = challenge()
    const reg = await auth.register({ challenge: c, origin: ORIGIN, rpId: RP_ID })
    for (let i = 0; i < 200; i++) {
      const result = await verifyRegistration({
        attestationObject: i % 2 ? mutate(reg.attestationObject) : reg.attestationObject,
        clientDataJSON: i % 2 ? reg.clientDataJSON : mutate(reg.clientDataJSON),
        expectedChallenge: c,
        expectedOrigin: ORIGIN,
        rpId: RP_ID,
      })
      expect(typeof result.ok).toBe('boolean')
    }
  })
})
