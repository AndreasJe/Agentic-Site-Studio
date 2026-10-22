// Backup and restore (plan §12.2, M8.1). One encrypted file per run: a ustar archive (the shared
// writer) holding a manifest, the SQLite snapshot (or the project's rows) and the DATA_DIR files,
// each with its SHA-256. Restore always makes a NEW directory, verifies every hash, and refuses
// on any mismatch. Files in the archive are stored as d/000001, d/000002 ... and the manifest maps
// them to their real relative paths, so tar's name rules never touch the content.
//
// Limit: the archive is built and read in memory. Fine for the concept; a streaming format is
// the next step when instances grow past a few hundred MB.
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { listArchive, writeArchive } from '@site-studio/shared/release'
import { writeNew } from '../store/atomic.ts'
import { decrypt, encrypt } from './crypto.ts'
import { BackupError, type BackupTarget } from './target.ts'

export const FORMAT = 1
export const DB_SNAPSHOT = 'studio.sqlite'
export const PROJECT_ROWS = '.backup/project-rows.json'
const MANIFEST_ENTRY = 'manifest.json'

export type Scope = { kind: 'all' } | { kind: 'project'; id: string }

export type ManifestFile = { path: string; size: number; sha256: string; entry: string }
export type BackupManifest = {
  format: number
  createdAt: string
  appVersion: string
  scope: Scope
  files: ManifestFile[]
}

/** What stays out of DATA_DIR copies: the live database (a snapshot replaces it), check scratch. */
const TOP_LEVEL_EXCLUDED = new Set([
  'checks',
  'studio.sqlite',
  'studio.sqlite-wal',
  'studio.sqlite-shm',
])

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const PROJECT_ID = /^[a-z0-9]+$/

// --- what is in a project's database rows -------------------------------------------------------

const BY_ARTBOARD = '(select id from artboards where project_id = :p)'
const BY_MEDIA = "(select id from media where scope = 'p:' || :p)"
const BY_DRAFT = '(select id from drafts where project_id = :p)'
const BY_REQUEST = '(select id from publication_requests where project_id = :p)'

/** Tables with rows that belong to one project, and how to select them. */
export const PROJECT_TABLES: [table: string, where: string][] = [
  ['projects', 'id = :p'],
  ['members', 'project_id = :p'],
  ['drafts', 'project_id = :p'],
  ['versions', `draft_id in ${BY_DRAFT}`],
  ['usage', 'project = :p'],
  ['materials', 'project_id = :p'],
  ['brief_approvals', 'project_id = :p'],
  ['media', "scope = 'p:' || :p"],
  ['media_versions', `media_id in ${BY_MEDIA}`],
  ['media_uses', `media_id in ${BY_MEDIA}`],
  ['artboards', 'project_id = :p'],
  ['sections', `artboard_id in ${BY_ARTBOARD}`],
  ['deviations', `artboard_id in ${BY_ARTBOARD}`],
  ['takes', `artboard_id in ${BY_ARTBOARD}`],
  ['guide_proposals', 'project_id = :p'],
  ['revision_approvals', 'project_id = :p'],
  ['a11y_acceptances', 'project_id = :p'],
  ['check_runs', 'project_id = :p'],
  ['staged', 'project_id = :p'],
  ['failure_analyses', 'project_id = :p'],
  ['address_decisions', 'project_id = :p'],
  ['site_languages', 'project_id = :p'],
  ['publication_requests', 'project_id = :p'],
  ['review_acknowledgements', `request_id in ${BY_REQUEST}`],
]

/** One project's rows, in a stable order. Used by the backup and by the tests' comparison. */
export function projectRows(db: Database, project: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const [table, where] of PROJECT_TABLES) {
    out[table] = db
      .query(`select * from ${table} where ${where} order by rowid`)
      .all({ p: project })
  }
  return out
}

// --- reading the data directory -----------------------------------------------------------------

function walk(root: string, rel: string, out: string[], excluded: Set<string>) {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (!rel && excluded.has(e.name)) continue
    if (e.name.endsWith('.tmp')) continue
    if (e.isDirectory()) walk(root, r, out, excluded)
    else if (e.isFile()) out.push(r) // symlinks and devices are never followed
  }
}

function readIfThere(path: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(path))
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null // a temp file that just went
    throw err
  }
}

function snapshot(db: Database): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'studio-snap-'))
  try {
    const file = join(dir, 'snapshot.sqlite')
    db.exec(`vacuum into '${file.replaceAll("'", "''")}'`)
    return new Uint8Array(readFileSync(file))
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

// --- backup -------------------------------------------------------------------------------------

export type BackupInput = {
  db: Database
  dataDir: string
  passphrase: string
  scope: Scope
  target: BackupTarget
  appVersion: string
  now?: () => number
  /** Top-level DATA_DIR names to leave out too, e.g. a backup folder kept inside it. */
  exclude?: string[]
}

export type BackupResult = { name: string; size: number; files: number; createdAt: string }

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
export const backupName = (scope: Scope, ms: number) =>
  `ssb-${scope.kind === 'all' ? 'all' : `p-${scope.id}`}-${stamp(ms)}.ssbak`

/** Collect, hash and pack (not yet encrypted). Exposed for tests, which tamper with the parts. */
export function buildPayload(input: Omit<BackupInput, 'target' | 'passphrase'>, createdAt: string) {
  const { db, dataDir, scope } = input
  const files: { path: string; bytes: Uint8Array }[] = []
  const collect = (rels: string[]) => {
    for (const rel of rels) {
      const bytes = readIfThere(join(dataDir, ...rel.split('/')))
      if (bytes) files.push({ path: rel, bytes })
    }
  }
  const found: string[] = []
  if (scope.kind === 'project') {
    if (
      !PROJECT_ID.test(scope.id) ||
      !db.query('select 1 from projects where id = ?').get(scope.id)
    ) {
      throw new BackupError('unknown-project', scope.id)
    }
    if (existsSync(join(dataDir, scope.id))) walk(dataDir, scope.id, found, new Set())
    collect(found)
    files.push({
      path: PROJECT_ROWS,
      bytes: new TextEncoder().encode(JSON.stringify(projectRows(db, scope.id))),
    })
  } else {
    walk(dataDir, '', found, new Set([...TOP_LEVEL_EXCLUDED, ...(input.exclude ?? [])]))
    collect(found)
    files.push({ path: DB_SNAPSHOT, bytes: snapshot(db) })
  }
  const manifest: BackupManifest = {
    format: FORMAT,
    createdAt,
    appVersion: input.appVersion,
    scope,
    files: files.map((f, i) => ({
      path: f.path,
      size: f.bytes.length,
      sha256: sha(f.bytes),
      entry: `d/${String(i + 1).padStart(6, '0')}`,
    })),
  }
  const entries = [
    { path: MANIFEST_ENTRY, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) },
    ...files.map((f, i) => ({ path: (manifest.files[i] as ManifestFile).entry, bytes: f.bytes })),
  ]
  return { manifest, entries, archive: writeArchive(entries) }
}

export async function createBackup(input: BackupInput): Promise<BackupResult> {
  const ms = (input.now ?? Date.now)()
  const createdAt = new Date(ms).toISOString()
  const { manifest, archive } = buildPayload(input, createdAt)
  const sealed = encrypt(archive, input.passphrase)
  const name = backupName(input.scope, ms)
  await input.target.put(name, sealed)
  // The sidecar says what the backup is without opening it. No file names: those stay inside.
  await input.target.put(
    `${name}.json`,
    new TextEncoder().encode(
      JSON.stringify({
        format: FORMAT,
        name,
        scope: input.scope,
        createdAt,
        appVersion: input.appVersion,
        files: manifest.files.length,
        size: sealed.length,
        sha256: sha(sealed),
      }),
    ),
  )
  return { name, size: sealed.length, files: manifest.files.length, createdAt }
}

// --- retention ----------------------------------------------------------------------------------

export type Retention = { keepLast?: number; keepDays?: number }

const NAME = /^ssb-(all|p-[a-z0-9]+)-(\d{8})T(\d{6})Z\.ssbak$/
function parsedTime(m: RegExpExecArray): number {
  const d = m[2] as string
  const t = m[3] as string
  return Date.parse(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`,
  )
}

/**
 * Keep the newest N per scope, or those from the last N days (both given: either keeps one).
 * The newest backup of a scope is never removed. Returns the names removed.
 */
export async function applyRetention(
  target: BackupTarget,
  rule: Retention,
  now: number = Date.now(),
): Promise<string[]> {
  const { keepLast, keepDays } = rule
  if (keepLast === undefined && keepDays === undefined) throw new BackupError('no-retention-rule')
  for (const n of [keepLast, keepDays]) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new BackupError('bad-retention')
  }
  const groups = new Map<string, { name: string; at: number }[]>()
  for (const f of await target.list()) {
    const m = NAME.exec(f.name)
    if (!m) continue
    const g = groups.get(m[1] as string) ?? []
    g.push({ name: f.name, at: parsedTime(m) })
    groups.set(m[1] as string, g)
  }
  const removed: string[] = []
  for (const g of groups.values()) {
    g.sort((a, b) => b.at - a.at)
    for (const [i, b] of g.entries()) {
      const keep =
        i === 0 ||
        (keepLast !== undefined && i < keepLast) ||
        (keepDays !== undefined && now - b.at <= keepDays * 86400_000)
      if (keep) continue
      await target.remove(b.name)
      await target.remove(`${b.name}.json`)
      removed.push(b.name)
    }
  }
  return removed.sort()
}

// --- restore ------------------------------------------------------------------------------------

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i

function safeRel(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 400) return false
  return path.split('/').every(
    (s) =>
      s.length > 0 &&
      s !== '.' &&
      s !== '..' &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
      !/[\\:*?"<>|\u0000-\u001f]/.test(s) &&
      !WINDOWS_DEVICE.test(s) &&
      !s.endsWith('.') &&
      !s.endsWith(' '),
  )
}

/** Windows can refuse a folder rename for a moment while a scanner holds a new file open. */
function renameDir(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (attempt >= 40 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw err
      Bun.sleepSync(25 + attempt * 10)
    }
  }
}

export type RestoreResult = { dir: string; manifest: BackupManifest; files: number }

/** Decrypt a sealed backup and check it end to end, without writing anything. */
export function openBackup(sealed: Uint8Array, passphrase: string) {
  return openArchive(decrypt(sealed, passphrase))
}

/** Check a decrypted archive against its manifest. Exposed so tests can feed a doctored one. */
export function openArchive(tar: Uint8Array) {
  const limits = { maxEntries: 2_000_000, maxFileBytes: 2 ** 31, maxTotalBytes: 2 ** 32 }
  let entries: ReturnType<typeof listArchive>
  try {
    entries = listArchive(tar, limits)
  } catch {
    throw new BackupError('corrupt', 'the archive structure is invalid')
  }
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const m = byPath.get(MANIFEST_ENTRY)
  if (!m) throw new BackupError('corrupt', 'no manifest')
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(tar.subarray(m.offset, m.offset + m.size)))
  } catch {
    throw new BackupError('corrupt', 'manifest')
  }
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.files)) {
    throw new BackupError('corrupt', 'manifest format')
  }
  const seenPaths = new Set<string>()
  const used = new Set<string>([MANIFEST_ENTRY])
  const out: { file: ManifestFile; bytes: Uint8Array }[] = []
  for (const f of manifest.files) {
    const e = byPath.get(f.entry)
    if (!e || used.has(f.entry)) throw new BackupError('corrupt', `missing data for ${f.path}`)
    used.add(f.entry)
    if (!safeRel(f.path)) throw new BackupError('corrupt', `unsafe path ${f.path}`)
    const folded = f.path.toLowerCase()
    if (seenPaths.has(folded)) throw new BackupError('corrupt', `duplicate path ${f.path}`)
    seenPaths.add(folded)
    const bytes = tar.subarray(e.offset, e.offset + e.size)
    if (e.size !== f.size || sha(bytes) !== f.sha256) {
      throw new BackupError('hash-mismatch', f.path)
    }
    out.push({ file: f, bytes })
  }
  if (used.size !== entries.length) throw new BackupError('corrupt', 'files not in the manifest')
  for (const f of manifest.files) {
    const parts = f.path.toLowerCase().split('/')
    for (let i = 1; i < parts.length; i++) {
      if (seenPaths.has(parts.slice(0, i).join('/'))) {
        throw new BackupError('corrupt', `path is both a file and a folder: ${f.path}`)
      }
    }
  }
  return { manifest, files: out }
}

/**
 * Restore into a NEW directory: decrypt, verify everything, write into a sibling temp folder,
 * then rename it into place. An existing destination is refused; nothing is ever overwritten.
 */
export async function restoreBackup(opts: {
  target: BackupTarget
  name: string
  passphrase: string
  destDir: string
}): Promise<RestoreResult> {
  const { destDir } = opts
  if (existsSync(destDir)) throw new BackupError('dest-exists', 'restore goes into a new folder')
  const { manifest, files } = openBackup(await opts.target.get(opts.name), opts.passphrase)
  const tmp = `${destDir}.restoring-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(destDir), { recursive: true })
    mkdirSync(tmp)
    for (const { file, bytes } of files) {
      writeNew(join(tmp, ...file.path.split('/')), bytes)
    }
    if (existsSync(destDir)) throw new BackupError('dest-exists', 'restore goes into a new folder')
    renameDir(tmp, destDir)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    throw err
  }
  return { dir: destDir, manifest, files: files.length }
}
