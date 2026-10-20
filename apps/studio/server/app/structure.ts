// Structure routes (plan §10; decision #44). structure.json lives in the caller's own draft and
// is validated against contracts/structure.schema.json on every write.
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SessionUser } from '../auth/sessions.ts'
import { getBlob } from '../store/blobs.ts'
import { projectDir, readRevision, type StoreContext } from '../store/revisions.ts'
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

export function structureRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
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
