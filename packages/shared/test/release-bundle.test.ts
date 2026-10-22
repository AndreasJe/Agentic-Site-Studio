// The M7 release bundle (decisions #23, #27, #47, #48): release-manifest.json with the package hash,
// then site.tar, the M6 package archive byte for byte. verifyBundle is what production runs on it.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { sha256, utf8 } from '../src/bytes.ts'
import {
  listArchive,
  listEntries,
  type Manifest,
  readManifest,
  verifyBundle,
  writeArchive,
  writeBundle,
  writeReleaseBundle,
} from '../src/release/bundle.ts'
import { hex } from '../src/release/challenge.ts'

const manifest: Manifest = {
  project: 'qualiwarego',
  site: 'example.com',
  target: 'production',
  revision: 'qualiwarego-r7',
  validUntil: '2026-10-26T12:00:00Z',
}
const files = [
  { path: 'index.html', bytes: utf8.encode('<!doctype html><p>Hi</p>') },
  { path: 'assets/site.css', bytes: utf8.encode('p{color:#2b675b}') },
]
const pending = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../contracts/release-manifest.schema.json'), 'utf8'),
)
const validManifest = addFormats(new Ajv2020({ strict: false })).compile(pending)

describe('release bundle', () => {
  test('is the manifest with the package hash, then site.tar unchanged; deterministic', async () => {
    const siteTar = writeArchive(files)
    const a = await writeReleaseBundle(manifest, siteTar)
    expect(a).toEqual(await writeReleaseBundle(manifest, siteTar))
    const entries = listEntries(a)
    expect(entries.map((e) => e.path)).toEqual(['release-manifest.json', 'site.tar'])
    const site = entries[1] as (typeof entries)[1]
    expect(a.subarray(site.offset, site.offset + site.size)).toEqual(siteTar)
    const m = readManifest(a, { requirePackageHash: true })
    expect(m.packageHash).toBe(`sha256:${hex(await sha256(siteTar))}`)
    expect(validManifest(m)).toBe(true)

    const v = await verifyBundle(a)
    expect(v.manifest).toEqual(m as typeof v.manifest)
    expect(v.site).toEqual(siteTar)
    expect(v.files.map((f) => f.path)).toEqual(['assets/site.css', 'index.html'])
    const index = v.files[1] as (typeof v.files)[1]
    expect(v.site.subarray(index.offset, index.offset + index.size)).toEqual(
      utf8.encode('<!doctype html><p>Hi</p>'),
    )
  })

  test('the pending schema requires the package hash; the agreed one is unchanged', () => {
    expect(validManifest(manifest)).toBe(false)
    expect(validManifest({ ...manifest, packageHash: 'sha256:abc' })).toBe(false)
  })

  test('refuses a manifest hash that does not match, at build and at verify', async () => {
    const siteTar = writeArchive(files)
    const zero = `sha256:${'0'.repeat(64)}`
    await expect(writeReleaseBundle({ ...manifest, packageHash: zero }, siteTar)).rejects.toThrow(
      'does not match',
    )
    const wrong = writeBundle({ ...manifest, packageHash: zero }, [
      { path: 'site.tar', bytes: siteTar },
    ])
    await expect(verifyBundle(wrong)).rejects.toThrow('packageHash')
    // A changed site.tar under a manifest that named the original.
    const good = await writeReleaseBundle(manifest, siteTar)
    const changed = good.slice()
    const at = changed.length - 1024 - 600
    changed[at] = (changed[at] ?? 0) ^ 1
    await expect(verifyBundle(changed)).rejects.toThrow('packageHash')
  })

  test('refuses anything but exactly the manifest and site.tar', async () => {
    const siteTar = writeArchive(files)
    const packageHash = `sha256:${hex(await sha256(siteTar))}`
    const m = { ...manifest, packageHash }
    // No package hash: the old layout.
    await expect(verifyBundle(writeBundle(manifest, files))).rejects.toThrow()
    // Files straight after the manifest, even with a hash.
    await expect(verifyBundle(writeBundle(m, files))).rejects.toThrow('nothing else')
    // site.tar plus something else.
    const extra = writeBundle(m, [
      { path: 'site.tar', bytes: siteTar },
      { path: 'extra.txt', bytes: utf8.encode('x') },
    ])
    await expect(verifyBundle(extra)).rejects.toThrow('nothing else')
    // site.tar under another name.
    await expect(
      verifyBundle(writeBundle(m, [{ path: 'site.tgz', bytes: siteTar }])),
    ).rejects.toThrow('nothing else')
    // A site.tar that is not an archive.
    const junk = utf8.encode('not a tar')
    const junkHash = `sha256:${hex(await sha256(junk))}`
    await expect(
      verifyBundle(
        writeBundle({ ...manifest, packageHash: junkHash }, [{ path: 'site.tar', bytes: junk }]),
      ),
    ).rejects.toThrow()
  })

  test('site.tar is read strictly: limits, unportable names, file-and-folder clashes', () => {
    const tar = writeArchive(files)
    expect(listArchive(tar).length).toBe(2)
    expect(() =>
      listArchive(tar, { maxEntries: 1, maxFileBytes: 1e6, maxTotalBytes: 1e6 }),
    ).toThrow('too many entries')
    expect(() =>
      listArchive(tar, { maxEntries: 10, maxFileBytes: 10, maxTotalBytes: 1e6 }),
    ).toThrow('file too large')
    expect(() =>
      listArchive(tar, { maxEntries: 10, maxFileBytes: 1e6, maxTotalBytes: 30 }),
    ).toThrow('archive too large')
    for (const path of ['con.html', 'a/NUL', 'lpt1.txt', 'trailing.']) {
      expect(() => listArchive(writeArchive([{ path, bytes: utf8.encode('x') }]))).toThrow(
        'unportable',
      )
    }
    const clash = writeArchive([
      { path: 'about', bytes: utf8.encode('x') },
      { path: 'about/index.html', bytes: utf8.encode('y') },
    ])
    expect(() => listArchive(clash)).toThrow('both a file and a folder')
    // The bundle's own rules still apply inside site.tar.
    const dup = writeBundle(
      manifest,
      [files[0] as (typeof files)[0], files[0] as (typeof files)[0]],
      {
        skipManifestCheck: true,
        allowDuplicates: true,
      },
    )
    expect(() => listEntries(dup)).toThrow('duplicate')
  })
})
