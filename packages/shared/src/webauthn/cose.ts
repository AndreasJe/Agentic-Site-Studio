// COSE public keys (RFC 9053) → Web Crypto keys, and signature checks per algorithm.
import { type Bytes, toBase64Url } from '../bytes.ts'
import { type CborValue, decodeCbor } from './cbor.ts'
import { derToRaw } from './signature.ts'

/** ES256, EdDSA (Ed25519), RS256: what we offer in pubKeyCredParams. */
export const SUPPORTED_ALGS = [-7, -8, -257] as const
export type CoseAlg = (typeof SUPPORTED_ALGS)[number]

export type PublicKey = { alg: CoseAlg; key: CryptoKey }

export class CoseError extends Error {}

function bytesAt(m: Map<number | string, CborValue>, label: number, length?: number): Bytes {
  const v = m.get(label)
  if (!(v instanceof Uint8Array)) throw new CoseError(`COSE label ${label} missing`)
  if (length !== undefined && v.length !== length) throw new CoseError(`COSE label ${label} length`)
  return v
}

export function coseAlgOf(cose: Bytes): number {
  const m = decodeCbor(cose)
  if (!(m instanceof Map)) throw new CoseError('COSE key is not a map')
  const alg = m.get(3)
  if (typeof alg !== 'number') throw new CoseError('COSE alg missing')
  return alg
}

export async function importCoseKey(cose: Bytes): Promise<PublicKey> {
  const m = decodeCbor(cose)
  if (!(m instanceof Map)) throw new CoseError('COSE key is not a map')
  const kty = m.get(1)
  const alg = m.get(3)

  if (kty === 2 && alg === -7) {
    if (m.get(-1) !== 1) throw new CoseError('ES256 needs curve P-256')
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(bytesAt(m, -2, 32)),
      y: toBase64Url(bytesAt(m, -3, 32)),
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return { alg: -7, key }
  }
  if (kty === 1 && alg === -8) {
    if (m.get(-1) !== 6) throw new CoseError('EdDSA needs curve Ed25519')
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(bytesAt(m, -2, 32)) }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
    return { alg: -8, key }
  }
  if (kty === 3 && alg === -257) {
    const n = bytesAt(m, -1)
    if (n.length < 256) throw new CoseError('RSA key shorter than 2048 bits')
    const jwk = { kty: 'RSA', n: toBase64Url(n), e: toBase64Url(bytesAt(m, -2)) }
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return { alg: -257, key }
  }
  throw new CoseError(`unsupported COSE key (kty ${String(kty)}, alg ${String(alg)})`)
}

export async function verifyCoseSignature(
  pk: PublicKey,
  signature: Bytes,
  data: Bytes,
): Promise<boolean> {
  if (pk.alg === -7) {
    let raw: Bytes
    try {
      raw = derToRaw(signature)
    } catch {
      return false
    }
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk.key, raw, data)
  }
  if (pk.alg === -8) return crypto.subtle.verify({ name: 'Ed25519' }, pk.key, signature, data)
  return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, pk.key, signature, data)
}
