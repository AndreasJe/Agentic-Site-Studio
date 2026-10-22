// Media library routes (plan §6.8). Two levels share one implementation:
//   /api/media            the organisation library: everyone signed in reads, Admins write
//   /api/p/:project/media the project library: members (and Admins) read and write
// Nothing is ever deleted: archive hides, replace keeps the old blob, blobs are immutable.

import { join } from 'node:path'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SessionUser } from '../auth/sessions.ts'
import {
  prepareUpload,
  expiryStatus,
  MEDIA_MAX_BYTES,
  MediaError,
  type Meta,
  parseMeta,
} from '../media/media.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'
import { canSee } from './access.ts'
import type { AppEnv } from './projects.ts'

type Row = {
  id: number
  scope: string
  title: string
  alt: string
  category: string
  subject: string
  rights: string
  allowed_use: string
  licence_expires: string | null
  hash: string
  mime: string
  size: number
  filename: string
  blocked: number
  archived: number
  created_at: string
  updated_at: string
}

const jsonLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ code: 'too-large' }, 413),
})
const fileLimit = bodyLimit({
  maxSize: MEDIA_MAX_BYTES + 64 * 1024,
  onError: (c) => c.json({ code: 'too-large' }, 413),
})

export function mediaRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
  const { db } = ctx
  const orgDir = join(ctx.dataDir, 'media')

  const item = (r: Row, detail = false) => ({
    id: r.id,
    title: r.title,
    alt: r.alt,
    category: r.category,
    subject: r.subject,
    rights: r.rights,
    allowedUse: r.allowed_use,
    licenceExpires: r.licence_expires,
    expiry: expiryStatus(r.licence_expires),
    hash: r.hash,
    mime: r.mime,
    size: r.size,
    filename: r.filename,
    blocked: !!r.blocked,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(detail
      ? {
          usedIn: (
            db.query('select ref from media_uses where media_id = ? order by ref').all(r.id) as {
              ref: string
            }[]
          ).map((u) => u.ref),
          versions: db
            .query(
              `select v.hash, v.filename, v.mime, v.size, v.at, u.handle as by
               from media_versions v join users u on u.id = v.by_user
               where v.media_id = ? order by v.id`,
            )
            .all(r.id),
        }
      : {}),
  })

  const find = (scope: string, id: string) => {
    if (!/^\d+$/.test(id)) return null
    return db
      .query('select * from media where id = ? and scope = ?')
      .get(Number(id), scope) as Row | null
  }

  /** `scope` and the blob directory for a level, or the refusal. */
  type Level = { scope: string; dir: string }
  type Guard = (c: Context<AppEnv>, write: boolean) => Level | Response

  const org: Guard = (c, write) => {
    const user: SessionUser = c.get('user')
    if (write && user.role !== 'admin') return c.json({ code: 'forbidden' }, 403)
    return { scope: 'org', dir: orgDir }
  }
  const project: Guard = (c) => {
    const id = c.req.param('project') ?? ''
    if (!canSee(ctx, c.get('user'), id)) return c.json({ code: 'not-found' }, 404)
    return { scope: `p:${id}`, dir: projectDir(ctx.dataDir, id) }
  }

  const readFile = async (c: Context<AppEnv>) => {
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!form || !(file instanceof File)) return null
    const bytes = new Uint8Array(await file.arrayBuffer())
    // Metadata (GPS, camera, author) is stripped before anything is stored (decision #22, M8).
    const ready = prepareUpload(bytes)
    return { form, file, bytes: ready.bytes, mime: ready.mime }
  }

  const fail = (c: Context<AppEnv>, err: unknown) => {
    if (err instanceof MediaError)
      return c.json({ code: err.code, message: err.message }, err.status)
    throw err
  }

  const metaFromForm = (form: FormData) => {
    const input: Record<string, unknown> = {}
    for (const k of [
      'title',
      'alt',
      'category',
      'subject',
      'rights',
      'allowedUse',
      'licenceExpires',
    ]) {
      const v = form.get(k)
      if (typeof v === 'string') input[k] = v
    }
    return parseMeta(input)
  }

  const mount = (base: string, guard: Guard) => {
    app.get(base, (c) => {
      const lv = guard(c, false)
      if (lv instanceof Response) return lv
      const all = c.req.query('archived') === '1'
      const rows = db
        .query(
          `select * from media where scope = ? ${all ? '' : 'and archived = 0'} order by id desc`,
        )
        .all(lv.scope) as Row[]
      return c.json({ items: rows.map((r) => item(r)) })
    })

    app.post(base, fileLimit, async (c) => {
      const lv = guard(c, true)
      if (lv instanceof Response) return lv
      try {
        const up = await readFile(c)
        if (!up) return c.json({ code: 'file-required' }, 400)
        const meta = metaFromForm(up.form)
        const hash = await putBlob(lv.dir, up.bytes)
        const at = new Date().toISOString()
        const user = c.get('user')
        const row = db.transaction(() => {
          const r = db
            .query(
              `insert into media (scope, title, alt, category, subject, rights, allowed_use,
                 licence_expires, hash, mime, size, filename, created_by, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning *`,
            )
            .get(
              lv.scope,
              meta.title ?? up.file.name.replace(/\.[^.]*$/, '').slice(0, 200) ?? 'Untitled',
              meta.alt ?? '',
              meta.category ?? 'free',
              meta.subject ?? '',
              meta.rights ?? '',
              meta.allowedUse ?? '',
              meta.licenceExpires ?? null,
              hash,
              up.mime,
              up.bytes.length,
              up.file.name.slice(0, 200),
              user.id,
              at,
              at,
            ) as Row
          db.query(
            'insert into media_versions (media_id, hash, mime, size, filename, by_user, at) values (?, ?, ?, ?, ?, ?, ?)',
          ).run(r.id, hash, up.mime, up.bytes.length, r.filename, user.id, at)
          return r
        })()
        return c.json({ item: item(row, true) }, 201)
      } catch (err) {
        return fail(c, err)
      }
    })

    app.get(`${base}/:id`, (c) => {
      const lv = guard(c, false)
      if (lv instanceof Response) return lv
      const r = find(lv.scope, c.req.param('id'))
      return r ? c.json({ item: item(r, true) }) : c.json({ code: 'not-found' }, 404)
    })

    // The bytes. Served as an attachment-safe image: SVG is sandboxed so it can never run
    // script even if opened directly on the app's origin (CLAUDE.md rule 4).
    app.get(`${base}/:id/file`, async (c) => {
      const lv = guard(c, false)
      if (lv instanceof Response) return lv
      const r = find(lv.scope, c.req.param('id'))
      if (!r) return c.json({ code: 'not-found' }, 404)
      const bytes = await getBlob(lv.dir, r.hash)
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': r.mime,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cache-control': 'private, max-age=0, must-revalidate',
          etag: `"${r.hash}"`,
        },
      })
    })

    const editable = (c: Context<AppEnv>, write: true) => {
      const lv = guard(c, write)
      if (lv instanceof Response) return lv
      const r = find(lv.scope, c.req.param('id') ?? '')
      if (!r) return c.json({ code: 'not-found' }, 404)
      return { lv, r }
    }
    const touch = (id: number, set: string, ...args: unknown[]) =>
      db
        .query(`update media set ${set}, updated_at = ? where id = ? returning *`)
        .get(...(args as never[]), new Date().toISOString(), id) as Row

    app.put(`${base}/:id`, jsonLimit, async (c) => {
      const e = editable(c, true)
      if (e instanceof Response) return e
      if (e.r.archived) return c.json({ code: 'archived' }, 409)
      try {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        const m = parseMeta(body)
        const cols: Record<keyof Meta, string> = {
          title: 'title',
          alt: 'alt',
          category: 'category',
          subject: 'subject',
          rights: 'rights',
          allowedUse: 'allowed_use',
          licenceExpires: 'licence_expires',
        }
        const keys = Object.keys(m) as (keyof Meta)[]
        if (keys.length === 0) return c.json({ item: item(e.r, true) })
        const row = touch(
          e.r.id,
          keys.map((k) => `${cols[k]} = ?`).join(', '),
          ...keys.map((k) => m[k] ?? null),
        )
        return c.json({ item: item(row, true) })
      } catch (err) {
        return fail(c, err)
      }
    })

    // Replace: a new blob and a new version; the old blob stays where it is.
    app.post(`${base}/:id/replace`, fileLimit, async (c) => {
      const e = editable(c, true)
      if (e instanceof Response) return e
      if (e.r.archived) return c.json({ code: 'archived' }, 409)
      try {
        const up = await readFile(c)
        if (!up) return c.json({ code: 'file-required' }, 400)
        const hash = await putBlob(e.lv.dir, up.bytes)
        const row = db.transaction(() => {
          const r = touch(
            e.r.id,
            'hash = ?, mime = ?, size = ?, filename = ?',
            hash,
            up.mime,
            up.bytes.length,
            up.file.name.slice(0, 200),
          )
          db.query(
            'insert into media_versions (media_id, hash, mime, size, filename, by_user, at) values (?, ?, ?, ?, ?, ?, ?)',
          ).run(r.id, hash, up.mime, up.bytes.length, r.filename, c.get('user').id, r.updated_at)
          return r
        })()
        return c.json({ item: item(row, true) })
      } catch (err) {
        return fail(c, err)
      }
    })

    const flag = (name: string, column: 'blocked' | 'archived', value: 0 | 1) =>
      app.post(`${base}/:id/${name}`, jsonLimit, (c) => {
        const e = editable(c, true)
        if (e instanceof Response) return e
        return c.json({ item: item(touch(e.r.id, `${column} = ?`, value), true) })
      })
    flag('block', 'blocked', 1)
    flag('unblock', 'blocked', 0)
    flag('archive', 'archived', 1)
    flag('unarchive', 'archived', 0)
  }

  mount('/api/media', org)
  mount('/api/p/:project/media', project)
}
