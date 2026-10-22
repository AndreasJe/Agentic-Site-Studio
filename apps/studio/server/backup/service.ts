// What the Admin sets for backups (plan §12.2) and how a run uses it. Settings live in the
// `settings` table (schedule keys from schedule.ts, plus the target and scope here). The
// passphrase is never stored: a manual run and a restore get it in the request, the timer gets it
// from the BACKUP_PASSPHRASE environment variable, and neither is ever logged or audited.
import type { Database } from 'bun:sqlite'
import { isAbsolute, relative, resolve } from 'node:path'
import { audit } from '../governance/audit.ts'
import { notify, resolve as resolveInbox } from '../release/inbox.ts'
import type { StoreContext } from '../store/revisions.ts'
import {
  applyRetention,
  type BackupResult,
  createBackup,
  restoreBackup,
  type Scope,
} from './backup.ts'
import { readSchedule, runIfDue, writeSchedule } from './schedule.ts'
import { BackupError, type BackupTarget, FolderTarget, RcloneTarget } from './target.ts'

export const APP_VERSION = '0.1.0'
const TARGET_KEY = 'backup_target'
const SCOPE_KEY = 'backup_scope'
const RESULT_KEY = 'backup_last_result'

export type TargetConfig = { kind: 'folder'; path: string } | { kind: 'rclone'; remote: string }

const read = (db: Database, key: string): string | null =>
  (db.query('select value from settings where key = ?').get(key) as { value: string } | null)
    ?.value ?? null
const write = (db: Database, key: string, value: string) =>
  db
    .query(
      'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
    )
    .run(key, value)
const json = <T>(raw: string | null): T | null => {
  try {
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export const readTarget = (db: Database) => json<TargetConfig>(read(db, TARGET_KEY))
export const readScope = (db: Database): Scope =>
  json<Scope>(read(db, SCOPE_KEY)) ?? { kind: 'all' }
export type LastResult =
  | { ok: true; at: string; name: string; size: number; files: number }
  | { ok: false; at: string; error: string }
export const readLastResult = (db: Database) => json<LastResult>(read(db, RESULT_KEY))

export const targetOf = (t: TargetConfig): BackupTarget =>
  t.kind === 'folder' ? new FolderTarget(t.path) : new RcloneTarget(t.remote)

/** True when `path` is `dir` or inside it. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export type BackupSettingsInput = {
  target?: unknown
  scope?: unknown
  intervalHours?: unknown
  keepLast?: unknown
  keepDays?: unknown
}

const count = (v: unknown, what: string, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max)
    throw new BackupError('bad-settings', `${what} is a whole number from 0 to ${max}.`)
  return v
}

/** Validates and stores. A target folder inside DATA_DIR is refused: a backup beside the data is no backup. */
export function saveBackupSettings(ctx: StoreContext, input: BackupSettingsInput): void {
  const { db } = ctx
  let target: TargetConfig | undefined
  if (input.target !== undefined) {
    const t = input.target as Record<string, unknown> | null
    if (t?.kind === 'folder') {
      const path = t.path
      if (typeof path !== 'string' || !path || path.length > 500 || path.includes('\0'))
        throw new BackupError('bad-settings', 'Enter the folder path.')
      if (!isAbsolute(path))
        throw new BackupError('bad-settings', 'The folder path must be absolute.')
      if (inside(ctx.dataDir, path))
        throw new BackupError('bad-settings', 'Choose a folder outside the data folder.')
      target = { kind: 'folder', path: resolve(path) }
    } else if (t?.kind === 'rclone') {
      const remote = t.remote
      if (typeof remote !== 'string' || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(remote))
        throw new BackupError('bad-settings', 'Enter the rclone remote name.')
      target = { kind: 'rclone', remote }
    } else throw new BackupError('bad-settings', 'The target is a folder or an rclone remote.')
  }
  let scope: Scope | undefined
  if (input.scope !== undefined) {
    const s = input.scope as Record<string, unknown> | null
    if (s?.kind === 'all') scope = { kind: 'all' }
    else if (s?.kind === 'project') {
      if (typeof s.id !== 'string' || !db.query('select 1 from projects where id = ?').get(s.id))
        throw new BackupError('unknown-project', 'No such project.')
      scope = { kind: 'project', id: s.id }
    } else throw new BackupError('bad-settings', 'The scope is the instance or one project.')
  }
  const sched: Parameters<typeof writeSchedule>[1] = {}
  if (input.intervalHours !== undefined)
    sched.intervalHours = count(input.intervalHours, 'The interval in hours', 24 * 366)
  if (input.keepLast !== undefined) sched.keepLast = count(input.keepLast, 'Keep last', 10_000)
  if (input.keepDays !== undefined) sched.keepDays = count(input.keepDays, 'Keep days', 36_500)
  db.transaction(() => {
    if (target) write(db, TARGET_KEY, JSON.stringify(target))
    if (scope) write(db, SCOPE_KEY, JSON.stringify(scope))
    writeSchedule(db, sched)
  })()
}

function record(ctx: StoreContext, r: LastResult) {
  write(ctx.db, RESULT_KEY, JSON.stringify(r))
  if (r.ok) resolveInbox(ctx, 'backup-failed', 'backup')
  else notify(ctx, 'backup-failed', 'backup', `Backup failed: ${r.error}`.slice(0, 300))
}

const failure = (e: unknown): string =>
  e instanceof BackupError ? e.code : (e as Error).message.slice(0, 200)

/** Run now, with the saved target and scope. Records the result; failures reach the inbox. */
export async function runBackupNow(
  ctx: StoreContext,
  passphrase: string,
  who: string,
  now: () => number = Date.now,
): Promise<BackupResult> {
  const target = readTarget(ctx.db)
  if (!target) throw new BackupError('no-target', 'Set a backup target first.')
  const store = targetOf(target)
  try {
    const result = await createBackup({
      db: ctx.db,
      dataDir: ctx.dataDir,
      passphrase,
      scope: readScope(ctx.db),
      target: store,
      appVersion: APP_VERSION,
      now,
    })
    writeSchedule(ctx.db, { lastRun: result.createdAt })
    const s = readSchedule(ctx.db)
    if (s.keepLast !== undefined || s.keepDays !== undefined)
      await applyRetention(store, { keepLast: s.keepLast, keepDays: s.keepDays }, now())
    record(ctx, { ok: true, at: result.createdAt, ...pick(result) })
    audit(ctx, who, 'backup.run', { name: result.name, size: result.size })
    return result
  } catch (e) {
    // Not a failure of the backup itself: the Admin sent something wrong, so no inbox item.
    if (!(e instanceof BackupError && e.code === 'weak-passphrase'))
      record(ctx, { ok: false, at: new Date(now()).toISOString(), error: failure(e) })
    throw e
  }
}
const pick = (r: BackupResult) => ({ name: r.name, size: r.size, files: r.files })

/** Restore into a NEW folder outside the data folder. The passphrase is used once and dropped. */
export async function restoreInto(
  ctx: StoreContext,
  input: { name: string; passphrase: string; destDir: string },
  who: string,
) {
  const target = readTarget(ctx.db)
  if (!target) throw new BackupError('no-target', 'Set a backup target first.')
  if (!isAbsolute(input.destDir) || input.destDir.includes('\0'))
    throw new BackupError('bad-settings', 'The new folder must be an absolute path.')
  if (inside(ctx.dataDir, input.destDir))
    throw new BackupError('bad-settings', 'Restore into a new folder outside the data folder.')
  const r = await restoreBackup({
    target: targetOf(target),
    name: input.name,
    passphrase: input.passphrase,
    destDir: resolve(input.destDir),
  })
  audit(ctx, who, 'backup.restored', { name: input.name, files: r.files })
  return r
}

/**
 * One tick of the timer: a backup if one is due. Only runs with a target set, a schedule and a
 * passphrase from the environment; otherwise it does nothing.
 */
export async function scheduledTick(
  ctx: StoreContext,
  passphrase: string | undefined,
  now: () => number = Date.now,
): Promise<BackupResult | null> {
  const target = readTarget(ctx.db)
  if (!target || !passphrase || !readSchedule(ctx.db).intervalHours) return null
  try {
    const r = await runIfDue({
      db: ctx.db,
      dataDir: ctx.dataDir,
      passphrase,
      scope: readScope(ctx.db),
      target: targetOf(target),
      appVersion: APP_VERSION,
      now,
    })
    if (r) record(ctx, { ok: true, at: r.createdAt, ...pick(r) })
    return r
  } catch (e) {
    record(ctx, { ok: false, at: new Date(now()).toISOString(), error: failure(e) })
    return null
  }
}
