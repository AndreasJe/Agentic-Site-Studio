// Structure routes (plan §10; decision #44). structure.json lives in the caller's own draft and
// is validated against contracts/structure.schema.json on every write.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SessionUser } from '../auth/sessions.ts'
import { emptyBrief, normalizeBrief } from '../brief/brief.ts'
import { type Endpoint, LlmHttpError, LlmSchemaError } from '../llm/llm.ts'
import { getBlob } from '../store/blobs.ts'
import { projectDir, readRevision, type StoreContext } from '../store/revisions.ts'
import {
  draftStructure,
  hasBriefContent,
  ProposalError,
  proposeMenu,
  suggestMissing,
} from '../structure/ai.ts'
import {
  addPage,
  addToMenu,
  allPaths,
  deletePage,
  emptyStructure,
  movePage,
  navigationChecks,
  type PageType,
  type Pattern,
  type Placement,
  pagesAndJobsText,
  requestAddress,
  type Structure,
  StructureError,
  setHidden,
  setPattern,
  setPlacement,
  validateStructure,
} from '../structure/structure.ts'
import { canSee, readDraftFile, writeDraftFiles } from './access.ts'
import type { AppEnv } from './projects.ts'

const FILE = 'structure.json'

/** [To be set] Where a project's main address comes from is not decided yet; a placeholder. */
const PROJECT_ADDRESS = 'example.com'

type Body = Record<string, unknown>
const str = (v: unknown, name: string): string =>
  typeof v === 'string' ? v : bad(`${name} is required`)
const optStr = (v: unknown) => (typeof v === 'string' ? v : undefined)
const bad = (m: string): never => {
  throw new StructureError(m)
}

/** Paths of the approved revision, so a move knows which addresses are already public. */
async function approvedPaths(ctx: StoreContext, project: string): Promise<Set<string>> {
  const row = ctx.db.query('select approved from projects where id = ?').get(project) as {
    approved: string | null
  } | null
  const rev = row?.approved ? readRevision(ctx.dataDir, project, row.approved) : null
  const hash = rev?.files[FILE]
  if (!hash) return new Set()
  const text = new TextDecoder().decode(await getBlob(projectDir(ctx.dataDir, project), hash))
  return allPaths(JSON.parse(text) as Structure)
}

export function structureRoutes(app: Hono<AppEnv>, ctx: StoreContext, endpoint?: Endpoint) {
  const load = async (user: SessionUser, project: string): Promise<Structure> => {
    const text = await readDraftFile(ctx, user, project, FILE)
    return text ? validateStructure(JSON.parse(text)) : emptyStructure(PROJECT_ADDRESS)
  }
  const view = async (project: string, s: Structure, extra: Body = {}) => ({
    structure: s,
    findings: navigationChecks(s, await approvedPaths(ctx, project)),
    pagesAndJobs: pagesAndJobsText(s),
    ...extra,
  })

  app.use(
    '/api/p/:project/structure/*',
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  app.get('/api/p/:project/structure', async (c) => {
    const project = c.req.param('project')
    if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    return c.json(await view(project, await load(c.get('user'), project)))
  })

  // The AI proposes, nothing is stored; a person applies (plan §10.2, §4.10).
  const aiError = (err: unknown) => {
    if (
      err instanceof LlmSchemaError ||
      err instanceof LlmHttpError ||
      err instanceof ProposalError
    )
      return { status: 502 as const, code: 'ai-failed', message: err.message }
    throw err
  }
  const propose = (action: 'draft' | 'missing' | 'menu') => async (c: Context<AppEnv>) => {
    const user = c.get('user')
    const project = c.req.param('project') ?? ''
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    if (!endpoint) return c.json({ code: 'no-model-endpoint' }, 503)
    const text = await readDraftFile(ctx, user, project, 'brief.json')
    const brief = text
      ? normalizeBrief(JSON.parse(text))
      : emptyBrief({ id: '', title: '', author: '' })
    if (!hasBriefContent(brief)) return c.json({ code: 'brief-empty' }, 400)
    const b = (await c.req.json().catch(() => ({}))) as Body
    try {
      const s = await load(user, project)
      const aiCtx = { endpoint, db: ctx.db, project, user: user.handle }
      if (action === 'menu') {
        const root = optStr(b.root) ?? s.roots[0]?.address ?? ''
        if (!s.roots.some((r) => r.address === root)) return c.json({ code: 'bad-root' }, 400)
        return c.json({
          root,
          menu: 'main',
          ...(await proposeMenu(aiCtx, brief, s, root)),
        })
      }
      const run = action === 'draft' ? draftStructure : suggestMissing
      return c.json({ proposals: await run(aiCtx, brief, s) })
    } catch (err) {
      const e = aiError(err)
      return c.json(e, e.status)
    }
  }
  app.post('/api/p/:project/structure/draft', propose('draft'))
  app.post('/api/p/:project/structure/suggest-missing', propose('missing'))
  app.post('/api/p/:project/structure/propose-menu', propose('menu'))

  app.post('/api/p/:project/structure/apply', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Body
    try {
      let s = await load(user, project)
      const made = new Map<string, string>() // slug of a page applied now -> its id
      const ids: string[] = []
      for (const raw of Array.isArray(b.pages) ? (b.pages as Body[]) : []) {
        const slug = str(raw.slug, 'slug')
        const parent = optStr(raw.parent) ?? null
        const placement = optStr(raw.placement)
        if (placement !== undefined && placement !== 'menu' && placement !== 'hidden')
          bad('A proposed page is in a menu or hidden')
        const r = addPage(s, {
          title: str(raw.title, 'title'),
          slug,
          type: str(raw.type, 'type') as PageType,
          parent: parent === null ? null : (made.get(parent) ?? parent),
          root: optStr(raw.root),
          placement: placement as Placement | undefined,
          status: 'proposed',
        })
        s = r.structure
        made.set(slug, r.id)
        ids.push(r.id)
      }
      const m = b.menu as { root?: unknown; after?: unknown } | undefined
      if (m) {
        const root = str(m.root, 'root')
        if (!Array.isArray(m.after)) bad('A menu proposal needs its items')
        if (!s.roots.some((r) => r.address === root)) bad(`No such address: ${root}`)
        // Replace the main menu item by item, so every addToMenu rule applies.
        const menus = s.menus[root] ?? { main: [], footer: [], utility: [] }
        s = { ...s, menus: { ...s.menus, [root]: { ...menus, main: [] } } }
        type Raw = { page?: unknown; label?: unknown; children?: unknown }
        const put = (items: Raw[], under?: string) => {
          for (const i of items) {
            const page = str(i.page, 'page')
            s = addToMenu(s, root, 'main', { page, label: optStr(i.label) }, under)
            if (Array.isArray(i.children)) put(i.children as Raw[], page)
          }
        }
        put(m.after as Raw[])
      }
      validateStructure(s)
      await writeDraftFiles(ctx, user, project, { [FILE]: `${JSON.stringify(s, null, 2)}\n` })
      return c.json(await view(project, s, { ids }))
    } catch (err) {
      if (err instanceof StructureError)
        return c.json({ code: 'bad-structure', message: err.message }, 400)
      throw err
    }
  })

  // Accepting is a person's choice, one by one or all (decision #44).
  app.post('/api/p/:project/structure/accept', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Body
    const s = await load(user, project)
    const pick = Array.isArray(b.ids) ? new Set(b.ids as unknown[]) : new Set()
    const next: Structure = {
      ...s,
      pages: s.pages.map((p) =>
        p.status === 'proposed' && (b.all === true || pick.has(p.id))
          ? { ...p, status: 'decided' as const }
          : p,
      ),
    }
    await writeDraftFiles(ctx, user, project, { [FILE]: `${JSON.stringify(next, null, 2)}\n` })
    return c.json(await view(project, next))
  })

  app.post('/api/p/:project/structure/:action', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Body
    try {
      const s = await load(user, project)
      let next: Structure
      let id: string | undefined
      switch (c.req.param('action')) {
        case 'add-page': {
          const r = addPage(s, {
            title: str(b.title, 'title'),
            slug: str(b.slug, 'slug'),
            type: str(b.type, 'type') as PageType,
            parent: optStr(b.parent) ?? null,
            root: optStr(b.root),
            placement: optStr(b.placement) as Placement | undefined,
            status: optStr(b.status) as 'decided' | undefined,
            miniBrief: b.miniBrief as Structure['pages'][number]['miniBrief'],
          })
          next = r.structure
          id = r.id
          break
        }
        case 'move-page':
          next = movePage(s, str(b.id, 'id'), {
            parent: optStr(b.parent) ?? null,
            slug: optStr(b.slug),
            root: optStr(b.root),
            approvedPaths: await approvedPaths(ctx, project),
          })
          break
        case 'set-hidden':
          next = setHidden(s, str(b.id, 'id'), b.hidden === true)
          break
        case 'set-placement':
          next = setPlacement(s, str(b.id, 'id'), str(b.placement, 'placement') as Placement)
          break
        case 'set-pattern':
          next = setPattern(s, str(b.pattern, 'pattern') as Pattern)
          break
        case 'delete-page':
          next = deletePage(s, str(b.id, 'id'))
          break
        case 'add-to-menu':
          next = addToMenu(
            s,
            str(b.root, 'root'),
            str(b.menu, 'menu') as 'main',
            { page: optStr(b.page), url: optStr(b.url), label: optStr(b.label) },
            optStr(b.under),
          )
          break
        case 'request-address':
          next = requestAddress(s, {
            name: str(b.name, 'name'),
            pageId: str(b.pageId, 'pageId'),
            note: optStr(b.note) ?? '',
            by: user.handle,
            at: new Date().toISOString(),
          })
          break
        default:
          return c.json({ code: 'bad-action' }, 400)
      }
      validateStructure(next)
      await writeDraftFiles(ctx, user, project, { [FILE]: `${JSON.stringify(next, null, 2)}\n` })
      return c.json(await view(project, next, id ? { id } : {}))
    } catch (err) {
      if (err instanceof StructureError)
        return c.json({ code: 'bad-structure', message: err.message }, 400)
      throw err
    }
  })
}
