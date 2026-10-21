// Design routes (plan §6; decision #45): artboards, roles, sections and deviations of a project.
// Design state is project-level in SQLite; members only (access.ts), everything else is a 404.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  applyHtml,
  approveSection,
  artboardDetail,
  artboardSummary,
  artboardsOfPage,
  createArtboard,
  DesignError,
  deviationOutcome,
  getArtboard,
  presence,
  type Role,
  setCheck,
  setRole,
  unlockSection,
} from '../design/design.ts'
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
      if (!preview) return c.json({ code: 'no-preview' }, 503)
      const row = await one(c, project)
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
}
