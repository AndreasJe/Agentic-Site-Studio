// Who may see a project, and each person's own draft (decisions #10, #41). Shared by every
// route that touches project content, so the rules live in one place.
import type { SessionUser } from '../auth/sessions.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { currentRevision, projectDir, type StoreContext } from '../store/revisions.ts'

export type DraftRow = { id: number; base: string | null; files: string }

export function canSee(ctx: StoreContext, user: SessionUser, project: string): boolean {
  const { db } = ctx
  return (
    !!db.query('select 1 from projects where id = ?').get(project) &&
    (user.role === 'admin' ||
      !!db
        .query('select 1 from members where project_id = ? and user_id = ?')
        .get(project, user.id))
  )
}

export function draftOf(ctx: StoreContext, user: SessionUser, project: string): DraftRow {
  const row = ctx.db
    .query('select id, base, files from drafts where project_id = ? and user_id = ?')
    .get(project, user.id) as DraftRow | null
  if (row) return row
  // A new draft starts from the current revision: the newest number (decision #41).
  const base = currentRevision(ctx.dataDir, project)
  return ctx.db
    .query(
      'insert into drafts (project_id, user_id, base, files, updated_at) values (?, ?, ?, ?, ?) returning id, base, files',
    )
    .get(project, user.id, base, '{}', new Date().toISOString()) as DraftRow
}

/** One file of the caller's draft, or null. */
export async function readDraftFile(
  ctx: StoreContext,
  user: SessionUser,
  project: string,
  path: string,
) {
  const files = JSON.parse(draftOf(ctx, user, project).files) as Record<string, string>
  const hash = files[path]
  if (!hash) return null
  return new TextDecoder().decode(await getBlob(projectDir(ctx.dataDir, project), hash))
}

/** Autosave into the caller's draft: blobs plus one version (plan §11.1). */
export async function writeDraftFiles(
  ctx: StoreContext,
  user: SessionUser,
  project: string,
  files: Record<string, string>,
) {
  const draft = draftOf(ctx, user, project)
  const map = JSON.parse(draft.files) as Record<string, string>
  for (const [path, content] of Object.entries(files)) {
    map[path] = await putBlob(projectDir(ctx.dataDir, project), new TextEncoder().encode(content))
  }
  const at = new Date().toISOString()
  ctx.db.transaction(() => {
    ctx.db
      .query('update drafts set files = ?, updated_at = ? where id = ?')
      .run(JSON.stringify(map), at, draft.id)
    ctx.db
      .query('insert into versions (draft_id, files, at) values (?, ?, ?)')
      .run(draft.id, JSON.stringify(map), at)
  })()
}
