// The release bundle (decisions #23, #27, #48): an uncompressed ustar archive whose first entry is
// release-manifest.json and whose second and last entry is site.tar, the M6 package archive byte
// for byte (#47). Built once by the app; production hashes the whole file, then reads the
// manifest from it. Deterministic writer, strict reader: anything unusual is refused.
import { type Bytes, concat, sha256, utf8 } from '../bytes.ts'
import { canonicalJson } from './canonical.ts'

export const MANIFEST = 'release-manifest.json'
export const SITE_TAR = 'site.tar'
const PACKAGE_HASH = /^sha256:[0-9a-f]{64}$/
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
  /** `sha256:<hex>` of site.tar, the M6 package archive (#47, #48). Required in a release bundle. */
  packageHash?: string
}

/** The manifest of a release bundle: it always names the package it carries. */
export type ReleaseManifest = Manifest & { packageHash: string }

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

export function validateManifest(
  value: unknown,
  opts: { requirePackageHash?: boolean } = {},
): Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BundleError('manifest is not an object')
  }
  const m = value as Record<string, unknown>
  const keys = ['project', 'site', 'target', 'revision', 'validUntil']
  const hasHash = Object.hasOwn(m, 'packageHash')
  if (opts.requirePackageHash && !hasHash) throw new BundleError('manifest fields: packageHash')
  if (hasHash) keys.push('packageHash')
  if (Object.keys(m).length !== keys.length || !keys.every((k) => Object.hasOwn(m, k))) {
    throw new BundleError('manifest fields')
  }
  const { project, site, target, revision, validUntil, packageHash } = m
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
  if (!hasHash) return { project, site, target, revision, validUntil }
  if (typeof packageHash !== 'string' || !PACKAGE_HASH.test(packageHash))
    throw new BundleError('packageHash')
  return { project, site, target, revision, validUntil, packageHash }
}

/** A plain deterministic archive of site files, no manifest: the M6 package (docs/m6-interfaces.md). */
export function writeArchive(files: { path: string; bytes: Uint8Array }[]): Bytes {
  const sorted = [...files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return writeEntries(sorted, [])
}

function writeEntries(
  files: { path: string; bytes: Uint8Array }[],
  first: { path: string; bytes: Uint8Array }[],
  allowDuplicates = false,
): Bytes {
  const seen = new Set<string>(first.map((f) => f.path))
  const parts: Uint8Array[] = []
  for (const f of first) parts.push(header(f.path, f.bytes.length), f.bytes, pad(f.bytes.length))
  for (const f of files) {
    if (!isSafePath(f.path)) throw new BundleError(`unsafe path: ${f.path}`)
    if (seen.has(f.path.toLowerCase()) && !allowDuplicates)
      throw new BundleError(`duplicate path: ${f.path}`)
    seen.add(f.path.toLowerCase())
    parts.push(header(f.path, f.bytes.length), f.bytes, pad(f.bytes.length))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  return concat(...parts)
}

export function writeBundle(
  manifest: Manifest,
  files: { path: string; bytes: Uint8Array }[],
  test: { skipManifestCheck?: boolean; allowDuplicates?: boolean } = {},
): Bytes {
  if (!test.skipManifestCheck) validateManifest(manifest)
  const first = [{ path: MANIFEST, bytes: utf8.encode(JSON.stringify(manifest)) }]
  return writeEntries(files, first, test.allowDuplicates)
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

/** Size limits for reading a site archive; every one is checked before anything is unpacked. */
export type ArchiveLimits = { maxEntries: number; maxFileBytes: number; maxTotalBytes: number }

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 10_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
}

// Names Windows treats as devices, with or without an extension: unpacking one makes no file.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i

function walk(t: Uint8Array, manifestFirst: boolean, limits?: ArchiveLimits): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()
  let total = 0
  let at = 0
  for (;;) {
    const h = readHeader(t, at)
    if (!h) break
    if (manifestFirst && entries.length === 0 && h.path !== MANIFEST) {
      throw new BundleError(`first entry must be ${MANIFEST}`)
    }
    if (!isSafePath(h.path)) throw new BundleError(`unsafe path: ${h.path}`)
    // Case-insensitively: on Windows and macOS file systems Index.html and index.html collide.
    const folded = h.path.toLowerCase()
    if (seen.has(folded)) throw new BundleError(`duplicate path: ${h.path}`)
    seen.add(folded)
    if (limits) {
      if (entries.length >= limits.maxEntries) throw new BundleError('too many entries')
      if (h.size > limits.maxFileBytes) throw new BundleError(`file too large: ${h.path}`)
      total += h.size
      if (total > limits.maxTotalBytes) throw new BundleError('archive too large')
    }
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

/** Every entry, in order. Regular files with safe, unique paths only; ends with the zero blocks. */
export function listEntries(t: Uint8Array): Entry[] {
  return walk(t, true)
}

/**
 * A site archive (the M6 package, site.tar) read for unpacking: everything listEntries refuses,
 * plus the size limits, names that don't unpack the same everywhere (Windows devices, trailing
 * dots), and a path that is both a file and another file's folder.
 */
export function listArchive(t: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): Entry[] {
  const entries = walk(t, false, limits)
  const files = new Set(entries.map((e) => e.path.toLowerCase()))
  for (const e of entries) {
    const segments = e.path.split('/')
    if (segments.some((seg) => WINDOWS_DEVICE.test(seg) || seg.endsWith('.'))) {
      throw new BundleError(`unportable path: ${e.path}`)
    }
    for (let i = 1; i < segments.length; i++) {
      if (files.has(segments.slice(0, i).join('/').toLowerCase())) {
        throw new BundleError(`path is both a file and a folder: ${e.path}`)
      }
    }
  }
  return entries
}

/** The manifest, from the first entry only, validated. Reading it never unpacks anything. */
export function readManifest(t: Uint8Array, opts: { requirePackageHash?: boolean } = {}): Manifest {
  const h = readHeader(t, 0)
  if (!h || h.path !== MANIFEST) throw new BundleError(`first entry must be ${MANIFEST}`)
  if (h.size > MAX_MANIFEST_BYTES || BLOCK + h.size > t.length)
    throw new BundleError('manifest size')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(t.subarray(BLOCK, BLOCK + h.size))
  return validateManifest(JSON.parse(text), opts)
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * The release bundle the app builds (#48): the manifest with the package hash, then the M6
 * package archive unchanged as site.tar. Nothing else.
 */
export async function writeReleaseBundle(manifest: Manifest, siteTar: Bytes): Promise<Bytes> {
  const packageHash = `sha256:${toHex(await sha256(siteTar))}`
  if (manifest.packageHash !== undefined && manifest.packageHash !== packageHash) {
    throw new BundleError('manifest packageHash does not match site.tar')
  }
  const full = validateManifest({ ...manifest, packageHash }, { requirePackageHash: true })
  listArchive(siteTar)
  return writeEntries(
    [],
    [
      { path: MANIFEST, bytes: utf8.encode(canonicalJson(full)) },
      { path: SITE_TAR, bytes: siteTar },
    ],
  )
}

export type VerifiedBundle = { manifest: ReleaseManifest; site: Bytes; files: Entry[] }

/**
 * Everything production checks in the bundle itself before unpacking (#48): exactly the manifest
 * then site.tar; a valid manifest naming the package hash; site.tar hashing to it; a strict
 * site.tar within the limits. Offsets in `files` are into `site`. Throws BundleError.
 */
export async function verifyBundle(
  bundle: Uint8Array,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Promise<VerifiedBundle> {
  const entries = listEntries(bundle)
  const entry = entries[1]
  if (entries.length !== 2 || entry?.path !== SITE_TAR) {
    throw new BundleError(`a release bundle is ${MANIFEST} then ${SITE_TAR}, nothing else`)
  }
  const manifest = readManifest(bundle, { requirePackageHash: true }) as ReleaseManifest
  const site = new Uint8Array(bundle.subarray(entry.offset, entry.offset + entry.size))
  if (`sha256:${toHex(await sha256(site))}` !== manifest.packageHash) {
    throw new BundleError('site.tar does not match the manifest packageHash')
  }
  return { manifest, site, files: listArchive(site, limits) }
}
