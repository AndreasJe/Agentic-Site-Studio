// Failed runs and the analyst (Admin only; M6.7). The analyst proposes; "send fix" applies the
// patch as a take and never makes a revision; "hold" records a person's comment.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  AnalystError,
  analyse,
  analysisView,
  failedChecks,
  floorFailed,
  hold,
  isFailed,
  latestAnalysis,
  resultOf,
  runById,
  sendFix,
} from '../checks/analyst.ts'
import { type Preview, type RunRow, readResults } from '../checks/checks.ts'
import { DesignError } from '../design/design.ts'
import type { Endpoint } from '../llm/llm.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

const COMMENT_MAX = 2000

export function failureRoutes(
  app: Hono<AppEnv>,
  ctx: StoreContext,
  endpoint?: Endpoint,
  preview?: Preview,
) {
  const { db } = ctx
  app.use(
    '/api/admin/failures/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  // Admin only; everyone else gets a plain 403 as on the other admin routes.
  const guarded =
    (fn: (c: Context<AppEnv>, run: RunRow) => Promise<Response> | Response) =>
    async (c: Context<AppEnv>) => {
      if (c.get('user').role !== 'admin') return c.json({ code: 'forbidden' }, 403)
      readResults(ctx, preview)
      const run = runById(ctx, c.req.param('runId') ?? '')
      if (!run || !isFailed(run)) return c.json({ code: 'not-found' }, 404)
      try {
        return await fn(c, run)
      } catch (err) {
        if (err instanceof AnalystError) return c.json({ code: err.code }, err.status)
        if (err instanceof DesignError) return c.json({ code: err.code, ...err.extra }, err.status)
        throw err
      }
    }

  const detail = (run: RunRow) => ({
    run: {
      id: run.id,
      project: run.project_id,
      rev: run.rev,
      hash: run.hash,
      result: resultOf(run),
    },
    analysis: analysisView(latestAnalysis(ctx, run.id)),
    floorFailed: floorFailed(run),
  })

  app.get('/api/admin/failures', (c) => {
    if (c.get('user').role !== 'admin') return c.json({ code: 'forbidden' }, 403)
    readResults(ctx, preview)
    const rows = db
      .query("select * from check_runs where status = 'done' order by at desc, rowid desc")
      .all() as RunRow[]
    return c.json({
      failures: rows.filter(isFailed).map((r) => {
        const a = latestAnalysis(ctx, r.id)
        return {
          id: r.id,
          project: r.project_id,
          rev: r.rev,
          hash: r.hash,
          kind: r.kind,
          at: r.at,
          failedChecks: failedChecks(r).map((x) => x.id),
          floorFailed: floorFailed(r),
          analysis: a ? { status: a.status, recommendation: a.recommendation } : null,
        }
      }),
    })
  })

  app.get(
    '/api/admin/failures/:runId',
    guarded((c, run) => c.json(detail(run))),
  )

  app.post(
    '/api/admin/failures/:runId/analyse',
    guarded(async (c, run) => {
      try {
        await analyse(ctx, endpoint, run, c.get('user').handle, c.req.raw.signal)
      } catch (err) {
        if (err instanceof AnalystError && err.code === 'ai-failed')
          return c.json({ code: err.code }, 502)
        throw err
      }
      return c.json(detail(run))
    }),
  )

  app.post(
    '/api/admin/failures/:runId/send-fix',
    guarded(async (c, run) => {
      await sendFix(ctx, run, c.get('user').handle)
      return c.json(detail(run))
    }),
  )

  app.post(
    '/api/admin/failures/:runId/hold',
    guarded(async (c, run) => {
      const body = (await c.req.json().catch(() => ({}))) as { comment?: unknown }
      // Plain text, stored as it is and never rendered as HTML.
      const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
      if (comment.length < 1) return c.json({ code: 'comment-required' }, 400)
      if (comment.length > COMMENT_MAX) return c.json({ code: 'comment-too-long' }, 400)
      hold(ctx, run, comment, c.get('user').handle)
      return c.json(detail(run))
    }),
  )
}
