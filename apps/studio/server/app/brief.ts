// Brief routes (plan §4; decision #42). The brief lives as brief.json in the caller's own draft.
import type { Hono } from 'hono'
import type { SessionUser } from '../auth/sessions.ts'
import {
  type Approval,
  approve,
  type Brief,
  BriefError,
  changeLog,
  clearBlock,
  emptyBrief,
  normalizeBrief,
  openQuestions,
  setBlock,
} from '../brief/brief.ts'
import { getBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'
import { canSee, draftOf, readDraftFile, writeDraftFiles } from './access.ts'
import type { AppEnv } from './projects.ts'

const FILE = 'brief.json'

/** One counter per author, never reused (plan §4.2). */
function nextBriefId(ctx: StoreContext, handle: string): string {
  const row = ctx.db
    .query(
      `insert into brief_counters (handle, next) values (?, 2)
       on conflict(handle) do update set next = next + 1 returning next - 1 as n`,
    )
    .get(handle) as { n: number }
  return `${handle}${row.n}`
}

async function loadBrief(ctx: StoreContext, user: SessionUser, project: string): Promise<Brief> {
  const text = await readDraftFile(ctx, user, project, FILE)
  if (text) return normalizeBrief(JSON.parse(text))
  const name = (
    ctx.db.query('select name from projects where id = ?').get(project) as { name: string }
  ).name
  const brief = emptyBrief({ id: nextBriefId(ctx, user.handle), title: name, author: user.handle })
  await writeDraftFiles(ctx, user, project, { [FILE]: `${JSON.stringify(brief, null, 2)}\n` })
  return brief
}

async function history(ctx: StoreContext, user: SessionUser, project: string) {
  const draft = draftOf(ctx, user, project)
  const rows = ctx.db
    .query('select files, at from versions where draft_id = ? order by id')
    .all(draft.id) as {
    files: string
    at: string
  }[]
  const out: { at: string; brief: Brief }[] = []
  let last = ''
  for (const r of rows) {
    const hash = (JSON.parse(r.files) as Record<string, string>)[FILE]
    if (!hash || hash === last) continue
    last = hash
    const text = new TextDecoder().decode(await getBlob(projectDir(ctx.dataDir, project), hash))
    out.push({ at: r.at, brief: normalizeBrief(JSON.parse(text)) })
  }
  return out
}

const setting = (ctx: StoreContext) =>
  ((
    ctx.db.query("select value from settings where key = 'brief_approval'").get() as {
      value: Approval
    } | null
  )?.value ?? 'optional') as Approval

export function briefRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
  const view = async (user: SessionUser, project: string, brief: Brief) => ({
    brief,
    openQuestions: openQuestions(brief),
    changeLog: changeLog(await history(ctx, user, project)),
    approval: setting(ctx),
  })
  const save = (user: SessionUser, project: string, brief: Brief) =>
    writeDraftFiles(ctx, user, project, { [FILE]: `${JSON.stringify(brief, null, 2)}\n` })

  app.get('/api/p/:project/brief', async (c) => {
    const project = c.req.param('project')
    if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    return c.json(await view(c.get('user'), project, await loadBrief(ctx, c.get('user'), project)))
  })

  app.put('/api/p/:project/brief/blocks/:key', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; ctas?: unknown }
    if (typeof body.text !== 'string') return c.json({ code: 'text-required' }, 400)
    try {
      const brief = setBlock(await loadBrief(ctx, user, project), c.req.param('key'), {
        text: body.text,
        source: { kind: 'user', by: user.handle, at: new Date().toISOString() },
        ...(Array.isArray(body.ctas) ? { ctas: body.ctas } : {}),
      })
      await save(user, project, brief)
      return c.json(await view(user, project, brief))
    } catch (err) {
      if (err instanceof BriefError) return c.json({ code: 'bad-block', message: err.message }, 400)
      throw err
    }
  })

  app.post('/api/p/:project/brief/blocks/:key/clear', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    try {
      const brief = clearBlock(await loadBrief(ctx, user, project), c.req.param('key'))
      await save(user, project, brief)
      return c.json(await view(user, project, brief))
    } catch (err) {
      if (err instanceof BriefError) return c.json({ code: 'bad-block', message: err.message }, 400)
      throw err
    }
  })

  app.post('/api/p/:project/brief/approve', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    try {
      const brief = approve(await loadBrief(ctx, user, project), setting(ctx))
      await save(user, project, brief)
      return c.json(await view(user, project, brief))
    } catch (err) {
      if (err instanceof BriefError)
        return c.json({ code: 'approval-off', message: err.message }, 400)
      throw err
    }
  })
}
