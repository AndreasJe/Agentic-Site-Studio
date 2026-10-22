// M1 step 2: atomic, write-once storage and the SQLite schema (CLAUDE.md rule 2; M1 Done when).
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, openDb } from '../server/db/index.ts'
import { cleanTemps, ImmutableError, writeNew, writeReplace } from '../server/store/atomic.ts'
import { getBlob, putBlob } from '../server/store/blobs.ts'

const root = mkdtempSync(join(tmpdir(), 'studio-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
const enc = new TextEncoder()

describe('write-once files', () => {
  test('a new file is written; writing it again fails and leaves it unchanged', () => {
    const file = join(root, 'a', 'rev-1.json')
    writeNew(file, enc.encode('{"v":1}'))
    expect(() => writeNew(file, enc.encode('{"v":2}'))).toThrow(ImmutableError)
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}')
    expect(readdirSync(join(root, 'a'))).toEqual(['rev-1.json'])
  })

  test('replaceable files (project.json) are swapped atomically', () => {
    const file = join(root, 'b', 'project.json')
    writeReplace(file, enc.encode('one'))
    writeReplace(file, enc.encode('two'))
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(readdirSync(join(root, 'b'))).toEqual(['project.json'])
  })

  test('leftover temp files from a crash are removed at start', () => {
    const dir = join(root, 'c')
    writeNew(join(dir, 'keep.json'), enc.encode('k'))
    writeFileSync(join(dir, 'keep.json.123.tmp'), 'half')
    cleanTemps(dir)
    expect(readdirSync(dir)).toEqual(['keep.json'])
  })
})

describe('blob store', () => {
  test('content-addressed, deduplicated, verified on read, never rewritten', async () => {
    const dir = join(root, 'proj')
    const h = await putBlob(dir, enc.encode('hello'))
    expect(h).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(
      existsSync(
        join(dir, 'blobs/sha256/2c/f24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'),
      ),
    ).toBe(true)
    expect(await putBlob(dir, enc.encode('hello'))).toBe(h)
    expect(new TextDecoder().decode(await getBlob(dir, h))).toBe('hello')
    // A blob whose bytes were changed on disk is refused on read.
    writeFileSync(
      join(dir, 'blobs/sha256/2c/f24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'),
      'tampered',
    )
    await expect(getBlob(dir, h)).rejects.toThrow('hash')
    await expect(getBlob(dir, 'sha256:../../x')).rejects.toThrow()
  })
})

describe('killing the process mid-write', () => {
  test('never leaves a half-written revision (100 hard kills)', async () => {
    const dir = join(root, 'kill')
    const writer = join(import.meta.dir, 'kill-writer.ts')
    for (let i = 0; i < 100; i++) {
      const p = Bun.spawn([process.execPath, writer, dir], { stdout: 'pipe', stderr: 'ignore' })
      // Start the clock once the child runs: a slow start-up would otherwise kill it before any write.
      await p.stdout.getReader().read()
      await Bun.sleep(5 + (i % 25))
      p.kill('SIGKILL')
      await p.exited
    }
    cleanTemps(join(dir, 'revisions'))
    const files = existsSync(join(dir, 'revisions')) ? readdirSync(join(dir, 'revisions')) : []
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(f).toMatch(/^r\d+\.json$/)
      const doc = JSON.parse(readFileSync(join(dir, 'revisions', f), 'utf8'))
      expect(doc.padding.length).toBe(200_000)
    }
  }, 60_000)
})

describe('database', () => {
  test('migrations create the M1 tables and are idempotent', () => {
    const file = join(root, 'studio.sqlite')
    openDb(file).close()
    const db = openDb(file)
    const tables = db
      .query("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of ['drafts', 'members', 'projects', 'sessions', 'usage', 'users', 'versions']) {
      expect(tables).toContain(t)
    }
    expect((db.query('pragma user_version').get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    )
    db.close()
  })
})
