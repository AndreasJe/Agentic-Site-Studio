// A small ustar reader for the package archive (docs/m6-interfaces.md). It only accepts what the
// shared writer produces: regular files with safe relative paths. Everything else is refused.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BLOCK = 512
const MAX_BYTES = 1024 * 1024 * 1024

export class TarError extends Error {}

const text = (buf, from, to) => {
  const slice = buf.subarray(from, to)
  const end = slice.indexOf(0)
  return Buffer.from(end < 0 ? slice : slice.subarray(0, end)).toString('utf8')
}

// Octal field, NUL or space terminated.
const octal = (buf, from, to) => {
  const s = text(buf, from, to).trim()
  if (!/^[0-7]*$/.test(s)) throw new TarError('bad number in header')
  return s === '' ? 0 : Number.parseInt(s, 8)
}

export function isSafePath(path) {
  if (!path || path.length > 1024) return false
  if (path.includes('\0') || path.includes('\\') || path.includes(':')) return false
  if (path.startsWith('/')) return false
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/** Parse an archive into [{ path, data }]. Throws TarError on anything unexpected. */
export function readTar(buf) {
  if (buf.length > MAX_BYTES) throw new TarError('archive too large')
  const entries = []
  const seen = new Set()
  let pos = 0
  while (pos + BLOCK <= buf.length) {
    const head = buf.subarray(pos, pos + BLOCK)
    if (head.every((b) => b === 0)) return entries // end of archive
    if (text(head, 257, 262) !== 'ustar') throw new TarError('not a ustar header')
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (head[i] ?? 0)
    if (sum !== octal(head, 148, 156)) throw new TarError('header checksum mismatch')
    const type = String.fromCharCode(head[156] ?? 0)
    const prefix = text(head, 345, 500)
    const path = prefix ? `${prefix}/${text(head, 0, 100)}` : text(head, 0, 100)
    if (type !== '0' && type !== '\0') throw new TarError(`not a regular file: ${path || '?'}`)
    if (!isSafePath(path)) throw new TarError(`unsafe path: ${JSON.stringify(path)}`)
    if (seen.has(path)) throw new TarError(`duplicate path: ${path}`)
    seen.add(path)
    const size = octal(head, 124, 136)
    const start = pos + BLOCK
    if (start + size > buf.length) throw new TarError(`truncated entry: ${path}`)
    entries.push({ path, data: buf.subarray(start, start + size) })
    pos = start + Math.ceil(size / BLOCK) * BLOCK
  }
  throw new TarError('missing end of archive')
}

/** Write the entries below dir. Paths were already checked by readTar. */
export function unpack(entries, dir) {
  for (const e of entries) {
    const file = join(dir, ...e.path.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, e.data, { flag: 'wx' })
  }
}
