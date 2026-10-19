// Minimal strict CBOR decoder for WebAuthn: attestation objects, authenticator extensions and
// COSE keys. Definite lengths only; no tags, floats or indefinite items. Anything else throws.
import type { Bytes } from '../bytes.ts'
import { utf8 } from '../bytes.ts'

export type CborValue =
  | number
  | string
  | Bytes
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<number | string, CborValue>

const MAX_DEPTH = 8

export class CborError extends Error {}

export function decodeCbor(data: Bytes): CborValue {
  const { value, end } = decodeCborPrefix(data, 0)
  if (end !== data.length) throw new CborError('trailing bytes')
  return value
}

/** Decode one item starting at `offset`; returns where it ends. */
export function decodeCborPrefix(data: Bytes, offset: number): { value: CborValue; end: number } {
  const state = { pos: offset }
  const value = item(data, state, 0)
  return { value, end: state.pos }
}

function need(data: Bytes, state: { pos: number }, n: number): void {
  if (n < 0 || state.pos + n > data.length) throw new CborError('truncated')
}

function argument(data: Bytes, state: { pos: number }, info: number): number {
  if (info < 24) return info
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
  if (size === 0) throw new CborError(`unsupported additional info ${info}`)
  need(data, state, size)
  let n = 0
  for (let i = 0; i < size; i++) n = n * 256 + (data[state.pos + i] ?? 0)
  state.pos += size
  if (!Number.isSafeInteger(n)) throw new CborError('integer too large')
  return n
}

function item(data: Bytes, state: { pos: number }, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError('nested too deeply')
  need(data, state, 1)
  const first = data[state.pos++] ?? 0
  const major = first >> 5
  const info = first & 0x1f
  if (info === 31) throw new CborError('indefinite length')

  switch (major) {
    case 0:
      return argument(data, state, info)
    case 1:
      return -1 - argument(data, state, info)
    case 2: {
      const n = argument(data, state, info)
      need(data, state, n)
      const out = data.slice(state.pos, state.pos + n)
      state.pos += n
      return out
    }
    case 3: {
      const n = argument(data, state, info)
      need(data, state, n)
      const out = utf8.decode(data.subarray(state.pos, state.pos + n))
      state.pos += n
      return out
    }
    case 4: {
      const n = argument(data, state, info)
      need(data, state, n) // every item takes at least one byte
      const out: CborValue[] = []
      for (let i = 0; i < n; i++) out.push(item(data, state, depth + 1))
      return out
    }
    case 5: {
      const n = argument(data, state, info)
      need(data, state, n * 2)
      const out = new Map<number | string, CborValue>()
      for (let i = 0; i < n; i++) {
        const key = item(data, state, depth + 1)
        if (typeof key !== 'number' && typeof key !== 'string') throw new CborError('map key type')
        if (out.has(key)) throw new CborError('duplicate map key')
        out.set(key, item(data, state, depth + 1))
      }
      return out
    }
    case 7:
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 23) return undefined
      throw new CborError(`unsupported simple value ${info}`)
    default:
      throw new CborError(`unsupported major type ${major}`)
  }
}
