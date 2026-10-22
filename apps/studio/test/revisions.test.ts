// M1 step 3: slugs, revisions and the rebuildable project.json (plan §11.2–11.3; decision #41).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suggestSlug, toSlug } from '@site-studio/shared/slug'
import { openDb } from '../server/db/index.ts'
import {
  createProject,
  DATA_DIR_ENTRIES,
  indexPath,
  RESERVED_PROJECT_IDS,
  rebuildIndex,
  SlugTakenError,
  saveRevision,
} from '../server/store/revisions.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'studio-rev-'))
afterAll(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
const db = openDb(join(dataDir, 'studio.sqlite'))
db.run(
  "insert into users (handle, name, role, created_at) values ('alex', 'Alex', 'creator', 'now')",
)
const ctx = { db, dataDir, instanceId: 'qw-office' }
const HASH = `sha256:${'a'.repeat(64)}`

describe('slugs', () => {
  test.each([
    ['QualiWare GO', 'qualiwarego'],
    ['Blåbær Ø', 'blaabaeroe'],
    ['Café Crème', 'cafecreme'],
    ['  2026 launch! ', '2026launch'],
    ['---', ''],
  ])('%p → %p', (name, slug) => {
    expect(toSlug(name)).toBe(slug)
  })

  test('a taken slug gets the next free number', () => {
    expect(suggestSlug('qualiwarego', ['qualiwarego'])).toBe('qualiwarego2')
    expect(suggestSlug('qualiwarego', ['qualiwarego', 'qualiwarego2'])).toBe('qualiwarego3')
  })
})

describe('projects', () => {
  test('creating a project locks its ID and makes the creator a member', () => {
    const p = createProject(ctx, { name: 'QualiWare GO', by: 'alex' })
    expect(p.id).toBe('qualiwarego')
    expect(
      db.query('select count(*) as n from members where project_id = ?').get('qualiwarego'),
    ).toEqual({ n: 1 })
  })

  test('a collision is refused with a suggestion, before anything is created', () => {
    try {
      createProject(ctx, { name: 'QualiWare GO', by: 'alex' })
      throw new Error('should have refused')
    } catch (err) {
      expect(err).toBeInstanceOf(SlugTakenError)
      expect((err as SlugTakenError).suggested).toBe('qualiwarego2')
    }
  })

  test.each([
    ['Keys', 'keys'],
    ['Checks', 'checks'],
    ['Media', 'media'],
    ['Studio', 'studio'],
    ['Release log', 'releaselog'],
  ])('%p would share a folder with the app’s own data: refused with a suggestion', (name, id) => {
    try {
      createProject(ctx, { name, by: 'alex' })
      throw new Error('should have refused')
    } catch (err) {
      expect(err).toBeInstanceOf(SlugTakenError)
      expect((err as SlugTakenError).slug).toBe(id)
      expect((err as SlugTakenError).reserved).toBe(true)
      expect((err as SlugTakenError).suggested).toBe(`${id}2`)
    }
    expect(db.query('select 1 from projects where id = ?').get(id)).toBeNull()
  })

  test('every top-level name the app writes in DATA_DIR is a reserved ID', () => {
    for (const name of DATA_DIR_ENTRIES.map((e) => e.name)) {
      expect(RESERVED_PROJECT_IDS.has(toSlug(name.split('.')[0] as string))).toBe(true)
    }
    for (const id of ['keys', 'checks', 'media', 'brand', 'blobs', 'packages', 'backups'])
      expect(RESERVED_PROJECT_IDS.has(id)).toBe(true)
    expect(createProject(ctx, { name: 'Keys2', by: 'alex' }).id).toBe('keys2')
  })

  test('a name with no usable letters or digits is refused', () => {
    expect(() => createProject(ctx, { name: '!!!', by: 'alex' })).toThrow('letters or digits')
  })
})

describe('revisions', () => {
  test('numbers run in order, files validate, parents are recorded', async () => {
    createProject(ctx, { name: 'Rev one', by: 'alex' })
    const r1 = await saveRevision(ctx, {
      project: 'revone',
      parent: null,
      by: 'alex',
      phase: 'brief',
      msg: 'Brief completed',
      files: { 'brief.json': HASH },
    })
    const r2 = await saveRevision(ctx, {
      project: 'revone',
      parent: r1,
      by: 'alex',
      phase: 'design',
      files: { 'brief.json': HASH },
    })
    expect([r1, r2]).toEqual(['revone-r1', 'revone-r2'])
    const doc = JSON.parse(readFileSync(join(dataDir, 'revone/revisions/revone-r2.json'), 'utf8'))
    expect(doc).toMatchObject({ id: 'revone-r2', parent: 'revone-r1', by: 'alex', phase: 'design' })
  })

  test('a revision that fails the contract is refused and uses no number', async () => {
    createProject(ctx, { name: 'Bad rev', by: 'alex' })
    await expect(
      saveRevision(ctx, {
        project: 'badrev',
        parent: null,
        by: 'alex',
        phase: 'review' as 'design',
        files: {},
      }),
    ).rejects.toThrow('revision')
    expect(
      await saveRevision(ctx, {
        project: 'badrev',
        parent: null,
        by: 'alex',
        phase: 'brief',
        files: {},
      }),
    ).toBe('badrev-r1')
  })

  test('20 concurrent saves get 20 different numbers', async () => {
    createProject(ctx, { name: 'Busy', by: 'alex' })
    const ids = await Promise.all(
      Array.from({ length: 20 }, () =>
        saveRevision(ctx, { project: 'busy', parent: null, by: 'alex', phase: 'brief', files: {} }),
      ),
    )
    expect(new Set(ids).size).toBe(20)
    expect(ids.map((i) => Number(i.split('-r')[1])).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    )
  })

  test('project.json can be deleted and rebuilt byte for byte', async () => {
    const before = readFileSync(indexPath(dataDir, 'busy'))
    unlinkSync(indexPath(dataDir, 'busy'))
    rebuildIndex(ctx, 'busy')
    expect(readFileSync(indexPath(dataDir, 'busy'))).toEqual(before)
    const idx = JSON.parse(before.toString())
    expect(idx).toMatchObject({
      id: 'busy',
      name: 'Busy',
      home: 'qw-office',
      next: { revision: 21, artboard: 'a' },
    })
    expect(idx.revisions).toHaveLength(20)
  })
})
