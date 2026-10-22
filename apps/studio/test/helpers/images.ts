// Small but structurally valid images for tests (the M8 stripper refuses truncated files).
// `tag` makes the bytes differ, so two uploads get two blobs.
import { crc32 } from '../../server/media/strip.ts'

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
const seg = (marker: number, body: Uint8Array) =>
  cat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body)

export function validJpeg(tag = 0): Uint8Array {
  return cat(
    new Uint8Array([0xff, 0xd8]),
    seg(0xe0, enc.encode('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    seg(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
    new Uint8Array([1, 2, 3, tag & 0xfe, 4, 5]),
    new Uint8Array([0xff, 0xd9]),
  )
}

function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(enc.encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export function validPng(tag = 0): Uint8Array {
  return cat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('IDAT', new Uint8Array([8, 29, 1, 2, tag & 0xff])),
    pngChunk('IEND', new Uint8Array()),
  )
}

export function validWebp(tag = 0): Uint8Array {
  const data = new Uint8Array([0x2f, 0, 0, 0, 0, 1, tag & 0xff])
  const chunk = new Uint8Array(8 + data.length + (data.length & 1))
  chunk.set(enc.encode('VP8L'))
  new DataView(chunk.buffer).setUint32(4, data.length, true)
  chunk.set(data, 8)
  const body = cat(enc.encode('WEBP'), chunk)
  const out = cat(enc.encode('RIFF'), new Uint8Array(4), body)
  new DataView(out.buffer).setUint32(4, body.length, true)
  return out
}

export function validGif(tag = 0): Uint8Array {
  return cat(
    enc.encode('GIF89a'),
    new Uint8Array([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, tag & 0xff]),
    new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]),
    new Uint8Array([0x3b]),
  )
}
