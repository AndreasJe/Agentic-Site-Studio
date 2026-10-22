// Check settings (Admin), check runs, staging and publication requests (M6.3 to M6.6; plan §13.2,
// §13.3, §16.5). Members only on the project routes; Admin only on the settings routes.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ALL_CHECKS,
  FAILURE_ANALYSIS,
  FAILURE_ANALYSIS_KEY,
  type FailureAnalysis,
  failureAnalysis,
  guards,
  isFloor,
  LEVELS,
  type Level,
  levels,
  type Preview,
  queueRerun,
  type RunRow,
  readResults,
  runsOn,
} from '../checks/checks.ts'
import { audit as auditLog } from '../governance/audit.ts'
import { beginStepUp, finishStepUp } from '../governance/stepup.ts'
import { signStagingLink } from '../preview/review-link.ts'
import { notify } from '../release/inbox.ts'
import type { WebAuthnDeps } from '../release/signing.ts'
import type { StoreContext } from '../store/revisions.ts'
import { canSee } from './access.ts'
import type { AppEnv } from './projects.ts'
import { mayApprove } from './review.ts'

type Json = Record<string, unknown>
const NOTE_MAX = 2000

export function checksRoutes(
  app: Hono<AppEnv>,
  ctx: StoreContext,
  preview?: Preview,
  webauthn?: WebAuthnDeps,
) {
  const { db } = ctx
  app.use(
    '/api/admin/checks/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )
  app.use(
    '/api/p/:project/staging/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  const parse = (r: RunRow | null) => (r?.result_json ? (JSON.parse(r.result_json) as Json) : null)
  const summary = (r: RunRow) => {
    const result = parse(r)
    const checks = Array.isArray(result?.checks)
      ? (result.checks as { id: string; status: string }[])
      : []
    return {
      id: r.id,
      rev: r.rev,
      hash: r.hash,
      kind: r.kind,
      status: r.status,
      blocked: !!r.blocked,
      error: r.error,
      rerunOf: r.rerun_of,
      at: r.at,
      checks: checks.map((c) => ({ id: c.id, status: c.status })),
    }
  }
  const audit = (who: string, id: string, from: string, to: string) =>
    db
      .query(
        'insert into check_audit (who, at, check_id, from_level, to_level) values (?, ?, ?, ?, ?)',
      )
      .run(who, new Date().toISOString(), id, from, to)

  // ---- settings (Admin only) --------------------------------------------------------------
  const adminOnly = (c: Context<AppEnv>) =>
    c.get('user').role === 'admin' ? null : c.json({ code: 'forbidden' }, 403)

  app.get('/api/admin/checks', (c) => {
    const no = adminOnly(c)
    if (no) return no
    readResults(ctx, preview)
    const lv = levels(ctx)
    // The last result per check: the newest finished run of the kind that runs it.
    const last = (kind: 'package' | 'smoke') =>
      db
        .query(
          "select * from check_runs where status = 'done' and kind = ? order by at desc, rowid desc limit 1",
        )
        .get(kind) as RunRow | null
    const status: Record<string, { status: string; at: string; run: string }> = {}
    for (const run of [last('package'), last('smoke')]) {
      const checks = (parse(run)?.checks ?? []) as { id: string; status: string }[]
      for (const ch of checks)
        if (run) status[ch.id] = { status: ch.status, at: run.at, run: run.id }
    }
    return c.json({
      checks: ALL_CHECKS.map((id) => ({
        id,
        floor: isFloor(id),
        level: lv[id],
        guards: guards(id),
        runsOn: runsOn(id),
        last: status[id] ?? null,
      })),
      failureAnalysis: failureAnalysis(ctx),
    })
  })

  app.put('/api/admin/checks/failure-analysis', async (c) => {
    const no = adminOnly(c)
    if (no) return no
    const body = (await c.req.json().catch(() => ({}))) as Json
    const value = body.value as FailureAnalysis
    if (!FAILURE_ANALYSIS.includes(value)) return c.json({ code: 'bad-value' }, 400)
    const from = failureAnalysis(ctx)
    db.transaction(() => {
      db.query(
        'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
      ).run(FAILURE_ANALYSIS_KEY, value)
      if (from !== value) audit(c.get('user').handle, 'failure-analysis', from, value)
    })()
    return c.json({ failureAnalysis: value })
  })

  app.put('/api/admin/checks/:id', async (c) => {
    const no = adminOnly(c)
    if (no) return no
    const id = c.req.param('id')
    if (!ALL_CHECKS.includes(id)) return c.json({ code: 'not-found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Json
    const level = body.level as Level
    if (!LEVELS.includes(level)) return c.json({ code: 'bad-level' }, 400)
    // A floor check stays on block: the server refuses, the worker ignores (plan §16.5).
    if (isFloor(id) && level !== 'block')
      return c.json({ code: 'cant-be-lowered', message: "can't be lowered" }, 409)
    const from = levels(ctx)[id] as Level
    const user = c.get('user')
    // Lowering a check needs a fresh passkey assertion for exactly this change (M7 step-up;
    // decision #48). Without one, the answer is the challenge to sign.
    if (LEVELS.indexOf(level) < LEVELS.indexOf(from)) {
      if (!webauthn) return c.json({ code: 'step-up-unavailable' }, 503)
      const change = { action: 'check-level', check: id, from, to: level }
      if (body.stepUp === undefined) {
        const stepUp = await beginStepUp(ctx, webauthn, user, change)
        return c.json({ code: 'step-up-required', stepUp }, 428)
      }
      const ok = await finishStepUp(ctx, webauthn, user, change, body.stepUp)
      if (!ok.ok) return c.json({ code: ok.code }, 403)
    }
    if (from !== level)
      db.transaction(() => {
        db.query(
          `insert into check_settings (check_id, level, updated_by, updated_at) values (?, ?, ?, ?)
           on conflict (check_id) do update set level = excluded.level,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).run(id, level, user.handle, new Date().toISOString())
        audit(user.handle, id, from, level)
        auditLog(ctx, user.handle, 'check-level', { check: id, from, to: level })
      })()
    return c.json({ id, level, floor: isFloor(id) })
  })

  // ---- check runs (members) ---------------------------------------------------------------
  const member = (c: Context<AppEnv>) => {
    const project = c.req.param('project') ?? ''
    return canSee(ctx, c.get('user'), project) ? project : null
  }

  app.get('/api/p/:project/checks/runs', (c) => {
    const project = member(c)
    if (!project) return c.json({ code: 'not-found' }, 404)
    readResults(ctx, preview)
    const rows = db
      .query('select * from check_runs where project_id = ? order by at desc, rowid desc')
      .all(project) as RunRow[]
    return c.json({ runs: rows.map(summary) })
  })

  const runOf = (project: string, id: string) =>
    db
      .query('select * from check_runs where id = ? and project_id = ?')
      .get(id, project) as RunRow | null

  app.get('/api/p/:project/checks/runs/:id', (c) => {
    const project = member(c)
    if (!project) return c.json({ code: 'not-found' }, 404)
    readResults(ctx, preview)
    const run = runOf(project, c.req.param('id'))
    if (!run) return c.json({ code: 'not-found' }, 404)
    return c.json({ run: { ...summary(run), result: parse(run) } })
  })

  app.post('/api/p/:project/checks/runs/:id/rerun', (c) => {
    const project = member(c)
    if (!project) return c.json({ code: 'not-found' }, 404)
    readResults(ctx, preview)
    const run = runOf(project, c.req.param('id'))
    if (!run) return c.json({ code: 'not-found' }, 404)
    if (!mayApprove(c.get('user'))) return c.json({ code: 'forbidden' }, 403)
    if (run.status !== 'done') return c.json({ code: 'not-finished' }, 409)
    // Once per run, and a rerun is not itself rerun: a flaky check gets a second look, no more.
    const done = db.query('select 1 from check_runs where rerun_of = ?').get(run.id)
    if (done || run.rerun_of) return c.json({ code: 'already-rerun' }, 409)
    const id = queueRerun(ctx, run)
    if (!id) return c.json({ code: 'not-found' }, 404)
    return c.json({ run: summary(runOf(project, id) as RunRow) }, 201)
  })

  // ---- staging and publication requests ---------------------------------------------------
  const requestsOf = (project: string) =>
    db
      .query(
        `select r.id, r.rev, r.hash, r.note, r.at, r.status, u.handle as "by"
         from publication_requests r join users u on u.id = r.user_id
         where r.project_id = ? order by r.id desc`,
      )
      .all(project)

  app.get('/api/p/:project/staging', (c) => {
    const project = member(c)
    if (!project) return c.json({ code: 'not-found' }, 404)
    readResults(ctx, preview)
    const staged = db
      .query('select rev, hash, at from staged where project_id = ?')
      .get(project) as { rev: string; hash: string; at: string } | null
    const smokeRow = staged
      ? (db
          .query(
            "select * from check_runs where project_id = ? and kind = 'smoke' and hash = ? order by at desc, rowid desc limit 1",
          )
          .get(project, staged.hash) as RunRow | null)
      : null
    const body = {
      staged,
      url: null as string | null,
      smoke: smokeRow ? { ...summary(smokeRow), result: parse(smokeRow) } : null,
      requests: requestsOf(project),
    }
    if (staged && !preview) return c.json({ ...body, code: 'no-preview' }, 503)
    if (staged && preview) {
      const path = signStagingLink(preview.secret, { project, ...staged })
      body.url = new URL(path, preview.url).href
    }
    return c.json(body)
  })

  app.post('/api/p/:project/staging/request', async (c) => {
    const project = member(c)
    if (!project) return c.json({ code: 'not-found' }, 404)
    const user = c.get('user')
    if (!mayApprove(user)) return c.json({ code: 'forbidden' }, 403)
    readResults(ctx, preview)
    const body = (await c.req.json().catch(() => ({}))) as Json
    // Plain text, stored as it is and never rendered as HTML.
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (note.length < 1) return c.json({ code: 'note-required' }, 400)
    if (note.length > NOTE_MAX) return c.json({ code: 'note-too-long' }, 400)
    const id = db.transaction(() => {
      const staged = db.query('select rev, hash from staged where project_id = ?').get(project) as {
        rev: string
        hash: string
      } | null
      if (!staged) return null
      db.query(
        "update publication_requests set status = 'superseded' where project_id = ? and status = 'open'",
      ).run(project)
      return (
        db
          .query(
            'insert into publication_requests (project_id, rev, hash, note, user_id, at, status) values (?, ?, ?, ?, ?, ?, ?) returning id',
          )
          .get(
            project,
            staged.rev,
            staged.hash,
            note,
            user.id,
            new Date().toISOString(),
            'open',
          ) as {
          id: number
        }
      ).id
    })()
    if (id === null) return c.json({ code: 'nothing-staged' }, 409)
    // Plan §13.3 step 5: the Admins see it in "Waiting for you" (mail is the deployment side's).
    notify(ctx, 'publication-request', `request:${id}`, `${user.name} asks to publish ${project}`)
    return c.json({ requests: requestsOf(project) }, 201)
  })
}
