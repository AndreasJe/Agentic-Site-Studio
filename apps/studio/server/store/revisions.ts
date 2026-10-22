// Projects and revisions on disk (plan §11.2–11.3). Revision files are the truth and never change;
// project.json is an index rebuilt from them plus the project's row in SQLite (decision #41).
import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { suggestSlug, toSlug } from '@site-studio/shared/slug'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { cleanTemps, ImmutableError, writeNew, writeReplace } from './atomic.ts'

export type StoreContext = { db: Database; dataDir: string; instanceId: string }
export type Phase = 'brief' | 'structure' | 'design' | 'verification' | 'build'

export class SlugTakenError extends Error {
  constructor(
    readonly slug: string,
    readonly suggested: string,
    /** The ID is one of the app's own folder names in DATA_DIR, not another project's. */
    readonly reserved = false,
  ) {
    super(`${slug} is taken; suggested ID ${suggested}`)
    this.name = 'SlugTakenError'
  }
}

/**
 * Every name the app keeps at the top of DATA_DIR, beside the project folders (`<DATA_DIR>/<id>/`).
 * The one list: no project ID may equal one of them (RESERVED_PROJECT_IDS), and the entries with
 * `backup: false` are what a whole-instance backup leaves out (backup.ts TOP_LEVEL_EXCLUDED).
 * Some are reserved ahead of use, for what the plan puts in DATA_DIR but is not built yet.
 */
export const DATA_DIR_ENTRIES: readonly { name: string; backup: boolean }[] = [
  { name: 'keys', backup: true }, // app signing, SSH, mail and release keys
  { name: 'media', backup: true }, // the organisation's media library
  { name: 'brand', backup: true }, // Brand and rules
  { name: 'checks', backup: false }, // the check runner's job folders (scratch)
  { name: 'studio.sqlite', backup: false }, // the live database: a snapshot replaces it
  { name: 'studio.sqlite-wal', backup: false },
  { name: 'studio.sqlite-shm', backup: false },
  { name: 'blobs', backup: true },
  { name: 'packages', backup: true },
  { name: 'backups', backup: true },
  { name: 'deploy', backup: true },
  { name: 'release-log', backup: true }, // the built-in release log, not built yet
  { name: 'releaselog', backup: true },
  { name: 'releases', backup: true },
]

/** Project IDs that would share a folder with the app's own data (a database file by its base name). */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set(
  DATA_DIR_ENTRIES.map((e) => toSlug(e.name.split('.')[0] as string)),
)

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/revision.schema.json'), 'utf8'),
)
const validRevision = addFormats(new Ajv2020({ strict: false })).compile(schema)

export const projectDir = (dataDir: string, id: string) => join(dataDir, id)
export const indexPath = (dataDir: string, id: string) => join(dataDir, id, 'project.json')
const revisionsDir = (dataDir: string, id: string) => join(dataDir, id, 'revisions')

export function createProject(ctx: StoreContext, input: { name: string; by: string }) {
  const id = toSlug(input.name)
  if (!id) throw new Error('A project name needs letters or digits for its ID.')
  const taken = (ctx.db.query('select id from projects').all() as { id: string }[]).map((r) => r.id)
  const reserved = RESERVED_PROJECT_IDS.has(id)
  if (reserved || taken.includes(id))
    throw new SlugTakenError(id, suggestSlug(id, [...taken, ...RESERVED_PROJECT_IDS]), reserved)
  ctx.db.transaction(() => {
    ctx.db
      .query('insert into projects (id, name, home, created_at) values (?, ?, ?, ?)')
      .run(id, input.name, ctx.instanceId, new Date().toISOString())
    ctx.db
      .query('insert into members (project_id, user_id) select ?, id from users where handle = ?')
      .run(id, input.by)
  })()
  rebuildIndex(ctx, id)
  return { id, name: input.name }
}

function revisionNumbers(dataDir: string, project: string): number[] {
  const dir = revisionsDir(dataDir, project)
  if (!existsSync(dir)) return []
  const prefix = `${project}-r`
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => Number(f.slice(prefix.length, -5)))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
}

// One save at a time per project in this process (the app is one process, plan §14).
const locks = new Map<string, Promise<unknown>>()
function serialised<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  locks.set(
    key,
    run.catch(() => {}),
  )
  return run
}

/** The newest revision, or null for a project without any (decision #41: current = newest). */
export function currentRevision(dataDir: string, project: string): string | null {
  const n = Math.max(0, ...revisionNumbers(dataDir, project))
  return n > 0 ? `${project}-r${n}` : null
}

export function saveRevision(
  ctx: StoreContext,
  input: {
    project: string
    parent: string | null
    by: string
    phase: Phase
    msg?: string
    files: Record<string, string>
  },
): Promise<string> {
  return serialised(input.project, () => {
    for (;;) {
      const n = Math.max(0, ...revisionNumbers(ctx.dataDir, input.project)) + 1
      const id = `${input.project}-r${n}`
      const doc = {
        id,
        parent: input.parent,
        by: input.by,
        at: new Date().toISOString(),
        ...(input.msg ? { msg: input.msg } : {}),
        phase: input.phase,
        files: input.files,
      }
      if (!validRevision(doc)) {
        throw new Error(`revision refused: ${JSON.stringify(validRevision.errors?.[0] ?? {})}`)
      }
      try {
        writeNew(
          join(revisionsDir(ctx.dataDir, input.project), `${id}.json`),
          new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`),
        )
      } catch (err) {
        if (err instanceof ImmutableError) continue // taken meanwhile: never reuse, take the next
        throw err
      }
      rebuildIndex(ctx, input.project) // written last (plan §11.3)
      return id
    }
  })
}

/** Writes project.json from the revision files and the project's row; same inputs, same bytes. */
export function rebuildIndex(ctx: StoreContext, project: string) {
  cleanTemps(revisionsDir(ctx.dataDir, project))
  const row = ctx.db
    .query('select id, name, home, approved, next_artboard from projects where id = ?')
    .get(project) as {
    id: string
    name: string
    home: string
    approved: string | null
    next_artboard: string
  } | null
  if (!row) throw new Error(`no project ${project}`)
  const numbers = revisionNumbers(ctx.dataDir, project).sort((a, b) => a - b)
  const revisions = numbers.map((n) => {
    const doc = JSON.parse(
      readFileSync(join(revisionsDir(ctx.dataDir, project), `${project}-r${n}.json`), 'utf8'),
    ) as { id: string; parent: string | null; by: string; msg?: string }
    return { id: doc.id, parent: doc.parent, by: doc.by, msg: doc.msg ?? '' }
  })
  const index = {
    id: row.id,
    name: row.name,
    home: row.home,
    next: { revision: (numbers.at(-1) ?? 0) + 1, artboard: row.next_artboard },
    approved: row.approved,
    revisions,
  }
  writeReplace(
    indexPath(ctx.dataDir, project),
    new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`),
  )
}

export type RevisionDoc = {
  id: string
  parent: string | null
  by: string
  at: string
  msg?: string
  phase: Phase
  files: Record<string, string>
}

/** One saved revision, or null if the ID isn't a revision of this project. */
export function readRevision(dataDir: string, project: string, id: string): RevisionDoc | null {
  if (!new RegExp(`^${project}-r[1-9][0-9]*$`).test(id)) return null
  const file = join(revisionsDir(dataDir, project), `${id}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RevisionDoc) : null
}
