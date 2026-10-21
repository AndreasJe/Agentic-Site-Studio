// Review routes (plan §7; M5): a saved revision's pages, Leads and sections as the revision itself
// recorded them (design.json, never the live database), the review package, approving the
// revision, accepting accessibility findings and AI checkmark suggestions that change nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SessionUser } from '../auth/sessions.ts'
import { CHECK_ITEMS, readArtboardFiles, sectionsFromHtml } from '../design/design.ts'
import { type Endpoint, LlmHttpError, LlmSchemaError, llm } from '../llm/llm.ts'
import { signReviewLink } from '../preview/review-link.ts'
import {
  buildPackage,
  type DesignSection,
  leadOf,
  packageHash,
  revisionDesign,
  revisionStructure,
} from '../review/package.ts'
import { projectDir, readRevision, rebuildIndex, type StoreContext } from '../store/revisions.ts'
import { canSee } from './access.ts'
import type { AppEnv } from './projects.ts'

const suggestionSchema = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../contracts/checkmark-suggestions.schema.json'),
    'utf8',
  ),
) as Record<string, unknown>

/** Decision #43: a member with the approve right (all Creators until M7) or an Admin. */
const mayApprove = (user: SessionUser) => user.role === 'admin' || user.role === 'creator'

type Blocker = { page: string; reason: 'no-lead' | 'section-not-approved'; sectionId?: string }
type Body = Record<string, unknown>

const progress = (s: DesignSection) => {
  const done = CHECK_ITEMS.filter((i) => s.checklist[i]).length
  return { done, progress: s.approved ? 'approved' : `${done}/7` }
}

export function reviewRoutes(
  app: Hono<AppEnv>,
  ctx: StoreContext,
  endpoint?: Endpoint,
  preview?: { secret: string; url: URL },
) {
  const base = '/api/p/:project/review'
  const { db } = ctx
  app.use(
    `${base}/*`,
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  // Members only; everyone else gets the same 404 as a revision that does not exist.
  const guarded =
    (
      fn: (
        c: Context<AppEnv>,
        project: string,
        rev: string,
        files: Record<string, string>,
        body: Body,
      ) => Promise<Response> | Response,
    ) =>
    async (c: Context<AppEnv>) => {
      const project = c.req.param('project') ?? ''
      if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
      const rev = c.req.param('rev') ?? ''
      const doc = readRevision(ctx.dataDir, project, rev)
      if (!doc) return c.json({ code: 'not-found' }, 404)
      const body = c.req.method === 'GET' ? {} : ((await c.req.json().catch(() => ({}))) as Body)
      return fn(c, project, rev, doc.files, body)
    }

  /** What the revision itself says: pages with their Lead, the approval rule and its blockers. */
  async function state(project: string, files: Record<string, string>) {
    const structure = await revisionStructure(ctx, project, files)
    const boards = await revisionDesign(ctx, project, files)
    const blockers: Blocker[] = []
    let approved = 0
    let total = 0
    const pages = structure.pages.map((p) => {
      const lead = leadOf(boards, p.id)
      if (!lead) {
        blockers.push({ page: p.id, reason: 'no-lead' })
        return { id: p.id, title: p.title, lead: null }
      }
      const sections = lead.sections.map((s) => {
        total++
        if (s.approved) approved++
        else blockers.push({ page: p.id, reason: 'section-not-approved', sectionId: s.id })
        return {
          id: s.id,
          name: s.name,
          job: s.job,
          checklist: s.checklist,
          approved: s.approved,
          ...progress(s),
        }
      })
      return {
        id: p.id,
        title: p.title,
        lead: { letter: lead.letter, artboard: lead.id, sections },
      }
    })
    return { pages, approved: { n: approved, m: total }, blockers, boards }
  }

  const approvalOf = (project: string, rev: string) =>
    db
      .query(
        `select a.rev, a.package_hash as packageHash, a.at, u.handle as "by" from revision_approvals a
         join users u on u.id = a.user_id where a.project_id = ? and a.rev = ?`,
      )
      .get(project, rev) as { rev: string; packageHash: string; at: string; by: string } | null

  const acceptancesOf = (project: string, rev: string) =>
    db
      .query(
        `select a.id, a.rule, a.target, a.reason, a.at, u.handle as "by" from a11y_acceptances a
         join users u on u.id = a.user_id where a.project_id = ? and a.rev = ? order by a.id`,
      )
      .all(project, rev)

  app.get(base, (c) => {
    const project = c.req.param('project') ?? ''
    if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const index = JSON.parse(
      readFileSync(join(projectDir(ctx.dataDir, project), 'project.json'), 'utf8'),
    ) as { revisions: { id: string; by: string; msg: string }[] }
    const approvals = new Set(
      (
        db.query('select rev from revision_approvals where project_id = ?').all(project) as {
          rev: string
        }[]
      ).map((r) => r.rev),
    )
    return c.json({
      revisions: [...index.revisions]
        .reverse()
        .map((r) => ({ id: r.id, by: r.by, msg: r.msg, approved: approvals.has(r.id) })),
    })
  })

  // A signed, 15-minute path to the review shell on the preview site (decision #46). Membership
  // is checked here; the preview only checks the signature and the package hash.
  app.get(
    `${base}/:rev/link`,
    guarded(async (c, project, rev) => {
      if (!preview) return c.json({ code: 'no-preview' }, 503)
      const pkg = await buildPackage(ctx, project, rev)
      const path = signReviewLink(preview.secret, { project, rev, hash: pkg.hash })
      const pages = Object.keys(pkg.files).filter((p) => p.endsWith('index.html'))
      return c.json({ url: new URL(path, preview.url).href, pages })
    }),
  )

  app.get(
    `${base}/:rev`,
    guarded(async (c, project, rev, files) => {
      const s = await state(project, files)
      const pkg = await buildPackage(ctx, project, rev)
      const ready = s.blockers.length === 0
      return c.json({
        rev,
        pages: s.pages,
        approved: s.approved,
        package: { hash: pkg.hash },
        ready,
        canApprove: ready && mayApprove(c.get('user')),
        blockers: s.blockers,
        acceptances: acceptancesOf(project, rev),
        approval: approvalOf(project, rev),
      })
    }),
  )

  app.post(
    `${base}/:rev/approve`,
    guarded(async (c, project, rev, files) => {
      if (!mayApprove(c.get('user'))) return c.json({ code: 'forbidden' }, 403)
      const existing = approvalOf(project, rev)
      if (existing) return c.json({ approval: existing })
      const { blockers } = await state(project, files)
      if (blockers.length) return c.json({ code: 'not-ready', blockers }, 409)
      const pkg = await buildPackage(ctx, project, rev)
      // The hash the app computes now, from the stored bytes; never one a client sent.
      const hash = await packageHash(projectDir(ctx.dataDir, project), pkg.files)
      if (hash !== pkg.hash) return c.json({ code: 'package-changed' }, 500)
      db.transaction(() => {
        db.query(
          'insert or ignore into revision_approvals (project_id, rev, package_hash, user_id, at) values (?, ?, ?, ?, ?)',
        ).run(project, rev, hash, c.get('user').id, new Date().toISOString())
        // The project's approved revision only moves forward: approving an older one records
        // that approval but doesn't make it current (review of M5).
        const current = (
          db.query('select approved from projects where id = ?').get(project) as {
            approved: string | null
          } | null
        )?.approved
        const num = (r: string | null | undefined) => Number(/-r(\d+)$/.exec(r ?? '')?.[1] ?? 0)
        if (num(rev) > num(current))
          db.query('update projects set approved = ? where id = ?').run(rev, project)
      })()
      rebuildIndex(ctx, project)
      return c.json({ approval: approvalOf(project, rev) })
    }),
  )

  app.post(
    `${base}/:rev/findings/accept`,
    guarded((c, project, rev, _files, b) => {
      const user = c.get('user')
      if (!mayApprove(user)) return c.json({ code: 'forbidden' }, 403) // Creators and Admins
      const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
      if (reason.length < 3) return c.json({ code: 'reason-required' }, 400)
      const rule = typeof b.rule === 'string' ? b.rule.trim() : ''
      const target = typeof b.target === 'string' ? b.target.trim() : ''
      // Accessibility (axe) rule ids only. M6 applies acceptances to axe findings only, never to
      // a security-floor check (rule 10; review of M5).
      if (!/^[a-z0-9-]{1,80}$/.test(rule)) return c.json({ code: 'rule-required' }, 400)
      if (!target || target.length > 2000) return c.json({ code: 'target-required' }, 400)
      db.query(
        'insert into a11y_acceptances (project_id, rev, rule, target, reason, user_id, at) values (?, ?, ?, ?, ?, ?, ?)',
      ).run(project, rev, rule, target, reason.slice(0, 1000), user.id, new Date().toISOString())
      return c.json({ acceptances: acceptancesOf(project, rev) }, 201)
    }),
  )

  // The AI only suggests. Nothing here writes: no checkmark, no table, no file (rule 1; #8).
  app.post(
    `${base}/:rev/suggest`,
    guarded(async (c, project, rev, files, b) => {
      const sectionId = typeof b.sectionId === 'string' ? b.sectionId : ''
      const board = (await revisionDesign(ctx, project, files)).find((a) =>
        a.sections.some((s) => s.id === sectionId),
      )
      if (!board) return c.json({ code: 'not-found' }, 404)
      if (!endpoint) return c.json({ code: 'no-model-endpoint' }, 503)
      const { html } = await readArtboardFiles(ctx, project, {
        html_hash: board.html,
        css_hash: board.css,
      })
      const section = sectionsFromHtml(html).find((s) => s.id === sectionId)
      if (!section) return c.json({ code: 'not-found' }, 404)
      const on = board.sections.find((s) => s.id === sectionId)?.checklist ?? {}
      try {
        const r = await llm<{ suggestions: { item: string; reason: string }[] }>({
          endpoint,
          schema: suggestionSchema,
          schemaName: 'checkmark_suggestions',
          instructions:
            'Look at one section of a web page and say which of its seven checkmarks (copy, media, interactions, mobile, motion, translated, tested) look ready for a person to switch on. ' +
            'Suggest only items you can justify from the section itself, each with a short reason of at most 200 characters. ' +
            'Leave out anything you cannot judge; an empty list is a good answer. You only suggest; a person decides.',
          untrusted: `SECTION ${sectionId}\n${section.outer}\n\nSWITCHED ON ALREADY\n${CHECK_ITEMS.filter((i) => on[i]).join(', ') || '(none)'}`,
          usage: {
            db,
            meta: {
              project,
              user: c.get('user').handle,
              phase: 'review',
              action: 'suggest_checkmarks',
              task_class: 'small structured',
              model_role: 'planner',
            },
          },
        })
        return c.json({ rev, sectionId, suggestions: r.value.suggestions })
      } catch (err) {
        if (err instanceof LlmHttpError || err instanceof LlmSchemaError)
          return c.json({ code: 'ai-failed', message: err.message }, 502)
        throw err
      }
    }),
  )
}
