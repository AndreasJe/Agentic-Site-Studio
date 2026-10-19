// Authenticator data (WebAuthn §6.1) and client data JSON (§5.8.1) parsing. Strict: every byte of
// authenticator data must be accounted for.
import { type Bytes, utf8 } from '../bytes.ts'
import { decodeCborPrefix } from './cbor.ts'

export type Flags = { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean }

export type AuthenticatorData = {
  rpIdHash: Bytes
  flags: Flags
  signCount: number
  attested?: { aaguid: Bytes; credentialId: Bytes; publicKey: Bytes }
}

export type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean }

export class ParseError extends Error {}

export function parseAuthenticatorData(data: Bytes): AuthenticatorData {
  if (data.length < 37) throw new ParseError('authenticator data shorter than 37 bytes')
  const f = data[32] ?? 0
  const flags: Flags = {
    up: (f & 0x01) !== 0,
    uv: (f & 0x04) !== 0,
    be: (f & 0x08) !== 0,
    bs: (f & 0x10) !== 0,
    at: (f & 0x40) !== 0,
    ed: (f & 0x80) !== 0,
  }
  const signCount = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0)
  const result: AuthenticatorData = { rpIdHash: data.slice(0, 32), flags, signCount }
  let pos = 37

  if (flags.at) {
    if (data.length < pos + 18) throw new ParseError('attested credential data truncated')
    const aaguid = data.slice(pos, pos + 16)
    const idLen = ((data[pos + 16] ?? 0) << 8) | (data[pos + 17] ?? 0)
    pos += 18
    if (idLen === 0 || idLen > 1023 || data.length < pos + idLen)
      throw new ParseError('credential id length')
    const credentialId = data.slice(pos, pos + idLen)
    pos += idLen
    const { end } = decodeCborPrefix(data, pos)
    result.attested = { aaguid, credentialId, publicKey: data.slice(pos, end) }
    pos = end
  }
  if (flags.ed) {
    const { value, end } = decodeCborPrefix(data, pos)
    if (!(value instanceof Map)) throw new ParseError('extensions must be a map')
    pos = end
  }
  if (pos !== data.length) throw new ParseError('trailing bytes in authenticator data')
  return result
}

export function parseClientData(json: Bytes): ClientData {
  const value: unknown = JSON.parse(utf8.decode(json))
  if (typeof value !== 'object' || value === null)
    throw new ParseError('client data is not an object')
  const { type, challenge, origin, crossOrigin } = value as Record<string, unknown>
  if (typeof type !== 'string' || typeof challenge !== 'string' || typeof origin !== 'string') {
    throw new ParseError('client data missing type, challenge or origin')
  }
  if (crossOrigin !== undefined && typeof crossOrigin !== 'boolean')
    throw new ParseError('crossOrigin type')
  return { type, challenge, origin, crossOrigin }
}
