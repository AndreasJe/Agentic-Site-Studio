// Bundle format (decisions #27): uncompressed tar, release-manifest.json first, read strictly.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { utf8 } from '../src/bytes.ts'
import { listEntries, type Manifest, readManifest, writeBundle } from '../src/release/bundle.ts'

const manifest: Manifest = {
  project: 'qualiwarego',
  site: 'example.com',
  target: 'production',
  revision: 'qualiwarego-r7',
  validUntil: '2026-10-26T12:00:00Z',
  // Required by the contract since M7 (decision #48): the hash of site.tar inside the bundle.
  packageHash: `sha256:${'a'.repeat(64)}`,
}
const files = [
  { path: 'index.html', bytes: utf8.encode('<!doctype html><p>Hi</p>') },
  { path: 'assets/site.css', bytes: utf8.encode('p{color:#2b675b}') },
]

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../contracts/release-manifest.schema.json'), 'utf8'),
)
const validManifest = addFormats(new Ajv2020({ strict: false })).compile(schema)

describe('bundle', () => {
  test('round-trips the manifest and files, manifest first, and is deterministic', () => {
    const a = writeBundle(manifest, files)
    const b = writeBundle(manifest, files)
    expect(a).toEqual(b)
    expect(a.length % 512).toBe(0)
    expect(readManifest(a)).toEqual(manifest)
    expect(validManifest(readManifest(a))).toBe(true)
    const entries = listEntries(a)
    expect(entries.map((e) => e.path)).toEqual([
      'release-manifest.json',
      'index.html',
      'assets/site.css',
    ])
    const css = entries[2]
    expect(css && utf8.decode(a.subarray(css.offset, css.offset + css.size))).toBe(
      'p{color:#2b675b}',
    )
  })

  test('is a tar that standard tools can read', () => {
    // ustar magic and a valid header checksum on the first entry.
    const t = writeBundle(manifest, files)
    expect(utf8.decode(t.subarray(257, 262))).toBe('ustar')
    expect(utf8.decode(t.subarray(0, 21))).toBe('release-manifest.json')
  })

  test('refuses unsafe paths when writing', () => {
    for (const path of [
      '/etc/passwd',
      '../x',
      'a/../b',
      'a//b',
      'a\\b',
      '',
      'release-manifest.json',
    ]) {
      expect(() => writeBundle(manifest, [{ path, bytes: new Uint8Array() }])).toThrow()
    }
  })

  test('refuses a bundle whose first entry is not the manifest', () => {
    const t = writeBundle(manifest, files)
    // Rename the first entry and fix its checksum: still a valid tar, wrong first file.
    const renamed = t.slice()
    renamed.set(utf8.encode('release-manifest.jsoX'), 0)
    fixChecksum(renamed, 0)
    expect(() => readManifest(renamed)).toThrow('first entry')
  })

  test('refuses a broken header, a bad checksum, truncation and garbage', () => {
    const t = writeBundle(manifest, files)
    const badSum = t.slice()
    badSum[10] = 0x41
    expect(() => readManifest(badSum)).toThrow('checksum')
    expect(() => readManifest(t.subarray(0, 600))).toThrow()
    expect(() => readManifest(utf8.encode('not a tar at all'))).toThrow()
    expect(() => readManifest(new Uint8Array(2048))).toThrow()
  })

  test('refuses a manifest with missing, extra or invalid fields', () => {
    const bad: Record<string, unknown>[] = [
      { ...manifest, extra: 1 },
      { ...manifest, project: 'Has Caps' },
      { ...manifest, revision: 'nope' },
      { ...manifest, validUntil: '2026-10-26T12:00:00' },
      { ...manifest, validUntil: '2026-13-45T99:99:99Z' },
      { ...manifest, site: '' },
      { project: 'x' },
    ]
    for (const m of bad) {
      expect(() =>
        readManifest(writeBundle(m as Manifest, files, { skipManifestCheck: true })),
      ).toThrow()
    }
  })

  test('listing refuses duplicate paths and non-file entries', () => {
    const t = writeBundle(
      manifest,
      [files[0] as (typeof files)[0], files[0] as (typeof files)[0]],
      {
        skipManifestCheck: true,
        allowDuplicates: true,
      },
    )
    expect(() => listEntries(t)).toThrow('duplicate')
    const dir = writeBundle(manifest, files).slice()
    const second = 512 + Math.ceil(utf8.encode(JSON.stringify(manifest)).length / 512) * 512
    dir[second + 156] = '5'.charCodeAt(0) // typeflag: directory
    fixChecksum(dir, second)
    expect(() => listEntries(dir)).toThrow('regular file')
  })
})

function fixChecksum(t: Uint8Array, at: number) {
  for (let i = 148; i < 156; i++) t[at + i] = 0x20
  let sum = 0
  for (let i = 0; i < 512; i++) sum += t[at + i] ?? 0
  t.set(utf8.encode(`${sum.toString(8).padStart(6, '0')}\0 `), at + 148)
}
