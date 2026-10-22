// Brief routes (plan §4; decision #42). The brief lives as brief.json in the caller's own draft.

import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SessionUser } from '../auth/sessions.ts'
import {
  followUps,
  MATERIAL_MAX_BYTES,
  MAX_TEXT_CHARS,
  MaterialError,
  readMaterial,
  sortNotes,
  tighten,
} from '../brief/ai.ts'
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
  type Source,
  setBlock,
} from '../brief/brief.ts'
import { type Endpoint, LlmHttpError, LlmSchemaError } from '../llm/llm.ts'
import { endpointFor } from '../models/models.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'
import { canSee, draftOf, readDraftFile, writeDraftFiles } from './access.ts'
import type { AppEnv } from './projects.ts'

const FILE = 'brief.json'

/** Creator rights arrive with Governance (M7); until then the Small team preset applies. */
const mayApproveBrief = (user: SessionUser) => user.role === 'admin' || user.role === 'creator'

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
  // Another request may have created it meanwhile; keep the one that exists.
  const again = await readDraftFile(ctx, user, project, FILE)
  if (again) return normalizeBrief(JSON.parse(again))
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

export function briefRoutes(app: Hono<AppEnv>, ctx: StoreContext, endpoint?: Endpoint) {
  const view = async (user: SessionUser, project: string, brief: Brief) => ({
    brief,
    openQuestions: openQuestions(brief),
    changeLog: changeLog(await history(ctx, user, project)),
    approval: setting(ctx),
    lastApproval: ctx.db
      .query(
        'select u.handle as by, a.at from brief_approvals a join users u on u.id = a.user_id where a.project_id = ? and a.brief_id = ? order by a.id desc limit 1',
      )
      .get(project, brief.id),
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
      // Decision #43: a member with the approve right (all Creators under the Small team preset
      // until Governance in M7) or an Admin. Who and when are recorded.
      if (!mayApproveBrief(user)) return c.json({ code: 'forbidden' }, 403)
      const brief = approve(await loadBrief(ctx, user, project), setting(ctx))
      await save(user, project, brief)
      ctx.db
        .query(
          'insert into brief_approvals (project_id, brief_id, user_id, at) values (?, ?, ?, ?)',
        )
        .run(project, brief.id, user.id, new Date().toISOString())
      return c.json(await view(user, project, brief))
    } catch (err) {
      if (err instanceof BriefError)
        return c.json({ code: 'approval-off', message: err.message }, 400)
      throw err
    }
  })

  const isMaterial = (project: string, hash: string) =>
    !!ctx.db.query('select 1 from materials where project_id = ? and hash = ?').get(project, hash)
  // Bodies are refused before they are read in full (review of M2).
  const jsonLimit = bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ code: 'too-large' }, 413),
  })
  app.use('/api/p/:project/brief/*', async (c, next) => {
    if (c.req.path.endsWith('/brief/material')) return next()
    return jsonLimit(c, next)
  })
  app.use(
    '/api/p/:project/brief/material',
    bodyLimit({
      maxSize: MATERIAL_MAX_BYTES + 64 * 1024,
      onError: (c) => c.json({ code: 'too-large' }, 413),
    }),
  )

  const aiCtx = (user: SessionUser, project: string) => {
    const ep = endpointFor(ctx, 'sorter', endpoint)
    if (!ep) throw new AiUnavailable()
    return { endpoint: ep, db: ctx.db, project, user: user.handle }
  }
  // AI failures are reported, never half-applied: the brief is untouched.
  const aiError = (err: unknown) => {
    if (err instanceof AiUnavailable) return { status: 503 as const, code: 'no-model-endpoint' }
    if (err instanceof LlmSchemaError || err instanceof LlmHttpError) {
      return { status: 502 as const, code: 'ai-failed', message: err.message }
    }
    throw err
  }

  app.post('/api/p/:project/brief/sort', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const { notes } = (await c.req.json().catch(() => ({}))) as { notes?: unknown }
    if (typeof notes !== 'string' || !notes.trim()) return c.json({ code: 'notes-required' }, 400)
    if (notes.length > MAX_TEXT_CHARS) return c.json({ code: 'notes-too-long' }, 413)
    try {
      const r = await sortNotes(aiCtx(user, project), notes)
      return c.json({
        blocks: r.blocks.map((b) => ({ ...b, source: { kind: 'user' } })),
        leftOut: r.leftOut,
      })
    } catch (err) {
      const e = aiError(err)
      return c.json(e, e.status)
    }
  })

  app.post('/api/p/:project/brief/material', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return c.json({ code: 'file-required' }, 400)
    try {
      const { text, stored } = await readMaterial(file)
      const hash = await putBlob(projectDir(ctx.dataDir, project), stored)
      ctx.db
        .query(
          'insert or ignore into materials (project_id, hash, name, uploaded_by, at) values (?, ?, ?, ?, ?)',
        )
        .run(project, hash, file.name, user.id, new Date().toISOString())
      const r = await sortNotes(aiCtx(user, project), text, 'sort_material')
      return c.json({
        document: { name: file.name, hash },
        blocks: r.blocks.map((b) => ({ ...b, source: { kind: 'document', ref: hash } })),
        leftOut: r.leftOut,
      })
    } catch (err) {
      if (err instanceof MaterialError)
        return c.json({ code: 'bad-material', message: err.message }, err.status)
      const e = aiError(err)
      return c.json(e, e.status)
    }
  })

  app.get('/api/p/:project/brief/material/:hash', async (c) => {
    const project = c.req.param('project')
    if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    try {
      // Only uploaded material: drafts share the blob store and stay private (rule 2).
      if (!isMaterial(project, c.req.param('hash'))) return c.json({ code: 'not-found' }, 404)
      const bytes = await getBlob(projectDir(ctx.dataDir, project), c.req.param('hash'))
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment',
        },
      })
    } catch {
      return c.json({ code: 'not-found' }, 404)
    }
  })

  // A person applies (part of) a proposal. The server sets the source: the person, or a
  // document already stored in this project.
  app.post('/api/p/:project/brief/apply', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const { blocks } = (await c.req.json().catch(() => ({}))) as { blocks?: unknown }
    if (!Array.isArray(blocks)) return c.json({ code: 'blocks-required' }, 400)
    try {
      let brief = await loadBrief(ctx, user, project)
      const at = new Date().toISOString()
      for (const raw of blocks) {
        const b = raw as {
          key?: unknown
          text?: unknown
          source?: { kind?: unknown; ref?: unknown }
        }
        if (typeof b.key !== 'string' || typeof b.text !== 'string') continue
        let source: Source = { kind: 'user', by: user.handle, at }
        if (b.source?.kind === 'document' && typeof b.source.ref === 'string') {
          const ref = b.source.ref
          const known = isMaterial(project, ref)
          if (known) source = { kind: 'document', ref, by: user.handle, at }
        }
        brief = setBlock(brief, b.key, { text: b.text, source, aiSorted: true })
      }
      await save(user, project, brief)
      return c.json(await view(user, project, brief))
    } catch (err) {
      if (err instanceof BriefError) return c.json({ code: 'bad-block', message: err.message }, 400)
      throw err
    }
  })

  app.post('/api/p/:project/brief/blocks/:key/ai', async (c) => {
    const user = c.get('user')
    const project = c.req.param('project')
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const { action } = (await c.req.json().catch(() => ({}))) as { action?: unknown }
    const block = (await loadBrief(ctx, user, project)).blocks.find(
      (b) => b.key === c.req.param('key'),
    )
    if (!block) return c.json({ code: 'bad-block' }, 400)
    try {
      if (action === 'follow-ups') {
        return c.json({
          questions: await followUps(aiCtx(user, project), block.key, block.text ?? ''),
        })
      }
      if (action === 'tighten' && block.text) {
        return c.json({ text: await tighten(aiCtx(user, project), block.key, block.text) })
      }
      return c.json({ code: 'bad-action' }, 400)
    } catch (err) {
      const e = aiError(err)
      return c.json(e, e.status)
    }
  })
}

class AiUnavailable extends Error {}
