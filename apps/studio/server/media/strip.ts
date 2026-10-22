// Metadata stripping on upload (plan §21.3, decision #22, M8.3). Pure TypeScript, no external
// tools. Each function returns new bytes with the descriptive metadata removed and the picture
// untouched; a file that isn't well formed throws StripError, so the upload is refused.
//
// Pending: exiftool (PDF, and a second opinion for images) and ffmpeg (video). Video upload stays
// off until `stripVideo` has a real implementation. PDF metadata is handled elsewhere already.
//
// JPEG: APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), COM and MPF (APP2) go, between scans too, and
// everything after the first EOI; ICC (APP2), JFIF and Adobe stay.
// PNG: tEXt, zTXt, iTXt, eXIf and tIME go; every chunk's CRC is verified.
// WebP: EXIF and XMP chunks go; the RIFF size and the VP8X flags are corrected.
// GIF: comments and application extensions go, except NETSCAPE/ANIMEXTS looping.
// SVG: <metadata> elements and comments go.

export class StripError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripError'
  }
}

const bad = (why: string): never => {
  throw new StripError(`malformed file: ${why}`)
}

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

// --- JPEG ---------------------------------------------------------------------------------------

/** APP1 (EXIF, XMP), APP13 (IPTC), COM, and APP2 when it is an MPF index (not ICC_PROFILE). */
function dropJpegSegment(b: Uint8Array, marker: number, at: number, len: number): boolean {
  if (marker === 0xe1 || marker === 0xed || marker === 0xfe) return true
  return marker === 0xe2 && len >= 6 && ascii(b, at + 4, at + 8) === 'MPF\0'
}

/**
 * Walks the whole marker structure, scans included: in entropy-coded data FF00 and RSTn are data,
 * and any other marker starts a segment that gets the same drop rule (so APP1 or COM between
 * progressive scans goes). The output ends at the first EOI; anything after it (MPF secondary
 * images, an appended preview JPEG with its own EXIF) is dropped.
 */
export function stripJpeg(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) bad('JPEG start marker')
  const out: Uint8Array[] = [b.subarray(0, 2)]
  let at = 2
  let sawFrame = false
  let sawScan = false
  for (;;) {
    if (at + 1 >= b.length) bad('JPEG ended before its end marker')
    if (b[at] !== 0xff) bad('JPEG marker expected')
    const marker = b[at + 1] as number
    if (marker === 0xff) {
      at++ // fill byte
      continue
    }
    if (marker === 0xd9) {
      if (!sawScan) bad('JPEG has no image data')
      out.push(b.subarray(at, at + 2))
      return join(out)
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      bad('JPEG marker out of place')
    }
    if (at + 4 > b.length) bad('JPEG segment length')
    const len = ((b[at + 2] as number) << 8) | (b[at + 3] as number)
    if (len < 2 || at + 2 + len > b.length) bad('JPEG segment overruns the file')
    if (!dropJpegSegment(b, marker, at, len)) out.push(b.subarray(at, at + 2 + len))
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      sawFrame = true
    }
    at += 2 + len
    if (marker === 0xda) {
      if (!sawFrame) bad('JPEG scan before frame header')
      sawScan = true
      // Entropy-coded data: copied up to the next marker that is not FF00 or RSTn.
      const start = at
      for (;;) {
        const p = b.indexOf(0xff, at)
        if (p === -1 || p + 1 >= b.length) bad('JPEG ended inside the image data')
        const next = b[p + 1] as number
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          at = p + 2
          continue
        }
        at = p
        break
      }
      out.push(b.subarray(start, at))
    }
  }
}

// --- PNG ----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

export function stripPng(b: Uint8Array): Uint8Array {
  if (b.length < 8 + 12 || !PNG_SIG.every((x, i) => b[i] === x)) bad('PNG signature')
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Uint8Array[] = [b.subarray(0, 8)]
  let at = 8
  let first = true
  for (;;) {
    if (at + 12 > b.length) bad('PNG ended before IEND')
    const len = v.getUint32(at)
    if (len > 0x7fffffff || at + 12 + len > b.length) bad('PNG chunk overruns the file')
    const type = ascii(b, at + 4, at + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) bad('PNG chunk name')
    if (first && (type !== 'IHDR' || len !== 13)) bad('PNG must start with IHDR')
    first = false
    if (v.getUint32(at + 8 + len) !== crc32(b.subarray(at + 4, at + 8 + len))) {
      bad(`PNG ${type} checksum`)
    }
    if (!PNG_DROP.has(type)) out.push(b.subarray(at, at + 12 + len))
    at += 12 + len
    if (type === 'IEND') {
      if (len !== 0) bad('PNG IEND length')
      if (at !== b.length) bad('data after PNG IEND')
      return join(out)
    }
  }
}

// --- WebP ---------------------------------------------------------------------------------------

export function stripWebp(b: Uint8Array): Uint8Array {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') bad('WebP header')
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (v.getUint32(4, true) !== b.length - 8) bad('WebP RIFF size')
  const chunks: Uint8Array[] = []
  let at = 12
  let sawImage = false
  while (at < b.length) {
    if (at + 8 > b.length) bad('WebP chunk header')
    const type = ascii(b, at, at + 4)
    const size = v.getUint32(at + 4, true)
    const end = at + 8 + size + (size & 1)
    if (end > b.length) bad('WebP chunk overruns the file')
    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X' || type === 'ANMF') sawImage = true
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = b.slice(at, end)
      if (type === 'VP8X') {
        if (size < 10) bad('WebP VP8X size')
        chunk[8] = (chunk[8] as number) & ~0x0c // the EXIF (0x08) and XMP (0x04) flags
      }
      chunks.push(chunk)
    }
    at = end
  }
  if (!sawImage) bad('WebP has no image data')
  const body = join(chunks)
  const head = new Uint8Array(12)
  head.set(b.subarray(0, 12))
  new DataView(head.buffer).setUint32(4, body.length + 4, true)
  return join([head, body])
}

// --- GIF ----------------------------------------------------------------------------------------

export function stripGif(b: Uint8Array): Uint8Array {
  const sig = ascii(b, 0, 6)
  if (b.length < 14 || (sig !== 'GIF87a' && sig !== 'GIF89a')) bad('GIF header')
  const out: Uint8Array[] = []
  let at = 13
  const flags = b[10] as number
  if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1))
  if (at > b.length) bad('GIF colour table')
  out.push(b.subarray(0, at))

  /** The end of a run of data sub-blocks that starts at `from` (after the terminator). */
  const skipBlocks = (from: number): number => {
    let p = from
    for (;;) {
      if (p >= b.length) bad('GIF ended inside a block')
      const n = b[p] as number
      p += 1 + n
      if (n === 0) return p
      if (p > b.length) bad('GIF block overruns the file')
    }
  }

  for (;;) {
    if (at >= b.length) bad('GIF has no trailer')
    const intro = b[at] as number
    if (intro === 0x3b) {
      if (at + 1 !== b.length) bad('data after GIF trailer')
      out.push(b.subarray(at, at + 1))
      return join(out)
    }
    if (intro === 0x2c) {
      if (at + 10 > b.length) bad('GIF image descriptor')
      let p = at + 10
      const f = b[at + 9] as number
      if (f & 0x80) p += 3 * (1 << ((f & 7) + 1))
      p += 1 // LZW minimum code size
      const end = skipBlocks(p)
      out.push(b.subarray(at, end))
      at = end
    } else if (intro === 0x21) {
      if (at + 3 > b.length) bad('GIF extension')
      const label = b[at + 1] as number
      let end = 0
      let keep = false
      if (label === 0xff) {
        const n = b[at + 2] as number
        if (at + 3 + n > b.length) bad('GIF application extension')
        const id = ascii(b, at + 3, at + 3 + n)
        keep = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0'
        end = skipBlocks(at + 2)
      } else if (label === 0xfe) {
        end = skipBlocks(at + 2)
      } else if (label === 0xf9 || label === 0x01) {
        keep = true
        end = skipBlocks(at + 2)
      } else bad('GIF extension kind')
      if (keep) out.push(b.subarray(at, end))
      at = end
    } else bad('GIF block')
  }
}

// --- SVG ----------------------------------------------------------------------------------------

export function stripSvg(b: Uint8Array): Uint8Array {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return bad('SVG is not UTF-8')
  }
  const bom = text.startsWith('﻿') ? '﻿' : ''
  if (bom) text = text.slice(1)
  // Repeat until nothing changes, so a removal can't assemble a new comment or element.
  for (let i = 0; i < 20; i++) {
    const next = svgPass(text)
    if (next === text) {
      if (!/<svg[\s>]/i.test(text)) bad('SVG has no root element')
      return new TextEncoder().encode(bom + text)
    }
    text = next
  }
  return bad('SVG nesting')
}

const XML_SPACE = new Set([' ', '\t', '\n', '\r'])
const NAME_END = new Set([...XML_SPACE, '/', '>', '<'])
/** Only A–Z are lowered, so every index in the result is the same as in the original. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

/**
 * One pass over the text with indexOf only, so the time is linear whatever the input (no lazy
 * regex that rescans to the end from every `<!--`). Comments and `<metadata>` (any prefix, any
 * case) are removed; one that is never closed is refused at once.
 */
function svgPass(text: string): string {
  const lower = asciiLower(text)
  const kept: string[] = []
  let from = 0 // start of the text not copied yet
  let at = 0
  const cut = (start: number, end: number) => {
    kept.push(text.slice(from, start))
    from = at = end
  }
  for (;;) {
    const lt = text.indexOf('<', at)
    if (lt === -1) break
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end === -1) bad('SVG comment is not closed')
      cut(lt, end + 3)
      continue
    }
    let n = lt + 1
    while (n < text.length && !NAME_END.has(text[n] as string)) n++
    const name = lower.slice(lt + 1, n)
    const local = name.slice(name.lastIndexOf(':') + 1)
    if (local !== 'metadata') {
      if (/^metadata\b/.test(local)) bad('SVG markup')
      at = n
      continue
    }
    const close = text.indexOf('>', n)
    if (close === -1) bad('SVG metadata is not closed')
    if (text[close - 1] === '/') {
      cut(lt, close + 1)
      continue
    }
    const endTag = `</${name}`
    let p = lower.indexOf(endTag, close + 1)
    for (;;) {
      if (p === -1) bad('SVG metadata is not closed')
      let k = p + endTag.length
      while (k < lower.length && XML_SPACE.has(lower[k] as string)) k++
      if (lower[k] === '>') {
        cut(lt, k + 1)
        break
      }
      p = lower.indexOf(endTag, p + 1)
    }
  }
  kept.push(text.slice(from))
  return kept.join('')
}

// --- Entry points -------------------------------------------------------------------------------

/** Strip by the sniffed type. Types without a stripper here are refused rather than stored raw. */
export function stripMetadata(mime: string, bytes: Uint8Array): Uint8Array {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(bytes)
    case 'image/png':
      return stripPng(bytes)
    case 'image/webp':
      return stripWebp(bytes)
    case 'image/gif':
      return stripGif(bytes)
    case 'image/svg+xml':
      return stripSvg(bytes)
    default:
      throw new StripError(`no metadata stripper for ${mime}`)
  }
}

/** Pending: ffmpeg `-map_metadata -1`. Video upload stays off until this exists. */
export function stripVideo(_bytes: Uint8Array): never {
  throw new StripError('needs-ffmpeg')
}
