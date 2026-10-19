// Test-only software authenticator: produces WebAuthn registration and assertion data the way a
// browser and authenticator would, so every refusal path of the verifier can be exercised.
import { type Bytes, concat, sha256, toBase64Url } from '../src/bytes.ts'

export type Alg = -7 | -8 | -257

type Encodable = number | string | Bytes | Map<number | string, Encodable>

function head(major: number, n: number): Bytes {
  if (n < 24) return new Uint8Array([(major << 5) | n])
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n])
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
  return new Uint8Array([(major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

export function encodeCbor(value: Encodable): Bytes {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const utf8 = new TextEncoder().encode(value)
    return concat(head(3, utf8.length), utf8)
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value)
  const parts: Bytes[] = [head(5, value.size)]
  for (const [k, v] of value) parts.push(encodeCbor(k), encodeCbor(v))
  return concat(...parts)
}

/** Raw r||s (what WebCrypto returns) to the DER form authenticators send for ES256. */
export function rawToDer(raw: Bytes): Bytes {
  const int = (b: Bytes) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v)
    return concat(new Uint8Array([0x02, v.length]), v)
  }
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

function u32(n: number): Bytes {
  return new Uint8Array([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

const b64uToBytes = (s: string) =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

export type CeremonyOptions = {
  challenge: Bytes
  origin: string
  rpId: string
  type?: string
  crossOrigin?: boolean
  up?: boolean
  uv?: boolean
  rpIdForHash?: string
  signCount?: number
}

const encoder = new TextEncoder()

export class SoftAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16))
  signCount = 0

  private constructor(
    readonly alg: Alg,
    private readonly keys: CryptoKeyPair,
  ) {}

  static async create(alg: Alg = -7): Promise<SoftAuthenticator> {
    const params =
      alg === -7
        ? { name: 'ECDSA', namedCurve: 'P-256' }
        : alg === -8
          ? { name: 'Ed25519' }
          : {
              name: 'RSASSA-PKCS1-v1_5',
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: 'SHA-256',
            }
    const keys = (await crypto.subtle.generateKey(params, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    return new SoftAuthenticator(alg, keys)
  }

  async coseKey(): Promise<Bytes> {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey)
    const m = new Map<number, Encodable>()
    if (this.alg === -7) {
      m.set(1, 2)
        .set(3, -7)
        .set(-1, 1)
        .set(-2, b64uToBytes(jwk.x ?? ''))
        .set(-3, b64uToBytes(jwk.y ?? ''))
    } else if (this.alg === -8) {
      m.set(1, 1)
        .set(3, -8)
        .set(-1, 6)
        .set(-2, b64uToBytes(jwk.x ?? ''))
    } else {
      m.set(1, 3)
        .set(3, -257)
        .set(-1, b64uToBytes(jwk.n ?? ''))
        .set(-2, b64uToBytes(jwk.e ?? ''))
    }
    return encodeCbor(m)
  }

  private clientData(o: CeremonyOptions, type: string): Bytes {
    const data: Record<string, unknown> = {
      type: o.type ?? type,
      challenge: toBase64Url(o.challenge),
      origin: o.origin,
    }
    if (o.crossOrigin !== undefined) data.crossOrigin = o.crossOrigin
    return encoder.encode(JSON.stringify(data))
  }

  private async authData(o: CeremonyOptions, attested?: Bytes): Promise<Bytes> {
    const flags = (o.up === false ? 0 : 0x01) | (o.uv === false ? 0 : 0x04) | (attested ? 0x40 : 0)
    const rpIdHash = await sha256(encoder.encode(o.rpIdForHash ?? o.rpId))
    return concat(
      rpIdHash,
      new Uint8Array([flags]),
      u32(o.signCount ?? this.signCount),
      attested ?? new Uint8Array(),
    )
  }

  async register(o: CeremonyOptions) {
    const cose = await this.coseKey()
    const idLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff])
    const attested = concat(new Uint8Array(16), idLen, this.credentialId, cose)
    const authData = await this.authData(o, attested)
    const attestationObject = encodeCbor(
      new Map<string, Encodable>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    )
    return {
      credentialId: this.credentialId,
      attestationObject,
      clientDataJSON: this.clientData(o, 'webauthn.create'),
    }
  }

  async assert(o: CeremonyOptions) {
    const authenticatorData = await this.authData(o)
    const clientDataJSON = this.clientData(o, 'webauthn.get')
    const signed = concat(authenticatorData, await sha256(clientDataJSON))
    const params =
      this.alg === -7
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : this.alg === -8
          ? { name: 'Ed25519' }
          : { name: 'RSASSA-PKCS1-v1_5' }
    const raw = new Uint8Array(await crypto.subtle.sign(params, this.keys.privateKey, signed))
    const signature = this.alg === -7 ? rawToDer(raw) : raw
    return { authenticatorData, clientDataJSON, signature }
  }
}
