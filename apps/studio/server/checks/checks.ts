// Checks, staging and publication requests, app side (M6.3 to M6.6; docs/m6-interfaces.md).
// The app writes a job file, the worker (apps/worker/, Node) writes a result file; this module
// reads results when asked, never on a timer. The AI has no part in any of it.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { currentNumber, readGuide } from '../brand/guide.ts'
import { signStagingLink } from '../preview/review-link.ts'
import { getPackage } from '../review/package.ts'
import { writeReplace } from '../store/atomic.ts'
import { currentRevision, projectDir, type StoreContext } from '../store/revisions.ts'

export type Preview = { secret: string; url: URL }
export type Level = 'off' | 'warn' | 'block'
export const LEVELS: Level[] = ['off', 'warn', 'block']

/** The same ids as apps/worker/src/settings.js. */
export const FLOOR_CHECKS = [
  'html',
  'links',
  'csp',
  'inline-code',
  'validators',
  'svg',
  'pinned',
  'secrets',
]
export const ADVISORY_CHECKS = [
  'axe',
  'heavy-profile',
  'csp-console',
  'visual',
  'navigation',
  'seo',
  'performance',
]
export const ALL_CHECKS = [...FLOOR_CHECKS, ...ADVISORY_CHECKS, 'smoke']
export const isFloor = (id: string) => FLOOR_CHECKS.includes(id)

/** Short text keys; the client translates them. All checks run in the worker, some with a browser. */
const BROWSER = new Set(['axe', 'heavy-profile', 'csp-console', 'visual', 'navigation', 'smoke'])
export const guards = (id: string) => `checks.guards.${id}`
export const runsOn = (id: string) => (BROWSER.has(id) ? 'worker-browser' : 'worker')

export type FailureAnalysis = 'off' | 'analyse' | 'analyse-and-fix'
export const FAILURE_ANALYSIS: FailureAnalysis[] = ['off', 'analyse', 'analyse-and-fix']
export const FAILURE_ANALYSIS_KEY = 'failure_analysis'

export function failureAnalysis(ctx: StoreContext): FailureAnalysis {
  const v = (
    ctx.db.query('select value from settings where key = ?').get(FAILURE_ANALYSIS_KEY) as {
      value: string
    } | null
  )?.value
  return FAILURE_ANALYSIS.includes(v as FailureAnalysis)
    ? (v as FailureAnalysis)
    : 'analyse-and-fix'
}

/** Every check's level; floor checks are always block, whatever the table says. */
export function levels(ctx: StoreContext): Record<string, Level> {
  const rows = ctx.db.query('select check_id, level from check_settings').all() as {
    check_id: string
    level: Level
  }[]
  const out: Record<string, Level> = Object.fromEntries(ALL_CHECKS.map((id) => [id, 'block']))
  for (const r of rows)
    if (ALL_CHECKS.includes(r.check_id) && !isFloor(r.check_id)) out[r.check_id] = r.level
  return out
}

const checksDir = (ctx: StoreContext) => join(ctx.dataDir, 'checks')
const revNumber = (r: string | null | undefined) => Number(/-r(\d+)$/.exec(r ?? '')?.[1] ?? 0)

function writeJob(ctx: StoreContext, job: { id: string }) {
  for (const d of ['pending', 'running', 'results'])
    mkdirSync(join(checksDir(ctx), d), { recursive: true })
  // temp file, then rename (the worker only picks up *.json)
  writeReplace(
    join(checksDir(ctx), 'pending', `${job.id}.json`),
    new TextEncoder().encode(JSON.stringify(job)),
  )
}

/** The archive blob's file path: <projectDir>/blobs/sha256/<2>/<62>. */
export function archivePathOf(ctx: StoreContext, project: string, archive: string): string {
  const h = archive.replace(/^sha256:/, '')
  return resolve(projectDir(ctx.dataDir, project), 'blobs', 'sha256', h.slice(0, 2), h.slice(2))
}

export type RunRow = {
  id: string
  project_id: string
  rev: string
  hash: string
  kind: 'package' | 'smoke'
  status: 'queued' | 'running' | 'done'
  blocked: number
  result_json: string | null
  error: string | null
  rerun_of: string | null
  at: string
}

function enqueue(
  ctx: StoreContext,
  project: string,
  rev: string,
  hash: string,
  kind: 'package' | 'smoke',
  extra: { smokeUrl?: string; rerunOf?: string } = {},
): string | null {
  const pkg = getPackage(ctx, project, rev)
  if (!pkg) return null
  const id = randomUUID()
  const acceptances = ctx.db
    .query('select rule, target from a11y_acceptances where project_id = ? and rev = ? order by id')
    .all(project, rev) as { rule: string; target: string }[]
  const staged = ctx.db.query('select rev from staged where project_id = ?').get(project) as {
    rev: string
  } | null
  const base = staged ? getPackage(ctx, project, staged.rev) : null
  const job = {
    id,
    kind,
    project,
    rev,
    archivePath: archivePathOf(ctx, project, pkg.archive),
    hash,
    settings: levels(ctx),
    acceptances,
    guide: readGuide(ctx.dataDir, currentNumber(ctx.db)) ?? {},
    pinned: [] as { path: string; sha256: string }[],
    ...(base ? { baselineArchivePath: archivePathOf(ctx, project, base.archive) } : {}),
    ...(extra.smokeUrl ? { smokeUrl: extra.smokeUrl } : {}),
  }
  ctx.db
    .query(
      'insert into check_runs (id, project_id, rev, hash, kind, status, rerun_of, at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, project, rev, hash, kind, 'queued', extra.rerunOf ?? null, new Date().toISOString())
  writeJob(ctx, job)
  return id
}

/** Approving a revision queues its package check (M6.5). Returns the run id. */
export function queuePackageCheck(
  ctx: StoreContext,
  project: string,
  rev: string,
  hash: string,
): string | null {
  return enqueue(ctx, project, rev, hash, 'package')
}

/** An unchanged rerun of the same package (a flaky check). */
export function queueRerun(ctx: StoreContext, run: RunRow): string | null {
  return enqueue(ctx, run.project_id, run.rev, run.hash, run.kind, { rerunOf: run.id })
}

type Result = {
  kind?: unknown
  hash?: unknown
  hashOk?: unknown
  blocked?: unknown
  error?: unknown
  checks?: { id: string; status: string }[]
}

function floorsPassed(r: Result): boolean {
  const checks = Array.isArray(r.checks) ? r.checks : []
  return FLOOR_CHECKS.every((id) => checks.find((c) => c.id === id)?.status === 'pass')
}

/** Only the newest revision, and never an older one over a newer. Returns whether it staged. */
function stage(ctx: StoreContext, run: RunRow): boolean {
  if (currentRevision(ctx.dataDir, run.project_id) !== run.rev) return false
  const have = ctx.db.query('select rev from staged where project_id = ?').get(run.project_id) as {
    rev: string
  } | null
  if (have && revNumber(have.rev) > revNumber(run.rev)) return false
  ctx.db
    .query(
      `insert into staged (project_id, rev, hash, at) values (?, ?, ?, ?)
       on conflict (project_id) do update set rev = excluded.rev, hash = excluded.hash, at = excluded.at`,
    )
    .run(run.project_id, run.rev, run.hash, new Date().toISOString())
  return true
}

/** Scan checks/results/ for runs not done yet and fold the results in. No polling thread. */
export function readResults(ctx: StoreContext, preview?: Preview) {
  const open = ctx.db
    .query("select * from check_runs where status <> 'done' order by at")
    .all() as RunRow[]
  const dir = checksDir(ctx)
  for (const run of open) {
    const file = join(dir, 'results', `${run.id}.json`)
    if (!existsSync(file)) {
      if (run.status === 'queued' && existsSync(join(dir, 'running', `${run.id}.json`)))
        ctx.db.query("update check_runs set status = 'running' where id = ?").run(run.id)
      continue
    }
    let result: Result
    try {
      result = JSON.parse(readFileSync(file, 'utf8')) as Result
    } catch {
      continue // unreadable for now; look again next time
    }
    let blocked = result.blocked !== false
    let error: string | null = null
    if (result.hash !== run.hash) {
      // The result must be about the package we asked about.
      blocked = true
      error = 'hash-mismatch'
    } else if (result.hashOk !== true) {
      blocked = true
      error = typeof result.error === 'string' ? result.error : 'hash-not-ok'
    }
    ctx.db
      .query(
        "update check_runs set status = 'done', blocked = ?, result_json = ?, error = ? where id = ?",
      )
      .run(blocked ? 1 : 0, JSON.stringify(result), error, run.id)
    if (run.kind === 'package' && !blocked && floorsPassed(result) && stage(ctx, run) && preview) {
      const path = signStagingLink(preview.secret, {
        project: run.project_id,
        rev: run.rev,
        hash: run.hash,
      })
      enqueue(ctx, run.project_id, run.rev, run.hash, 'smoke', {
        smokeUrl: new URL(path, preview.url).href,
      })
    }
  }
}
