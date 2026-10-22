// M8.3: metadata stripping, pure TypeScript (decision #22). Fixtures are built here with GPS and
// author data; after stripping those bytes are gone and the file still has a valid structure.
import { describe, expect, test } from 'bun:test'
import { MediaError, prepareUpload } from '../server/media/media.ts'
import {
  crc32,
  StripError,
  stripGif,
  stripJpeg,
  stripMetadata,
  stripPng,
  stripSvg,
  stripVideo,
  stripWebp,
} from '../server/media/strip.ts'

const enc = new TextEncoder()
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0))
  let at = 0
  for (const x of p) {
    out.set(x, at)
    at += x.length
  }
  return out
}
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(s)

// --- builders ---

const seg = (marker: number, body: Uint8Array) =>
  cat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body)

const GPS = 'GPS-55.6761N-12.5683E'
const exif = cat(enc.encode('Exif\0\0'), enc.encode(`II*\0 ${GPS} Camera`))
const xmp = enc.encode(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS} author=Jane</x:xmpmeta>`)
const ICC = cat(enc.encode('ICC_PROFILE\0'), new Uint8Array([1, 1, 9, 9, 9]))
const IMAGE = new Uint8Array([1, 2, 3, 0xff, 0x00, 4, 5])

function jpeg(extra: Uint8Array[]) {
  const sof = seg(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0]))
  const sos = seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0]))
  return cat(
    new Uint8Array([0xff, 0xd8]),
    seg(0xe0, enc.encode('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...extra,
    sof,
    sos,
    IMAGE,
    new Uint8Array([0xff, 0xd9]),
  )
}

function pngChunk(type: string, data: Uint8Array) {
  const t = enc.encode(type)
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(t, 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
const IHDR = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
function png(extra: Uint8Array[]) {
  return cat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', IHDR),
    ...extra,
    pngChunk('IDAT', new Uint8Array([8, 29, 1, 2, 3])),
    pngChunk('IEND', new Uint8Array()),
  )
}

function riff(chunks: Uint8Array[]) {
  const body = cat(enc.encode('WEBP'), ...chunks)
  const out = cat(enc.encode('RIFF'), new Uint8Array(4), body)
  new DataView(out.buffer).setUint32(4, body.length, true)
  return out
}
function wchunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(8 + data.length + (data.length & 1))
  out.set(enc.encode(type))
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  return out
}
const VP8X = (flags: number) => wchunk('VP8X', new Uint8Array([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
const VP8L = wchunk('VP8L', new Uint8Array([0x2f, 0, 0, 0, 0, 1, 2]))

const gifHead = () =>
  cat(enc.encode('GIF89a'), new Uint8Array([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]))
const gifFrame = new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0])
const sub = (...blocks: Uint8Array[]) =>
  cat(...blocks.flatMap((b) => [new Uint8Array([b.length]), b]), new Uint8Array([0]))
const app = (id: string, data: Uint8Array) =>
  cat(new Uint8Array([0x21, 0xff, id.length]), enc.encode(id), sub(data))

describe('JPEG', () => {
  const src = jpeg([
    seg(0xe1, exif),
    seg(0xe1, xmp),
    seg(0xed, enc.encode('Photoshop 3.0\0IPTC')),
    seg(0xfe, enc.encode('comment Jane')),
    seg(0xe2, ICC),
  ])
  const out = stripJpeg(src)

  test('GPS, XMP, IPTC and comments are gone', () => {
    expect(has(src, GPS)).toBe(true)
    for (const s of [GPS, 'Exif', 'xmpmeta', 'Photoshop', 'Jane']) expect(has(out, s)).toBe(false)
  })
  test('image data, JFIF and ICC stay; SOI and EOI are in place', () => {
    expect([out[0], out[1]]).toEqual([0xff, 0xd8])
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd9])
    expect(has(out, 'JFIF')).toBe(true)
    expect(has(out, 'ICC_PROFILE')).toBe(true)
    expect(Buffer.from(out).includes(Buffer.from(IMAGE))).toBe(true)
    expect(out.length).toBeLessThan(src.length)
  })
  test('stripping twice changes nothing', () => {
    expect(Buffer.from(stripJpeg(out)).equals(Buffer.from(out))).toBe(true)
  })
  test.each([
    ['no SOI', new Uint8Array([1, 2, 3, 4])],
    ['truncated', src.subarray(0, 30)],
    ['no EOI', src.subarray(0, src.length - 2)],
    [
      'segment overruns',
      cat(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), new Uint8Array([0xff, 0xd9])),
    ],
  ])('malformed: %s', (_n, bytes) => {
    expect(() => stripJpeg(bytes)).toThrow(StripError)
  })
})

// Walks a JPEG the way a decoder does: segments, then entropy-coded data (FF00 and RSTn are
// data) up to the next marker. Returns the markers in order; fails unless EOI ends the file.
function jpegMarkers(b: Uint8Array): number[] {
  expect([b[0], b[1]]).toEqual([0xff, 0xd8])
  const seen: number[] = [0xd8]
  let at = 2
  for (;;) {
    expect(b[at]).toBe(0xff)
    const m = b[at + 1] as number
    seen.push(m)
    if (m === 0xd9) {
      expect(at + 2).toBe(b.length)
      return seen
    }
    const len = ((b[at + 2] as number) << 8) | (b[at + 3] as number)
    at += 2 + len
    if (m === 0xda) {
      for (;;) {
        const p = b.indexOf(0xff, at)
        expect(p).toBeGreaterThanOrEqual(0)
        const n = b[p + 1] as number
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) at = p + 2
        else {
          at = p
          break
        }
      }
    }
  }
}

describe('JPEG: data after the first scan (review finding 2)', () => {
  const MPF = cat(enc.encode('MPF\0'), enc.encode('MM\0*\0\0\0\x08 secondary at 1234'))
  const secondary = jpeg([seg(0xe1, exif), seg(0xfe, enc.encode('preview by Jane'))])

  test('an appended Exif+GPS JPEG after EOI is cut off, and the MPF index goes with it', () => {
    const src = cat(jpeg([seg(0xe2, ICC), seg(0xe2, MPF)]), secondary)
    expect(has(src, GPS)).toBe(true)
    const out = stripJpeg(src)
    for (const s of [GPS, 'Exif', 'Jane', 'MPF']) expect(has(out, s)).toBe(false)
    expect(has(out, 'ICC_PROFILE')).toBe(true)
    expect(jpegMarkers(out)).toEqual([0xd8, 0xe0, 0xe2, 0xc0, 0xda, 0xd9])
    expect(Buffer.from(out).includes(Buffer.from(IMAGE))).toBe(true)
  })

  test('trailing bytes that are not a JPEG are dropped too', () => {
    const out = stripJpeg(cat(jpeg([]), enc.encode(`junk ${GPS}`)))
    expect(has(out, GPS)).toBe(false)
    jpegMarkers(out)
  })

  test('APP1 and COM between progressive scans go; FF00, RSTn and both scans stay', () => {
    const sof2 = seg(0xc2, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0]))
    const sos = seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0]))
    const dht = seg(0xc4, new Uint8Array(17))
    const scan1 = new Uint8Array([1, 0xff, 0x00, 2, 0xff, 0xd0, 3])
    const scan2 = new Uint8Array([4, 0xff, 0xd1, 5, 0xff, 0x00])
    const src = cat(
      new Uint8Array([0xff, 0xd8]),
      seg(0xe0, enc.encode('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
      sof2,
      sos,
      scan1,
      seg(0xe1, exif),
      seg(0xfe, enc.encode('comment Jane')),
      new Uint8Array([0xff]), // a fill byte before the next marker
      dht,
      sos,
      scan2,
      new Uint8Array([0xff, 0xd9]),
    )
    const out = stripJpeg(src)
    for (const s of [GPS, 'Exif', 'Jane']) expect(has(out, s)).toBe(false)
    expect(jpegMarkers(out)).toEqual([0xd8, 0xe0, 0xc2, 0xda, 0xc4, 0xda, 0xd9])
    expect(Buffer.from(out).includes(Buffer.from(scan1))).toBe(true)
    expect(Buffer.from(out).includes(Buffer.from(scan2))).toBe(true)
    expect(Buffer.from(stripJpeg(out)).equals(Buffer.from(out))).toBe(true)
  })

  test('a scan that never reaches EOI is refused', () => {
    const src = jpeg([])
    const cut = cat(src.subarray(0, src.length - 2), new Uint8Array([9, 9]))
    expect(() => stripJpeg(cut)).toThrow(StripError)
  })
})

describe('PNG', () => {
  const src = png([
    pngChunk('tEXt', enc.encode('Author\0Jane Doe')),
    pngChunk('zTXt', enc.encode('Comment\0\0xx')),
    pngChunk('iTXt', enc.encode('XML:com.adobe.xmp\0\0\0\0\0<x>Jane</x>')),
    pngChunk('eXIf', enc.encode(`II*\0${GPS}`)),
    pngChunk('tIME', new Uint8Array([7, 232, 1, 2, 3, 4, 5])),
    pngChunk('gAMA', new Uint8Array([0, 1, 0, 0])),
  ])
  const out = stripPng(src)

  test('text, eXIf and tIME are gone; the rest stays with valid CRCs', () => {
    for (const s of ['Author', 'Jane', GPS, 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']) {
      expect(has(out, s)).toBe(false)
    }
    // Walk the chunks: IHDR first, IEND last, every CRC right.
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength)
    const types: string[] = []
    let at = 8
    while (at < out.length) {
      const len = v.getUint32(at)
      expect(v.getUint32(at + 8 + len)).toBe(crc32(out.subarray(at + 4, at + 8 + len)))
      types.push(String.fromCharCode(...out.subarray(at + 4, at + 8)))
      at += 12 + len
    }
    expect(at).toBe(out.length)
    expect(types).toEqual(['IHDR', 'gAMA', 'IDAT', 'IEND'])
  })
  test.each([
    [
      'bad CRC',
      (() => {
        const b = src.slice()
        b[20] = (b[20] as number) ^ 1
        return b
      })(),
    ],
    ['no IEND', src.subarray(0, src.length - 12)],
    ['trailing data', cat(src, new Uint8Array([1]))],
    ['wrong signature', cat(new Uint8Array([0x88]), src.subarray(1))],
  ])('malformed: %s', (_n, bytes) => {
    expect(() => stripPng(bytes)).toThrow(StripError)
  })
})

describe('WebP', () => {
  const src = riff([
    VP8X(0x08 | 0x04 | 0x10),
    VP8L,
    wchunk('EXIF', enc.encode(`II*\0${GPS}x`)),
    wchunk('XMP ', xmp),
  ])
  const out = stripWebp(src)

  test('EXIF and XMP chunks are gone; RIFF size and VP8X flags are fixed', () => {
    for (const s of [GPS, 'EXIF', 'XMP ', 'xmpmeta']) expect(has(out, s)).toBe(false)
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength)
    expect(v.getUint32(4, true)).toBe(out.length - 8)
    expect(Buffer.from(out.subarray(0, 4)).toString()).toBe('RIFF')
    expect(Buffer.from(out.subarray(8, 12)).toString()).toBe('WEBP')
    expect(Buffer.from(out.subarray(12, 16)).toString()).toBe('VP8X')
    expect((out[20] as number) & 0x0c).toBe(0)
    expect((out[20] as number) & 0x10).toBe(0x10) // the alpha flag survives
    expect(has(out, 'VP8L')).toBe(true)
  })
  test('a simple lossless file without metadata is unchanged', () => {
    const plain = riff([VP8L])
    expect(Buffer.from(stripWebp(plain)).equals(Buffer.from(plain))).toBe(true)
  })
  test.each([
    [
      'wrong RIFF size',
      (() => {
        const b = src.slice()
        b[4] = (b[4] as number) + 2
        return b
      })(),
    ],
    ['truncated', src.subarray(0, src.length - 3)],
    ['no image', riff([wchunk('EXIF', enc.encode('x'))])],
  ])('malformed: %s', (_n, bytes) => {
    expect(() => stripWebp(bytes)).toThrow(StripError)
  })
})

describe('GIF', () => {
  const comment = cat(new Uint8Array([0x21, 0xfe]), sub(enc.encode('by Jane')))
  const xmpExt = app('XMP DataXMP', enc.encode('<x>Jane</x>'))
  const loop = app('NETSCAPE2.0', new Uint8Array([1, 0, 0]))
  const gce = cat(new Uint8Array([0x21, 0xf9]), sub(new Uint8Array([0, 10, 0, 0])))
  const src = cat(gifHead(), loop, comment, xmpExt, gce, gifFrame, new Uint8Array([0x3b]))
  const out = stripGif(src)

  test('comments and application extensions go; looping, timing and frames stay', () => {
    expect(has(out, 'Jane')).toBe(false)
    expect(has(out, 'XMP')).toBe(false)
    expect(has(out, 'NETSCAPE2.0')).toBe(true)
    expect(Buffer.from(out).includes(Buffer.from(gce))).toBe(true)
    expect(Buffer.from(out).includes(Buffer.from(gifFrame))).toBe(true)
    expect(out[out.length - 1]).toBe(0x3b)
  })
  test.each([
    ['no trailer', src.subarray(0, src.length - 1)],
    ['data after trailer', cat(src, new Uint8Array([0]))],
    ['bad header', enc.encode('GIF90a1234567')],
  ])('malformed: %s', (_n, bytes) => {
    expect(() => stripGif(bytes)).toThrow(StripError)
  })
})

describe('SVG', () => {
  const svg = enc.encode(
    '<?xml version="1.0"?><!-- Made by Jane --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><metadata><rdf:RDF>Jane GPS</rdf:RDF></metadata><rect width="1" height="1"/><!-- more --></svg>',
  )
  test('metadata and comments are removed, the drawing stays', () => {
    const out = new TextDecoder().decode(stripSvg(svg))
    expect(out).toBe(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    )
  })
  test('removals cannot assemble a new comment', () => {
    const tricky = enc.encode('<svg><!<!---->-- Jane --><rect/></svg>')
    expect(has(stripSvg(tricky), 'Jane')).toBe(false)
  })
  test('an unterminated comment or invalid UTF-8 is refused', () => {
    expect(() => stripSvg(enc.encode('<svg><!-- oops<rect/></svg>'))).toThrow(StripError)
    expect(() => stripSvg(new Uint8Array([0x3c, 0xff, 0xfe]))).toThrow(StripError)
  })
})

describe('SVG: linear time on hostile input (review finding 1)', () => {
  test.each([
    ['20 MB of unterminated comments', `<svg>${'<!--'.repeat(5_000_000)}`],
    ['unterminated metadata elements', `<svg>${'<metadata>'.repeat(2_000_000)}`],
    ['unterminated prefixed metadata', `<svg>${'<x:metadata a="1">'.repeat(1_000_000)}`],
    ['metadata start tags that never end', `<svg>${'<metadata '.repeat(2_000_000)}`],
  ])('%s: refused within 500 ms', (_n, text) => {
    const bytes = enc.encode(text)
    const t0 = performance.now()
    let err: unknown = null
    try {
      stripSvg(bytes)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StripError)
    expect(performance.now() - t0).toBeLessThan(500)
  })
  test('an unclosed metadata element is refused; self-closing and prefixed ones are removed', () => {
    expect(() => stripSvg(enc.encode('<svg><metadata>Jane<rect/></svg>'))).toThrow(StripError)
    const src = '<svg><METADATA/><sodipodi:metadata id="m">Jane</sodipodi:metadata ><rect/></svg>'
    expect(new TextDecoder().decode(stripSvg(enc.encode(src)))).toBe('<svg><rect/></svg>')
  })
})

describe('the upload path', () => {
  test('prepareUpload strips and returns the new bytes', () => {
    const src = jpeg([seg(0xe1, exif)])
    const r = prepareUpload(src)
    expect(r.mime).toBe('image/jpeg')
    expect(has(r.bytes, GPS)).toBe(false)
  })
  test('a malformed file is refused as bad-file', () => {
    try {
      prepareUpload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]))
      throw new Error('should have refused')
    } catch (err) {
      expect(err).toBeInstanceOf(MediaError)
      expect((err as MediaError).code).toBe('bad-file')
    }
  })
  test('types without a stripper are refused and video stays off', () => {
    expect(() => stripMetadata('video/mp4', new Uint8Array([1]))).toThrow(StripError)
    expect(() => stripVideo(new Uint8Array([1]))).toThrow('needs-ffmpeg')
  })
})
