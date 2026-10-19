// The release bundle (decisions #23, #27): an uncompressed ustar archive whose first entry is
// release-manifest.json. Built once by the app; production hashes the whole file, then reads the
// manifest from it. Deterministic writer, strict reader: anything unusual is refused.
import { type Bytes, concat, utf8 } from '../bytes.ts'

export const MANIFEST = 'release-manifest.json'
const BLOCK = 512
const MAX_MANIFEST_BYTES = 16 * 1024
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/
export const SITE =
  /^(?=[^/]{1,253}(\/|$))([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(\/[a-z0-9][a-z0-9._-]*)*$/

export type Manifest = {
  project: string
  site: string
  target: string
  revision: string
  validUntil: string
}

export type Entry = { path: string; size: number; offset: number }

export class BundleError extends Error {}

/** Relative, forward slashes, no empty or dot segments, plain characters, fits a ustar name. */
export function isSafePath(path: string): boolean {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path)) return false
  if (path.split('/').some((s) => s === '.' || s === '..')) return false
  return utf8.encode(path).length <= 100
}

function field(text: string, size: number): Bytes {
  const bytes = utf8.encode(text)
  if (bytes.length > size) throw new BundleError(`tar field too long: ${text}`)
  const out = new Uint8Array(size)
  out.set(bytes)
  return out
}

const octal = (n: number, size: number) => field(`${n.toString(8).padStart(size - 1, '0')}\0`, size)

function header(path: string, size: number): Bytes {
  const h = new Uint8Array(BLOCK)
  h.set(field(path, 100), 0)
  h.set(octal(0o644, 8), 100)
  h.set(octal(0, 8), 108) // uid
  h.set(octal(0, 8), 116) // gid
  h.set(octal(size, 12), 124)
  h.set(octal(0, 12), 136) // mtime: fixed, so the same files give the same bytes
  h.fill(0x20, 148, 156) // checksum placeholder
  h[156] = '0'.charCodeAt(0) // regular file
  h.set(field('ustar\0', 6), 257)
  h.set(field('00', 2), 263)
  let sum = 0
  for (const b of h) sum += b
  h.set(field(`${sum.toString(8).padStart(6, '0')}\0 `, 8), 148)
  return h
}

const pad = (n: number) => new Uint8Array((BLOCK - (n % BLOCK)) % BLOCK)

export function validateManifest(value: unknown): Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BundleError('manifest is not an object')
  }
  const m = value as Record<string, unknown>
  const keys = ['project', 'site', 'target', 'revision', 'validUntil']
  if (Object.keys(m).length !== keys.length || !keys.every((k) => Object.hasOwn(m, k))) {
    throw new BundleError('manifest fields')
  }
  const { project, site, target, revision, validUntil } = m
  if (typeof project !== 'string' || !/^[a-z0-9]+$/.test(project)) throw new BundleError('project')
  // A live address: a hostname, optionally with a path (plan §13.11: example.com/campaigns/go).
  if (typeof site !== 'string' || !SITE.test(site)) throw new BundleError('site')
  if (typeof target !== 'string' || target.length === 0) throw new BundleError('target')
  if (typeof revision !== 'string' || !/^[a-z0-9]+-r[0-9]+$/.test(revision))
    throw new BundleError('revision')
  if (
    typeof validUntil !== 'string' ||
    !ISO_UTC.test(validUntil) ||
    !Number.isFinite(Date.parse(validUntil))
  ) {
    throw new BundleError('validUntil')
  }
  return { project, site, target, revision, validUntil }
}

export function writeBundle(
  manifest: Manifest,
  files: { path: string; bytes: Uint8Array }[],
  test: { skipManifestCheck?: boolean; allowDuplicates?: boolean } = {},
): Bytes {
  if (!test.skipManifestCheck) validateManifest(manifest)
  const seen = new Set<string>([MANIFEST])
  const parts: Uint8Array[] = []
  const add = (path: string, bytes: Uint8Array) => {
    parts.push(header(path, bytes.length), bytes, pad(bytes.length))
  }
  add(MANIFEST, utf8.encode(JSON.stringify(manifest)))
  for (const f of files) {
    if (!isSafePath(f.path)) throw new BundleError(`unsafe path: ${f.path}`)
    if (seen.has(f.path.toLowerCase()) && !test.allowDuplicates)
      throw new BundleError(`duplicate path: ${f.path}`)
    seen.add(f.path.toLowerCase())
    add(f.path, f.bytes)
  }
  parts.push(new Uint8Array(BLOCK * 2))
  return concat(...parts)
}

function parseOctal(bytes: Uint8Array): number {
  const text = String.fromCharCode(...bytes).replace(/[\0 ]+$/, '')
  if (!/^[0-7]{1,11}$/.test(text)) throw new BundleError('tar number')
  return Number.parseInt(text, 8)
}

function readHeader(
  t: Uint8Array,
  at: number,
): { path: string; size: number; type: number } | null {
  if (at + BLOCK > t.length) throw new BundleError('truncated tar')
  const h = t.subarray(at, at + BLOCK)
  if (h.every((b) => b === 0)) return null // end of archive
  if (String.fromCharCode(...h.subarray(257, 263)) !== 'ustar\0')
    throw new BundleError('not a ustar archive')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0)
  if (parseOctal(h.subarray(148, 156)) !== sum) throw new BundleError('tar checksum')
  const nameEnd = h.indexOf(0)
  const path = String.fromCharCode(...h.subarray(0, nameEnd >= 0 && nameEnd < 100 ? nameEnd : 100))
  const size = parseOctal(h.subarray(124, 136))
  const type = h[156] ?? 0
  if (type !== '0'.charCodeAt(0)) throw new BundleError('tar entry is not a regular file')
  // The app's writer is deterministic, so a header must be exactly what it would write for this
  // path and size: that rules out modes, owners, times, link names, prefixes and junk after
  // the name in one comparison.
  let expected: Bytes
  try {
    expected = header(path, size)
  } catch {
    throw new BundleError('tar header name')
  }
  if (!h.every((b, i) => b === expected[i])) throw new BundleError('tar header is not canonical')
  return { path, size, type }
}

/** Every entry, in order. Regular files with safe, unique paths only; ends with the zero blocks. */
export function listEntries(t: Uint8Array): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()
  let at = 0
  for (;;) {
    const h = readHeader(t, at)
    if (!h) break
    if (entries.length === 0 && h.path !== MANIFEST) {
      throw new BundleError(`first entry must be ${MANIFEST}`)
    }
    if (!isSafePath(h.path)) throw new BundleError(`unsafe path: ${h.path}`)
    // Case-insensitively: on Windows and macOS file systems Index.html and index.html collide.
    const folded = h.path.toLowerCase()
    if (seen.has(folded)) throw new BundleError(`duplicate path: ${h.path}`)
    seen.add(folded)
    const offset = at + BLOCK
    if (offset + h.size > t.length) throw new BundleError('truncated tar entry')
    entries.push({ path: h.path, size: h.size, offset })
    at = offset + h.size + ((BLOCK - (h.size % BLOCK)) % BLOCK)
  }
  if (entries.length === 0) throw new BundleError('empty archive')
  // Exactly the two zero blocks the writer emits, and nothing after them: no entries hidden
  // behind a single zero block for a laxer extractor to find.
  if (t.length !== at + BLOCK * 2 || !t.subarray(at).every((b) => b === 0)) {
    throw new BundleError('tar must end with exactly two zero blocks')
  }
  return entries
}

/** The manifest, from the first entry only, validated. Reading it never unpacks anything. */
export function readManifest(t: Uint8Array): Manifest {
  const h = readHeader(t, 0)
  if (!h || h.path !== MANIFEST) throw new BundleError(`first entry must be ${MANIFEST}`)
  if (h.size > MAX_MANIFEST_BYTES || BLOCK + h.size > t.length)
    throw new BundleError('manifest size')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(t.subarray(BLOCK, BLOCK + h.size))
  return validateManifest(JSON.parse(text))
}
