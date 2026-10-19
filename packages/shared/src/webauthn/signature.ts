// Signature formats: authenticators send ES256 signatures as ASN.1 DER, Web Crypto wants raw r||s.

/** Strict DER ECDSA-Sig-Value → 64-byte r||s for P-256. Throws on anything non-canonical. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  let pos = 0
  const byte = () => {
    if (pos >= der.length) throw new Error('truncated DER')
    return der[pos++] ?? 0
  }
  if (byte() !== 0x30) throw new Error('DER: expected SEQUENCE')
  const seqLen = byte()
  if (seqLen & 0x80) throw new Error('DER: long-form length')
  if (seqLen !== der.length - 2) throw new Error('DER: sequence length')

  const integer = (): Uint8Array => {
    if (byte() !== 0x02) throw new Error('DER: expected INTEGER')
    const len = byte()
    if (len === 0 || len & 0x80) throw new Error('DER: integer length')
    if (pos + len > der.length) throw new Error('truncated DER')
    const v = der.subarray(pos, pos + len)
    pos += len
    if ((v[0] ?? 0) & 0x80) throw new Error('DER: negative integer')
    if (v.length > 1 && v[0] === 0 && !((v[1] ?? 0) & 0x80))
      throw new Error('DER: non-minimal integer')
    const trimmed = v[0] === 0 ? v.subarray(1) : v
    if (trimmed.length > size) throw new Error('DER: integer too large')
    return trimmed
  }

  const r = integer()
  const s = integer()
  if (pos !== der.length) throw new Error('DER: trailing bytes')
  const out = new Uint8Array(size * 2)
  out.set(r, size - r.length)
  out.set(s, size * 2 - s.length)
  return out
}
