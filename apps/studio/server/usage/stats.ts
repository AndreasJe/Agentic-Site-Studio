// Usage statistics and retention (plan §15; decisions #18, #22; M8.2). Statistics read the
// `usage` rows plus `usage_daily`, where per-person rows end up after the retention period as
// per-project daily totals. Per-person figures exist only while the per-person rows do.
import type { Database } from 'bun:sqlite'

export const RETENTION_KEY = 'usage_retention_days'
export const DEFAULT_RETENTION_DAYS = 90
const DAY = 86400_000

export type Totals = {
  calls: number
  attempts: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}
const zero = (): Totals => ({
  calls: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
})
const add = (a: Totals, b: Totals) => {
  a.calls += b.calls
  a.attempts += b.attempts
  a.inputTokens += b.inputTokens
  a.outputTokens += b.outputTokens
  a.cachedTokens += b.cachedTokens
}

type Cell = Totals & { day: string; project: string; phase: string; role: string }

export type Filter = { project?: string; user?: string; from?: string; to?: string }

export type Stats = {
  totals: Totals
  byPhase: ({ phase: string } & Totals)[]
  byRole: ({ role: string } & Totals)[]
  byDay: ({ day: string } & Totals)[]
  byProject: ({ project: string } & Totals)[]
}

type Raw = {
  day: string
  project: string
  phase: string
  role: string
  calls: number
  attempts: number
  input: number
  output: number
  cached: number
}

function cells(db: Database, f: Filter): Cell[] {
  const where: string[] = []
  const args: Record<string, string> = {}
  if (f.project !== undefined) {
    where.push('project = :project')
    args.project = f.project
  }
  if (f.from) {
    where.push('day >= :from')
    args.from = f.from
  }
  if (f.to) {
    where.push('day <= :to')
    args.to = f.to
  }
  const cond = (extra: string[]) => {
    const all = [...extra]
    return all.length ? `where ${all.join(' and ')}` : ''
  }
  const live = `
    select substr(at, 1, 10) as day, coalesce(project, '') as project, coalesce(phase, '') as phase,
      coalesce(model_role, '') as role, count(distinct call_id) as calls, count(*) as attempts,
      coalesce(sum(input_tokens), 0) as input, coalesce(sum(output_tokens), 0) as output,
      coalesce(sum(cached_tokens), 0) as cached
    from usage
    ${f.user !== undefined ? 'where user = :user' : ''}
    group by 1, 2, 3, 4`
  // Per-person figures only exist in the live rows; the daily totals have no person.
  const daily = `
    select day, project, phase, role, calls, attempts, input_tokens as input,
      output_tokens as output, cached_tokens as cached
    from usage_daily`
  const sql = `select * from (${live}${f.user === undefined ? ` union all ${daily}` : ''}) ${cond(where)}`
  if (f.user !== undefined) args.user = f.user
  const rows = db.query(sql).all(args) as Raw[]
  return rows.map((r) => ({
    day: r.day,
    project: r.project,
    phase: r.phase,
    role: r.role,
    calls: r.calls,
    attempts: r.attempts,
    inputTokens: r.input,
    outputTokens: r.output,
    cachedTokens: r.cached,
  }))
}

function group<K extends 'phase' | 'role' | 'day' | 'project'>(cs: Cell[], key: K) {
  const m = new Map<string, Totals>()
  for (const c of cs) {
    const t = m.get(c[key]) ?? zero()
    add(t, c)
    m.set(c[key], t)
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, t]) => ({ [key]: k, ...t }) as { [P in K]: string } & Totals)
}

export function usageStats(db: Database, f: Filter = {}): Stats {
  const cs = cells(db, f)
  const totals = zero()
  for (const c of cs) add(totals, c)
  return {
    totals,
    byPhase: group(cs, 'phase'),
    byRole: group(cs, 'role'),
    byDay: group(cs, 'day'),
    byProject: group(cs, 'project'),
  }
}

// --- retention ---------------------------------------------------------------------------------

export function retentionDays(db: Database): number {
  const r = db.query('select value from settings where key = ?').get(RETENTION_KEY) as {
    value: string
  } | null
  const n = r ? Number(r.value) : Number.NaN
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_RETENTION_DAYS
}

export function setRetentionDays(db: Database, days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new RangeError('Retention is a whole number of days from 1 to 3650.')
  db.query(
    'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  ).run(RETENTION_KEY, String(days))
}

export type RetentionResult = { deleted: number; days: number; cutoff: string }

/**
 * Per-person rows (those with a user) older than N days are added to per-project daily totals,
 * then deleted, in one transaction: the totals never change, only the person disappears.
 * `now` is injectable so tests can move the clock.
 */
export function applyUsageRetention(
  db: Database,
  now: () => number = Date.now,
  days = retentionDays(db),
): RetentionResult {
  const cutoff = new Date(now() - days * DAY).toISOString()
  let deleted = 0
  db.transaction(() => {
    db.query(
      `insert into usage_daily (day, project, phase, role, calls, attempts, input_tokens, output_tokens, cached_tokens)
       select substr(at, 1, 10), coalesce(project, ''), coalesce(phase, ''), coalesce(model_role, ''),
         count(distinct call_id), count(*), coalesce(sum(input_tokens), 0),
         coalesce(sum(output_tokens), 0), coalesce(sum(cached_tokens), 0)
       from usage where user is not null and at < ?
       group by 1, 2, 3, 4
       on conflict (day, project, phase, role) do update set
         calls = calls + excluded.calls, attempts = attempts + excluded.attempts,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cached_tokens = cached_tokens + excluded.cached_tokens`,
    ).run(cutoff)
    deleted = db.query('delete from usage where user is not null and at < ?').run(cutoff).changes
  })()
  return { deleted, days, cutoff }
}
