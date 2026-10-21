// Projects, private drafts and saving (plan §11; decisions #10, #41). A draft belongs to one
// person; there is no route that returns someone else's draft.
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { isSafePath } from '@site-studio/shared/release'
import type { Hono } from 'hono'
import type { SessionUser } from '../auth/sessions.ts'
import { withDesignFile } from '../design/design.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import {
  createProject,
  currentRevision,
  indexPath,
  projectDir,
  readRevision,
  SlugTakenError,
  type StoreContext,
  saveRevision,
} from '../store/revisions.ts'
import { canSee as canSeeProject, type DraftRow, draftOf as draftOfUser } from './access.ts'

export type AppEnv = { Variables: { user: SessionUser; sid: string; csrf: string } }

export function projectRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
  const { db } = ctx
  const archivedOf = (project: string) =>
    JSON.parse(
      (db.query('select archived from projects where id = ?').get(project) as { archived: string })
        .archived,
    ) as string[]

  const canSee = (user: SessionUser, project: string) => canSeeProject(ctx, user, project)
  const draftOf = (user: SessionUser, project: string): DraftRow => draftOfUser(ctx, user, project)

  app.get('/api/projects', (c) => {
    const user = c.get('user')
    const rows =
      user.role === 'admin'
        ? db.query('select id, name from projects order by id').all()
        : db
            .query(
              'select p.id, p.name from projects p join members m on m.project_id = p.id where m.user_id = ? order by p.id',
            )
            .all(user.id)
    return c.json({ projects: rows })
  })

  app.post('/api/projects', async (c) => {
    const { name } = (await c.req.json().catch(() => ({}))) as { name?: unknown }
    if (typeof name !== 'string' || !name.trim()) return c.json({ code: 'name-required' }, 400)
    try {
      return c.json(createProject(ctx, { name: name.trim(), by: c.get('user').handle }), 201)
    } catch (err) {
      if (err instanceof SlugTakenError) {
        return c.json({ code: 'slug-taken', slug: err.slug, suggested: err.suggested }, 409)
      }
      return c.json({ code: 'bad-name', message: (err as Error).message }, 400)
    }
  })

  app.get('/api/p/:project/draft', async (c) => {
    const project = c.req.param('project')
    if (!canSee(c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const draft = draftOf(c.get('user'), project)
    const files: Record<string, string> = {}
    for (const [path, hash] of Object.entries(JSON.parse(draft.files) as Record<string, string>)) {
      files[path] = new TextDecoder().decode(await getBlob(projectDir(ctx.dataDir, project), hash))
    }
    return c.json({ base: draft.base, files })
  })

  // Autosave: every change is stored as blobs and recorded as a version of the draft.
  app.put('/api/p/:project/draft', async (c) => {
    const project = c.req.param('project')
    if (!canSee(c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const { files } = (await c.req.json().catch(() => ({}))) as { files?: unknown }
    if (typeof files !== 'object' || files === null) return c.json({ code: 'files-required' }, 400)
    const draft = draftOf(c.get('user'), project)
    const map = JSON.parse(draft.files) as Record<string, string>
    for (const [path, content] of Object.entries(files as Record<string, unknown>)) {
      if (!isSafePath(path) || typeof content !== 'string')
        return c.json({ code: 'bad-file', path }, 400)
      map[path] = await putBlob(projectDir(ctx.dataDir, project), new TextEncoder().encode(content))
    }
    const at = new Date().toISOString()
    db.transaction(() => {
      db.query('update drafts set files = ?, updated_at = ? where id = ?').run(
        JSON.stringify(map),
        at,
        draft.id,
      )
      db.query('insert into versions (draft_id, files, at) values (?, ?, ?)').run(
        draft.id,
        JSON.stringify(map),
        at,
      )
    })()
    return c.json({ ok: true })
  })

  app.post('/api/p/:project/draft/save', async (c) => {
    const project = c.req.param('project')
    const user = c.get('user')
    if (!canSee(user, project)) return c.json({ code: 'not-found' }, 404)
    const { msg } = (await c.req.json().catch(() => ({}))) as { msg?: unknown }
    if (typeof msg !== 'string' || msg.trim().length < 3)
      return c.json({ code: 'message-required' }, 400)
    const draft = draftOf(user, project)
    const revision = await saveRevision(ctx, {
      project,
      parent: draft.base,
      by: user.handle,
      phase: 'brief',
      msg: msg.trim(),
      files: await withDesignFile(ctx, project, JSON.parse(draft.files)),
    })
    // Saved on top of something newer than the draft started from: say so (decision #41).
    const n = Number(revision.split('-r')[1])
    const warning =
      draft.base && draft.base !== `${project}-r${n - 1}` ? 'base-not-current' : undefined
    // The draft continues, based on the revision just saved.
    db.query('update drafts set base = ?, updated_at = ? where id = ?').run(
      revision,
      new Date().toISOString(),
      draft.id,
    )
    return c.json({ revision, ...(warning ? { warning } : {}) })
  })

  app.delete('/api/p/:project/draft', (c) => {
    const project = c.req.param('project')
    if (!canSee(c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const draft = draftOf(c.get('user'), project)
    db.transaction(() => {
      db.query('delete from versions where draft_id = ?').run(draft.id)
      db.query('delete from drafts where id = ?').run(draft.id)
    })()
    return c.json({ ok: true })
  })

  // The timeline comes from project.json (an index of the revision files), newest first.
  app.get('/api/p/:project/revisions', (c) => {
    const project = c.req.param('project')
    if (!canSee(c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const index = JSON.parse(readFileSync(indexPath(ctx.dataDir, project), 'utf8')) as {
      revisions: { id: string; parent: string | null; by: string; msg: string }[]
    }
    const archived = new Set(archivedOf(project))
    return c.json({
      current: currentRevision(ctx.dataDir, project),
      revisions: index.revisions.map((r) => ({ ...r, archived: archived.has(r.id) })).reverse(),
    })
  })

  // Read-only: the revision's files, nothing that can change it.
  app.get('/api/p/:project/revisions/:id', async (c) => {
    const project = c.req.param('project')
    if (!canSee(c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const doc = readRevision(ctx.dataDir, project, c.req.param('id'))
    if (!doc) return c.json({ code: 'not-found' }, 404)
    const files: Record<string, string> = {}
    for (const [path, hash] of Object.entries(doc.files)) {
      files[path] = new TextDecoder().decode(await getBlob(projectDir(ctx.dataDir, project), hash))
    }
    return c.json({ ...doc, files })
  })

  // Continue from here: a new revision on top of the newest, with this one as parent and its
  // files. Newer revisions stay. The caller's draft continues from the new revision.
  app.post('/api/p/:project/revisions/:id/continue', async (c) => {
    const project = c.req.param('project')
    const user = c.get('user')
    if (!canSee(user, project)) return c.json({ code: 'not-found' }, 404)
    const old = readRevision(ctx.dataDir, project, c.req.param('id'))
    if (!old) return c.json({ code: 'not-found' }, 404)
    const revision = await saveRevision(ctx, {
      project,
      parent: old.id,
      by: user.handle,
      phase: old.phase,
      msg: `Continued from ${old.id.slice(project.length + 1)}`,
      files: old.files,
    })
    const draft = draftOf(user, project)
    db.query('update drafts set base = ?, updated_at = ? where id = ?').run(
      revision,
      new Date().toISOString(),
      draft.id,
    )
    return c.json({ revision }, 201)
  })

  // Archive hides a revision from the timeline view; the files stay (nothing is deleted).
  app.post('/api/p/:project/revisions/:id/archive', async (c) => {
    const project = c.req.param('project')
    if (!canSee(c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    const { archived } = (await c.req.json().catch(() => ({}))) as { archived?: unknown }
    if (typeof archived !== 'boolean') return c.json({ code: 'archived-required' }, 400)
    const doc = readRevision(ctx.dataDir, project, c.req.param('id'))
    if (!doc) return c.json({ code: 'not-found' }, 404)
    const rest = archivedOf(project).filter((id) => id !== doc.id)
    db.query('update projects set archived = ? where id = ?').run(
      JSON.stringify(archived ? [...rest, doc.id] : rest),
      project,
    )
    return c.json({ ok: true })
  })
}
