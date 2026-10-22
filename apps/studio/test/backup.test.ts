// M8.1: backup and restore (plan §12.2). Done-when: a restore into a clean dir gives an identical
// project, compared by hashes and rows.

import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeArchive } from '@site-studio/shared/release'
import {
  applyRetention,
  backupName,
  buildPayload,
  createBackup,
  openArchive,
  PROJECT_ROWS,
  projectRows,
  restoreBackup,
  TOP_LEVEL_EXCLUDED,
} from '../server/backup/backup.ts'
import { decrypt, encrypt } from '../server/backup/crypto.ts'
import { isDue, readSchedule, runIfDue, writeSchedule } from '../server/backup/schedule.ts'
import { BackupError, FolderTarget, RcloneTarget } from '../server/backup/target.ts'
import { openDb } from '../server/db/index.ts'
import { putBlob } from '../server/store/blobs.ts'
import { createProject, DATA_DIR_ENTRIES, saveRevision } from '../server/store/revisions.ts'

const root = mkdtempSync(join(tmpdir(), 'studio-backup-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
const enc = new TextEncoder()
const PASS = 'correct horse battery staple'
const T0 = Date.parse('2026-10-01T10:00:00Z')

/** Every file under a folder with its hash, relative paths sorted. */
function tree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, tree(dir, r))
    else
      out[r] = createHash('sha256')
        .update(readFileSync(join(dir, r)))
        .digest('hex')
  }
  return out
}

async function world() {
  const dataDir = mkdtempSync(join(root, 'data-'))
  const db = openDb(join(dataDir, 'studio.sqlite'))
  db.run(
    "insert into users (handle, name, role, created_at) values ('alex', 'Alex', 'creator', 'now')",
  )
  const ctx = { db, dataDir, instanceId: 'qw' }
  for (const name of ['Alpha', 'Beta']) {
    const p = createProject(ctx, { name, by: 'alex' })
    const dir = join(dataDir, p.id)
    const hash = await putBlob(dir, enc.encode(`blob for ${p.id}`))
    await saveRevision(ctx, {
      project: p.id,
      parent: null,
      by: 'alex',
      phase: 'brief',
      files: { 'index.html': hash },
    })
    await saveRevision(ctx, {
      project: p.id,
      parent: `${p.id}-r1`,
      by: 'alex',
      phase: 'design',
      files: { 'index.html': hash },
    })
    db.run(
      "insert into site_languages (project_id, enabled, default_language, languages, updated_by, updated_at) values (?, 1, 'en', '[\"en\"]', 'alex', 'now')",
      [p.id],
    )
    db.run(
      "insert into media (scope, title, hash, mime, size, filename, created_by, created_at, updated_at) values (?, 'Pic', ?, 'image/png', 1, 'a.png', 1, 'now', 'now')",
      [`p:${p.id}`, hash],
    )
  }
  mkdirSync(join(dataDir, 'brand'), { recursive: true })
  writeFileSync(join(dataDir, 'brand', 'guide-v1.json'), '{"v":1}')
  mkdirSync(join(dataDir, 'keys'), { recursive: true })
  writeFileSync(join(dataDir, 'keys', 'k.json'), '{"secret":"x"}')
  mkdirSync(join(dataDir, 'checks'), { recursive: true })
  writeFileSync(join(dataDir, 'checks', 'run1.json'), 'scratch')
  writeFileSync(join(dataDir, 'alpha', 'half-written.json.1-1.tmp'), 'tmp')
  const target = new FolderTarget(mkdtempSync(join(root, 'target-')))
  return { dataDir, db, target, ctx }
}

const input = (w: Awaited<ReturnType<typeof world>>, extra = {}) => ({
  db: w.db,
  dataDir: w.dataDir,
  passphrase: PASS,
  scope: { kind: 'all' } as const,
  target: w.target,
  appVersion: '0.8.0',
  now: () => T0,
  ...extra,
})

describe('backup and restore of the whole instance', () => {
  test('restore into a clean dir gives identical files, hashes, project.json and rows', async () => {
    const w = await world()
    const r = await createBackup(input(w))
    const dest = join(root, 'restored-all')
    await restoreBackup({ target: w.target, name: r.name, passphrase: PASS, destDir: dest })

    const original = tree(w.dataDir)
    const restored = tree(dest)
    // Everything except the live DB, scratch, and temp files comes back byte for byte.
    for (const [path, hash] of Object.entries(original)) {
      if (path === 'studio.sqlite') continue // replaced by the snapshot, compared by rows below
      if (
        path.startsWith('studio.sqlite-') ||
        path.startsWith('checks/') ||
        path.endsWith('.tmp')
      ) {
        expect(restored[path]).toBeUndefined()
      } else expect(restored[path]).toBe(hash)
    }
    expect(Object.keys(restored).filter((p) => !(p in original))).toEqual([])
    expect(restored['alpha/project.json']).toBe(original['alpha/project.json'])
    expect(Object.keys(restored).some((p) => p.includes('blobs/sha256/'))).toBe(true)
    expect(Object.keys(restored).some((p) => p.startsWith('keys/'))).toBe(true)

    const copy = new Database(join(dest, 'studio.sqlite'), { readonly: true, strict: true })
    for (const id of ['alpha', 'beta']) {
      expect(projectRows(copy, id)).toEqual(projectRows(w.db, id))
    }
    expect(projectRows(copy, 'alpha').media?.length).toBe(1)
    copy.close()
    w.db.close()
  })

  test('the file is encrypted and has a sidecar with no file names', async () => {
    const w = await world()
    const r = await createBackup(input(w))
    const sealed = readFileSync(join(w.target.dir, r.name))
    expect(Buffer.from(sealed).includes('alpha')).toBe(false)
    expect(Buffer.from(sealed).includes('blob for')).toBe(false)
    const side = JSON.parse(readFileSync(join(w.target.dir, `${r.name}.json`), 'utf8'))
    expect(side).toMatchObject({ createdAt: '2026-10-01T10:00:00.000Z', appVersion: '0.8.0' })
    expect(JSON.stringify(side)).not.toContain('alpha')
    w.db.close()
  })

  test('the manifest lists every file with its SHA-256, the time and the version', async () => {
    const w = await world()
    const { manifest } = buildPayload(input(w), new Date(T0).toISOString())
    expect(manifest.appVersion).toBe('0.8.0')
    expect(manifest.createdAt).toBe('2026-10-01T10:00:00.000Z')
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    const paths = manifest.files.map((f) => f.path)
    expect(paths).toContain('studio.sqlite')
    expect(paths.some((p) => p.startsWith('brand/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('checks/') || p.endsWith('.tmp'))).toBe(false)
    w.db.close()
  })
})

describe('the top-level names (review finding 4)', () => {
  test('backup leaves out exactly the DATA_DIR entries marked so, and keeps the rest', async () => {
    const skipped = DATA_DIR_ENTRIES.filter((e) => !e.backup).map((e) => e.name)
    expect([...TOP_LEVEL_EXCLUDED].sort()).toEqual([...skipped].sort())
    expect(skipped).toContain('checks')
    expect(skipped).toContain('studio.sqlite')
    const w = await world()
    for (const e of DATA_DIR_ENTRIES) {
      if (e.name.includes('.')) continue
      mkdirSync(join(w.dataDir, e.name), { recursive: true })
      writeFileSync(join(w.dataDir, e.name, 'probe.json'), '{}')
    }
    const paths = buildPayload(input(w), new Date(T0).toISOString()).manifest.files.map(
      (f) => f.path,
    )
    for (const e of DATA_DIR_ENTRIES) {
      if (e.name.includes('.')) continue
      expect(paths.includes(`${e.name}/probe.json`)).toBe(e.backup)
    }
    w.db.close()
  })

  test('a project-scope backup of a reserved name is refused', async () => {
    const w = await world()
    w.db.run(
      "insert into projects (id, name, home, created_at) values ('keys', 'Keys', 'qw', 'now')",
    )
    expect(createBackup(input(w, { scope: { kind: 'project', id: 'keys' } }))).rejects.toThrow(
      BackupError,
    )
    w.db.close()
  })
})

describe('backup of one project', () => {
  test('restores that project only, with its rows', async () => {
    const w = await world()
    const r = await createBackup(input(w, { scope: { kind: 'project', id: 'alpha' } }))
    expect(r.name).toContain('ssb-p-alpha-')
    const dest = join(root, 'restored-alpha')
    await restoreBackup({ target: w.target, name: r.name, passphrase: PASS, destDir: dest })
    const original = tree(join(w.dataDir, 'alpha'))
    const restored = tree(join(dest, 'alpha'))
    for (const [p, h] of Object.entries(original)) {
      if (!p.endsWith('.tmp')) expect(restored[p]).toBe(h)
    }
    expect(existsSync(join(dest, 'beta'))).toBe(false)
    expect(existsSync(join(dest, 'keys'))).toBe(false)
    expect(existsSync(join(dest, 'studio.sqlite'))).toBe(false)
    const rows = JSON.parse(readFileSync(join(dest, ...PROJECT_ROWS.split('/')), 'utf8'))
    expect(rows).toEqual(JSON.parse(JSON.stringify(projectRows(w.db, 'alpha'))))
    expect(JSON.stringify(rows)).not.toContain('beta')
    w.db.close()
  })

  test('an unknown or unsafe project id is refused', async () => {
    const w = await world()
    for (const id of ['nope', '../x', 'alpha/..']) {
      expect(createBackup(input(w, { scope: { kind: 'project', id } }))).rejects.toThrow(
        BackupError,
      )
    }
    w.db.close()
  })
})

describe('refusals', () => {
  test('a wrong passphrase is refused and nothing is written', async () => {
    const w = await world()
    const r = await createBackup(input(w))
    const dest = join(root, 'wrong-pass')
    const err = await restoreBackup({
      target: w.target,
      name: r.name,
      passphrase: 'not the passphrase',
      destDir: dest,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect(err.code).toBe('wrong-passphrase-or-tampered')
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(root).some((n) => n.startsWith('wrong-pass'))).toBe(false)
    w.db.close()
  })

  test('a tampered archive is refused (any changed byte)', async () => {
    const w = await world()
    const r = await createBackup(input(w))
    const file = join(w.target.dir, r.name)
    const sealed = new Uint8Array(readFileSync(file))
    for (const at of [3, 10, 40, Math.floor(sealed.length / 2), sealed.length - 1]) {
      const bad = sealed.slice()
      bad[at] = (bad[at] as number) ^ 0x01
      const t = new FolderTarget(mkdtempSync(join(root, 'tamper-')))
      await t.put('x.ssbak', bad)
      const dest = join(root, `tampered-${at}`)
      await expect(
        restoreBackup({ target: t, name: 'x.ssbak', passphrase: PASS, destDir: dest }),
      ).rejects.toBeInstanceOf(BackupError)
      expect(existsSync(dest)).toBe(false)
    }
    w.db.close()
  })

  test('a validly encrypted archive whose file does not match its manifest is refused', async () => {
    const w = await world()
    const { entries } = buildPayload(input(w), new Date(T0).toISOString())
    const doctored = entries.map((e, i) =>
      i === 3 ? { path: e.path, bytes: enc.encode('changed content') } : e,
    )
    const sealed = encrypt(writeArchive(doctored), PASS)
    const t = new FolderTarget(mkdtempSync(join(root, 'doctored-')))
    await t.put('x.ssbak', sealed)
    const dest = join(root, 'doctored-dest')
    await expect(
      restoreBackup({ target: t, name: 'x.ssbak', passphrase: PASS, destDir: dest }),
    ).rejects.toMatchObject({ code: 'hash-mismatch' })
    expect(existsSync(dest)).toBe(false)
    // And an extra file the manifest doesn't know:
    const extra = writeArchive([...entries, { path: 'd/999999', bytes: enc.encode('x') }])
    expect(() => openArchive(extra)).toThrow(BackupError)
    w.db.close()
  })

  test('an existing destination is never overwritten', async () => {
    const w = await world()
    const r = await createBackup(input(w))
    const dest = mkdtempSync(join(root, 'exists-'))
    writeFileSync(join(dest, 'keep.txt'), 'mine')
    await expect(
      restoreBackup({ target: w.target, name: r.name, passphrase: PASS, destDir: dest }),
    ).rejects.toMatchObject({ code: 'dest-exists' })
    expect(readdirSync(dest)).toEqual(['keep.txt'])
    w.db.close()
  })

  test('a weak passphrase, a non-backup file and a hostile manifest path are refused', async () => {
    const w = await world()
    await expect(createBackup(input(w, { passphrase: 'short' }))).rejects.toMatchObject({
      code: 'weak-passphrase',
    })
    expect(() => decrypt(enc.encode('this is not a backup at all, really not'), PASS)).toThrow(
      BackupError,
    )
    const { manifest, entries } = buildPayload(input(w), new Date(T0).toISOString())
    const bad = {
      ...manifest,
      files: manifest.files.map((f, i) => (i === 0 ? { ...f, path: '../escape' } : f)),
    }
    const hostile = entries.map((e, i) =>
      i === 0 ? { ...e, bytes: enc.encode(JSON.stringify(bad)) } : e,
    )
    expect(() => openArchive(writeArchive(hostile))).toThrow(/unsafe path/)
    w.db.close()
  })
})

describe('targets', () => {
  test('the folder target stores, lists, reads and removes; it never replaces', async () => {
    const t = new FolderTarget(mkdtempSync(join(root, 'ft-')))
    await t.put('a.ssbak', enc.encode('one'))
    await expect(t.put('a.ssbak', enc.encode('two'))).rejects.toMatchObject({ code: 'exists' })
    expect((await t.list()).map((f) => f.name)).toEqual(['a.ssbak'])
    expect(new TextDecoder().decode(await t.get('a.ssbak'))).toBe('one')
    await t.remove('a.ssbak')
    expect(await t.list()).toEqual([])
    await expect(t.get('a.ssbak')).rejects.toMatchObject({ code: 'not-found' })
    await expect(t.get('../x')).rejects.toMatchObject({ code: 'bad-name' })
  })

  test('rclone is pending: every call says needs-rclone', async () => {
    const t = new RcloneTarget('remote:')
    await expect(t.list()).rejects.toMatchObject({ code: 'needs-rclone' })
    await expect(t.put('a', new Uint8Array())).rejects.toMatchObject({ code: 'needs-rclone' })
  })
})

describe('retention', () => {
  const day = 86400_000
  async function seed() {
    const t = new FolderTarget(mkdtempSync(join(root, 'ret-')))
    for (let d = 0; d < 6; d++) {
      const name = backupName({ kind: 'all' }, T0 - d * day)
      await t.put(name, enc.encode('x'))
      await t.put(`${name}.json`, enc.encode('{}'))
    }
    await t.put(backupName({ kind: 'project', id: 'alpha' }, T0 - 9 * day), enc.encode('x'))
    return t
  }
  const names = async (t: FolderTarget) =>
    (await t.list()).map((f) => f.name).filter((n) => n.endsWith('.ssbak'))

  test('keep the last N per scope', async () => {
    const t = await seed()
    const removed = await applyRetention(t, { keepLast: 2 }, T0)
    expect(removed).toHaveLength(4)
    const left = await names(t)
    expect(left.filter((n) => n.startsWith('ssb-all-'))).toHaveLength(2)
    expect(left.filter((n) => n.startsWith('ssb-p-alpha-'))).toHaveLength(1) // newest is kept
    expect((await t.list()).filter((f) => f.name.endsWith('.json'))).toHaveLength(2) // sidecars go too
  })

  test('keep the last N days, but never the only backup of a scope', async () => {
    const t = await seed()
    await applyRetention(t, { keepDays: 3 }, T0)
    const left = await names(t)
    expect(left.filter((n) => n.startsWith('ssb-all-'))).toHaveLength(4) // 0..3 days old
    expect(left.some((n) => n.startsWith('ssb-p-alpha-'))).toBe(true)
  })

  test('no rule, or a nonsense rule, is refused', async () => {
    const t = await seed()
    await expect(applyRetention(t, {}, T0)).rejects.toMatchObject({ code: 'no-retention-rule' })
    await expect(applyRetention(t, { keepLast: 0 }, T0)).rejects.toMatchObject({
      code: 'bad-retention',
    })
  })
})

describe('the scheduler (no real timer)', () => {
  const H = 3600_000
  test('isDue from the last run and an interval', () => {
    expect(isDue(null, 24, T0)).toBe(true)
    expect(isDue(null, undefined, T0)).toBe(false)
    expect(isDue(null, 0, T0)).toBe(false)
    const last = new Date(T0).toISOString()
    expect(isDue(last, 24, T0 + 23 * H)).toBe(false)
    expect(isDue(last, 24, T0 + 24 * H)).toBe(true)
    expect(isDue('garbage', 24, T0)).toBe(true)
  })

  test('runIfDue runs once per interval, records the time and prunes', async () => {
    const w = await world()
    writeSchedule(w.db, { intervalHours: 24, keepLast: 2 })
    let now = T0
    const run = () => runIfDue({ ...input(w), now: () => now })

    const first = await run()
    expect(first?.createdAt).toBe(new Date(T0).toISOString())
    expect(readSchedule(w.db).lastRun).toBe(new Date(T0).toISOString())
    now = T0 + 6 * H
    expect(await run()).toBeNull()
    for (const d of [1, 2, 3]) {
      now = T0 + d * 24 * H
      expect(await run()).not.toBeNull()
    }
    expect((await w.target.list()).filter((f) => f.name.endsWith('.ssbak'))).toHaveLength(2)
    w.db.close()
  })

  test('with no interval nothing runs', async () => {
    const w = await world()
    expect(await runIfDue({ ...input(w), now: () => T0 })).toBeNull()
    expect(await w.target.list()).toEqual([])
    w.db.close()
  })
})
