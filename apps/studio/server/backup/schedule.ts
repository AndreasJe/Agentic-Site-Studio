// When a backup is due (plan §12.2). No timer lives here: the caller asks `isDue` with a clock
// and runs `runIfDue` from its own tick, so tests use a fake clock. Settings live in the existing
// `settings` table as plain key/value rows; the Admin screens that edit them come later.
import type { Database } from 'bun:sqlite'
import { applyRetention, type BackupInput, type BackupResult, createBackup } from './backup.ts'

export const SETTING_KEYS = {
  intervalHours: 'backup_interval_hours', // 0 or missing: off
  lastRun: 'backup_last_run', // ISO time of the last successful run
  keepLast: 'backup_keep_last',
  keepDays: 'backup_keep_days',
} as const

function read(db: Database, key: string): string | null {
  const r = db.query('select value from settings where key = ?').get(key) as {
    value: string
  } | null
  return r?.value ?? null
}
function write(db: Database, key: string, value: string) {
  db.query(
    'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  ).run(key, value)
}
const num = (v: string | null) => {
  const n = v === null ? Number.NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export type Schedule = {
  intervalHours: number | undefined
  lastRun: string | null
  keepLast: number | undefined
  keepDays: number | undefined
}

export function readSchedule(db: Database): Schedule {
  return {
    intervalHours: num(read(db, SETTING_KEYS.intervalHours)),
    lastRun: read(db, SETTING_KEYS.lastRun),
    keepLast: num(read(db, SETTING_KEYS.keepLast)),
    keepDays: num(read(db, SETTING_KEYS.keepDays)),
  }
}

export function writeSchedule(db: Database, s: Partial<Schedule>) {
  for (const [field, key] of [
    ['intervalHours', SETTING_KEYS.intervalHours],
    ['lastRun', SETTING_KEYS.lastRun],
    ['keepLast', SETTING_KEYS.keepLast],
    ['keepDays', SETTING_KEYS.keepDays],
  ] as const) {
    const v = s[field]
    if (v !== undefined && v !== null) write(db, key, String(v))
  }
}

/** Due when there is an interval and no run yet, or the last run is at least one interval old. */
export function isDue(lastRun: string | null, intervalHours: number | undefined, now: number) {
  if (!intervalHours || intervalHours <= 0) return false
  if (!lastRun) return true
  const last = Date.parse(lastRun)
  if (Number.isNaN(last)) return true
  return now - last >= intervalHours * 3600_000
}

/** Run a backup if one is due, record it, then prune. Returns null when nothing was due. */
export async function runIfDue(
  input: Omit<BackupInput, 'now'> & { now: () => number },
): Promise<BackupResult | null> {
  const s = readSchedule(input.db)
  if (!isDue(s.lastRun, s.intervalHours, input.now())) return null
  const result = await createBackup(input)
  write(input.db, SETTING_KEYS.lastRun, result.createdAt)
  if (s.keepLast !== undefined || s.keepDays !== undefined) {
    await applyRetention(input.target, { keepLast: s.keepLast, keepDays: s.keepDays }, input.now())
  }
  return result
}
