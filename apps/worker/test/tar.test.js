import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readTar, TarError, unpack } from '../src/tar.js'
import { filesOf, fixture, tarOf } from './helpers.js'

test('a normal archive reads back byte for byte and unpacks', () => {
  const entries = filesOf(fixture('clean'))
  const read = readTar(tarOf(entries))
  assert.deepEqual(
    read.map((e) => e.path),
    entries.map((e) => e.path),
  )
  const dir = mkdtempSync(join(tmpdir(), 'tar-test-'))
  try {
    unpack(read, dir)
    assert.ok(
      readFileSync(join(dir, 'index.html')).equals(
        entries.find((e) => e.path === 'index.html').data,
      ),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('long paths use the ustar prefix field', () => {
  const path = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`
  assert.equal(readTar(tarOf([{ path, data: 'x' }]))[0].path, path)
})

const refused = (entries, pattern) =>
  assert.throws(
    () => readTar(tarOf(entries)),
    (e) => e instanceof TarError && pattern.test(e.message),
  )

test('the reader refuses .., absolute paths and non-regular entries', () => {
  refused([{ path: '../evil.txt', data: 'x' }], /unsafe path/)
  refused([{ path: 'a/../../evil.txt', data: 'x' }], /unsafe path/)
  refused([{ path: '/etc/passwd', data: 'x' }], /unsafe path/)
  refused([{ path: 'C:/evil.txt', data: 'x' }], /unsafe path/)
  refused([{ path: 'a\\b.txt', data: 'x' }], /unsafe path/)
  refused([{ path: 'link', type: '2' }], /not a regular file/)
  refused([{ path: 'dir/', type: '5' }], /not a regular file/)
  refused([{ path: 'pax', type: 'x', data: '' }], /not a regular file/)
  refused(
    [
      { path: 'same.txt', data: 'a' },
      { path: 'same.txt', data: 'b' },
    ],
    /duplicate/,
  )
})

test('a damaged archive is refused', () => {
  const bytes = tarOf([{ path: 'a.txt', data: 'hello' }])
  bytes[10] ^= 1 // header checksum no longer matches
  assert.throws(() => readTar(bytes), TarError)
  assert.throws(() => readTar(tarOf([{ path: 'a.txt', data: 'hello' }]).subarray(0, 520)), TarError)
})
