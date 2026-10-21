// Design routes (plan §6; decision #45): artboards, roles, sections and deviations of a project.
// Design state is project-level in SQLite; members only (access.ts), everything else is a 404.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  type Axis,
  applyTake,
  estimateTake,
  fixDeviation,
  generateTake,
  getTake,
  takeView,
} from '../design/ai.ts'
import {
  type ArtboardRow,
  applyHtml,
  approveSection,
  artboardDetail,
  artboardSummary,
  artboardsOfPage,
  createArtboard,
  DesignError,
  deviationOutcome,
  getArtboard,
  type Level,
  presence,
  type Role,
  setCheck,
  setRole,
  unlockSection,
} from '../design/design.ts'
import { proposeToGuide } from '../design/proposals.ts'
import { type Endpoint, LlmHttpError } from '../llm/llm.ts'
import { signArtboardLink } from '../preview/artboard-link.ts'
import type { StoreContext } from '../store/revisions.ts'
import { emptyStructure, type Structure, validateStructure } from '../structure/structure.ts'
import { canSee, readDraftFile } from './access.ts'
import type { AppEnv } from './projects.ts'

type Body = Record<string, unknown>

export function designRoutes(
  app: Hono<AppEnv>,
  ctx: StoreContext,
  preview?: { secret: string; url: URL },
  endpoint?: Endpoint,
) {
  const base = '/api/p/:project/design'
  app.use(
    `${base}/*`,
    bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  const structureOf = async (c: Context<AppEnv>, project: string): Promise<Structure> => {
    const text = await readDraftFile(ctx, c.get('user'), project, 'structure.json')
    // [To be set] the real project address; only page ids matter here.
    return text ? validateStructure(JSON.parse(text)) : emptyStructure('example.com')
  }

  // Members only; everyone else gets the same 404 as a project that does not exist.
  const guarded =
    (fn: (c: Context<AppEnv>, project: string, body: Body) => Promise<Response> | Response) =>
    async (c: Context<AppEnv>) => {
      const project = c.req.param('project') ?? ''
      if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
      const body = c.req.method === 'GET' ? {} : ((await c.req.json().catch(() => ({}))) as Body)
      try {
        return await fn(c, project, body)
      } catch (err) {
        if (err instanceof DesignError) return c.json({ code: err.code, ...err.extra }, err.status)
        throw err
      }
    }

  const num = (v: string | undefined) => (v && /^[1-9][0-9]*$/.test(v) ? Number(v) : -1)
  const text = (v: unknown, name: string): string =>
    typeof v === 'string' ? v : bad(`${name}-required`)
  const bad = (code: string): never => {
    throw new DesignError(400, code)
  }

  app.get(
    `${base}`,
    guarded(async (c, project) => {
      const s = await structureOf(c, project)
      return c.json({
        pages: s.pages.map((p) => ({
          id: p.id,
          title: p.title,
          artboards: artboardsOfPage(ctx.db, project, p.id).map((a) => artboardSummary(ctx.db, a)),
        })),
        presence: presence(ctx, project, c.get('user').id),
      })
    }),
  )

  app.post(
    `${base}/artboards`,
    guarded(async (c, project, b) => {
      const pageId = text(b.pageId, 'pageId')
      if (!(await structureOf(c, project)).pages.some((p) => p.id === pageId))
        return c.json({ code: 'no-such-page' }, 400)
      const row = await createArtboard(ctx, {
        project,
        pageId,
        html: text(b.html, 'html'),
        css: typeof b.css === 'string' ? b.css : '',
        description: typeof b.description === 'string' ? b.description : '',
        role: b.role as Role | undefined,
        kind: b.kind as 'state' | 'mobile' | undefined,
        parentId: typeof b.parentId === 'number' ? b.parentId : undefined,
        level: b.level as never,
        by: c.get('user').handle,
      })
      return c.json(await artboardDetail(ctx, project, row), 201)
    }),
  )

  const one = async (c: Context<AppEnv>, project: string) => {
    const row = getArtboard(ctx.db, project, num(c.req.param('id')))
    if (!row) throw new DesignError(404, 'not-found')
    return row
  }

  // A signed, 15-minute path on the preview site (rule 4): membership is checked here, so the
  // preview, which has no cookies, only has to check the signature.
  app.get(
    `${base}/artboards/:id/preview`,
    guarded(async (c, project) => {
      const row = await one(c, project)
      if (!preview) return c.json({ code: 'no-preview' }, 503)
      const path = signArtboardLink(preview.secret, {
        project,
        html: row.html_hash,
        css: row.css_hash ?? null,
      })
      return c.json({ url: new URL(path, preview.url).href })
    }),
  )

  app.get(
    `${base}/artboards/:id`,
    guarded(async (c, project) =>
      c.json(await artboardDetail(ctx, project, await one(c, project))),
    ),
  )

  app.put(
    `${base}/artboards/:id/html`,
    guarded(async (c, project, b) => {
      const row = await one(c, project)
      const r = await applyHtml(
        ctx,
        project,
        row.id,
        text(b.html, 'html'),
        typeof b.css === 'string' ? b.css : '',
        {
          level: b.level,
        },
      )
      return c.json({ ...(await artboardDetail(ctx, project, r.artboard)), warnings: r.warnings })
    }),
  )

  app.post(
    `${base}/artboards/:id/role`,
    guarded(async (c, project, b) => {
      const row = await one(c, project)
      return c.json(
        await artboardDetail(ctx, project, setRole(ctx, project, row.id, b.role, b.oldLeadBecomes)),
      )
    }),
  )

  const sectionBoard = async (c: Context<AppEnv>, project: string) => {
    const row = getArtboard(ctx.db, project, num(c.req.param('artboard')))
    if (!row) throw new DesignError(404, 'not-found')
    return row
  }
  const afterSection = async (c: Context<AppEnv>, project: string) =>
    c.json(await artboardDetail(ctx, project, await sectionBoard(c, project)))

  app.put(
    `${base}/sections/:artboard/:section/check/:item`,
    guarded(async (c, project, b) => {
      await setCheck(
        ctx,
        project,
        num(c.req.param('artboard')),
        c.req.param('section') ?? '',
        c.req.param('item') ?? '',
        b.on,
      )
      return afterSection(c, project)
    }),
  )

  app.post(
    `${base}/sections/:artboard/:section/approve`,
    guarded(async (c, project) => {
      approveSection(
        ctx,
        project,
        num(c.req.param('artboard')),
        c.req.param('section') ?? '',
        c.get('user').handle,
      )
      return afterSection(c, project)
    }),
  )
  app.post(
    `${base}/sections/:artboard/:section/unlock`,
    guarded(async (c, project) => {
      unlockSection(ctx, project, num(c.req.param('artboard')), c.req.param('section') ?? '')
      return afterSection(c, project)
    }),
  )

  app.post(
    `${base}/deviations/:id/outcome`,
    guarded((c, project, b) =>
      c.json(deviationOutcome(ctx, project, num(c.req.param('id')), b.outcome)),
    ),
  )

  // ---- takes (plan §6.4-6.6; decision #45): the AI proposes, a person applies ----

  // Think new is never sticky: whatever the request asked for, the next one starts at follow.
  const NEXT = { level: 'follow' as const }

  const aiCtx = async (c: Context<AppEnv>, project: string, pageId: string) => {
    const page = (await structureOf(c, project)).pages.find((p) => p.id === pageId)
    return {
      endpoint: endpoint as Endpoint,
      ctx,
      project,
      user: c.get('user').handle,
      page: page && {
        title: page.title,
        miniBrief: page.miniBrief && {
          goal: page.miniBrief.goal,
          visitorAction: page.miniBrief.visitorAction,
        },
      },
      signal: c.req.raw.signal,
    }
  }
  const aiFailed = (err: unknown) => {
    if (err instanceof LlmHttpError) return { status: 502 as const, message: err.message }
    throw err
  }
  const takeInput = (row: ReturnType<typeof getArtboard> & object, b: Body) => ({
    artboard: row,
    scope: b.scope === undefined ? 'page' : text(b.scope, 'scope'),
    prompt: typeof b.prompt === 'string' ? b.prompt : '',
    axis: (b.axis === undefined || b.axis === null ? undefined : b.axis) as Axis | undefined,
    steer: typeof b.steer === 'string' ? b.steer : undefined,
    level: (b.level === undefined ? 'follow' : b.level) as Level,
  })
  const outcome = async (
    c: Context<AppEnv>,
    project: string,
    r: Awaited<ReturnType<typeof generateTake>>,
  ) =>
    r.ok
      ? c.json({ take: await takeView(ctx, project, r.take), ...NEXT })
      : c.json({ code: 'take-refused', reasons: r.reasons, ...NEXT }, 422)

  app.post(
    `${base}/artboards/:id/takes`,
    guarded(async (c, project, b) => {
      const row = await one(c, project)
      if (!endpoint) return c.json({ code: 'no-model-endpoint' }, 503)
      try {
        return await outcome(
          c,
          project,
          await generateTake(await aiCtx(c, project, row.page_id), takeInput(row, b)),
        )
      } catch (err) {
        const e = aiFailed(err)
        return c.json({ code: 'ai-failed', message: e.message, ...NEXT }, e.status)
      }
    }),
  )

  app.get(
    `${base}/artboards/:id/takes/estimate`,
    guarded(async (c, project) => {
      const row = await one(c, project)
      const q = (k: string) => c.req.query(k)
      const input = takeInput(row, {
        scope: q('scope') ?? 'page',
        axis: q('axis') || undefined,
        level: q('level') ?? 'follow',
        prompt: q('prompt') ?? '',
      })
      const aiBase = await aiCtx(c, project, row.page_id)
      return c.json(await estimateTake(aiBase, input))
    }),
  )

  app.post(
    `${base}/artboards/:id/takes/:takeId/apply`,
    guarded(async (c, project) => {
      const row = await one(c, project)
      const take = getTake(ctx, row.id, num(c.req.param('takeId')))
      if (!take) return c.json({ code: 'not-found' }, 404)
      const r = await applyTake(ctx, project, row, take, c.get('user').handle)
      return c.json({
        ...(await artboardDetail(ctx, project, r.artboard)),
        takeId: take.id,
        issues: r.issues,
        warnings: r.warnings,
        ...NEXT,
      })
    }),
  )

  const deviationOf = (c: Context<AppEnv>, project: string) => {
    const d = ctx.db
      .query(
        `select d.id, d.artboard_id, d.section_id, d.rule, d.message, d.status
         from deviations d join artboards a on a.id = d.artboard_id
         where d.id = ? and a.project_id = ?`,
      )
      .get(num(c.req.param('id')), project) as {
      id: number
      artboard_id: number
      section_id: string | null
      rule: string
      message: string
      status: string
    } | null
    if (!d) throw new DesignError(404, 'not-found')
    return d
  }

  app.post(
    `${base}/deviations/:id/fix`,
    guarded(async (c, project) => {
      const d = deviationOf(c, project)
      if (d.status !== 'open' && d.status !== 'experiment') throw new DesignError(409, 'not-open')
      if (!endpoint) return c.json({ code: 'no-model-endpoint' }, 503)
      const row = getArtboard(ctx.db, project, d.artboard_id) as ArtboardRow
      try {
        return await outcome(
          c,
          project,
          await fixDeviation(await aiCtx(c, project, row.page_id), row, d),
        )
      } catch (err) {
        const e = aiFailed(err)
        return c.json({ code: 'ai-failed', message: e.message, ...NEXT }, e.status)
      }
    }),
  )

  app.post(
    `${base}/deviations/:id/propose`,
    guarded((c, project) => {
      deviationOf(c, project)
      return c.json({
        ...proposeToGuide(ctx, project, num(c.req.param('id')), c.get('user').handle),
        ...NEXT,
      })
    }),
  )
}
