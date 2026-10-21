// Brand and rules routes (plan §5). The guide is install-wide: everyone signed in reads, Admins
// write. Versions are write-once files; rollback is a new version (decision #45).
//
// Per-project pinning of a guide version comes later: for now every project uses the current one,
// so "affected" is simply every project.

import { validateDesign } from '@site-studio/shared/design-validate'
import { type Guide, validateGuide } from '@site-studio/shared/guide-validate'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SessionUser } from '../auth/sessions.ts'
import {
  brandDir,
  currentNumber,
  diffGuides,
  getVersion,
  listVersions,
  readGuide,
  seedGuide,
  summarise,
  writeVersion,
} from '../brand/guide.ts'
import { applyRecipe, checkLogo, colourHex, type Part } from '../brand/logo.ts'
import { listGuideProposals } from '../design/proposals.ts'
import { MediaError } from '../media/media.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

const jsonLimit = bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => c.json({ code: 'too-large' }, 413),
})
const fileLimit = bodyLimit({
  maxSize: 640 * 1024,
  onError: (c) => c.json({ code: 'too-large' }, 413),
})

const PARTIALS = ['header', 'footer'] as const

type LogoRow = { id: number; hash: string; filename: string; parts: string; at: string }

export function brandRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
  const { db, dataDir } = ctx
  seedGuide(ctx)

  const admin = (c: Context<AppEnv>): Response | null => {
    const user: SessionUser = c.get('user')
    return user.role === 'admin' ? null : c.json({ code: 'forbidden' }, 403)
  }
  const parseN = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null)
  const current = () => {
    const n = currentNumber(db)
    return { n, guide: readGuide(dataDir, n) as Guide }
  }

  // Proposals from deviations (plan §6.6). Brand and rules lists them; accepting comes later.
  app.get('/api/brand/proposals', (c) => {
    const denied = admin(c)
    if (denied) return denied
    return c.json({ proposals: listGuideProposals(ctx) })
  })

  // ---- guide versions ----

  app.get('/api/brand/guide', (c) => {
    const { n, guide } = current()
    return c.json({ version: n, guide, meta: getVersion(db, n) })
  })

  app.get('/api/brand/guide/versions', (c) =>
    c.json({ current: currentNumber(db), versions: listVersions(db) }),
  )

  app.get('/api/brand/guide/affected', (c) =>
    c.json({
      version: currentNumber(db),
      projects: db.query('select id, name from projects order by name').all(),
    }),
  )

  app.get('/api/brand/guide/v/:n', (c) => {
    const n = parseN(c.req.param('n'))
    const guide = n === null ? null : readGuide(dataDir, n)
    if (n === null || !guide) return c.json({ code: 'not-found' }, 404)
    return c.json({ version: n, guide, meta: getVersion(db, n) })
  })

  app.post('/api/brand/guide', jsonLimit, async (c) => {
    const no = admin(c)
    if (no) return no
    const body = (await c.req.json().catch(() => ({}))) as { guide?: unknown; basedOn?: unknown }
    if (!Number.isInteger(body.basedOn)) return c.json({ code: 'bad-based-on' }, 400)
    const now = current()
    if (body.basedOn !== now.n) return c.json({ code: 'stale', current: now.n }, 409)
    const check = validateGuide(body.guide)
    if (!check.ok)
      return c.json(
        { code: 'invalid-guide', errors: check.errors, mismatches: check.mismatches },
        422,
      )
    const next = body.guide as Guide
    const overview = diffGuides(now.guide, next)
    if (overview.empty) return c.json({ code: 'no-changes' }, 422)
    const version = writeVersion(ctx, next, c.get('user').id, summarise(overview), now.n)
    return c.json({ version, guide: readGuide(dataDir, version.n), overview }, 201)
  })

  // Rollback is a new version that copies an old one; nothing is removed.
  app.post('/api/brand/guide/rollback/:n', jsonLimit, (c) => {
    const no = admin(c)
    if (no) return no
    const n = parseN(c.req.param('n'))
    const old = n === null ? null : readGuide(dataDir, n)
    if (n === null || !old) return c.json({ code: 'not-found' }, 404)
    const now = current()
    const overview = diffGuides(now.guide, old)
    const version = writeVersion(ctx, old, c.get('user').id, `Rolled back to v${n}`, now.n)
    return c.json({ version, guide: readGuide(dataDir, version.n), overview }, 201)
  })

  // ---- the logo ----

  const recipeOf = (logoId: number): Record<string, string> => {
    const r = db
      .query('select recipe from brand_logo_recipes where logo_id = ? order by id desc limit 1')
      .get(logoId) as { recipe: string } | null
    return r ? JSON.parse(r.recipe) : {}
  }
  const logoItem = (r: LogoRow) => ({
    id: r.id,
    hash: r.hash,
    filename: r.filename,
    at: r.at,
    parts: JSON.parse(r.parts) as Part[],
    recipe: recipeOf(r.id),
  })
  const findLogo = (id: string | undefined) => {
    const n = parseN(id)
    return n === null
      ? null
      : (db.query('select * from brand_logos where id = ?').get(n) as LogoRow | null)
  }
  const svgHeaders = {
    'content-type': 'image/svg+xml',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'private, max-age=0, must-revalidate',
  }

  app.get('/api/brand/logo', (c) => {
    const r = db.query('select * from brand_logos order by id desc limit 1').get() as LogoRow | null
    return c.json({ logo: r ? logoItem(r) : null })
  })

  app.post('/api/brand/logo', fileLimit, async (c) => {
    const no = admin(c)
    if (no) return no
    try {
      const form = await c.req.formData().catch(() => null)
      const file = form?.get('file')
      if (!form || !(file instanceof File)) return c.json({ code: 'file-required' }, 400)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { parts } = checkLogo(bytes)
      const hash = await putBlob(brandDir(dataDir), bytes)
      const row = db
        .query(
          'insert into brand_logos (hash, filename, parts, by_user, at) values (?, ?, ?, ?, ?) returning *',
        )
        .get(
          hash,
          file.name.slice(0, 200),
          JSON.stringify(parts),
          c.get('user').id,
          new Date().toISOString(),
        ) as LogoRow
      return c.json({ logo: logoItem(row) }, 201)
    } catch (err) {
      if (err instanceof MediaError)
        return c.json({ code: err.code, message: err.message }, err.status)
      throw err
    }
  })

  app.get('/api/brand/logo/:id/file', async (c) => {
    const r = findLogo(c.req.param('id'))
    if (!r) return c.json({ code: 'not-found' }, 404)
    const bytes = await getBlob(brandDir(dataDir), r.hash)
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: { ...svgHeaders, etag: `"${r.hash}"` },
    })
  })

  // The logo as the saved recipe recolours it, with the current guide's colours.
  app.get('/api/brand/logo/:id/preview', async (c) => {
    const r = findLogo(c.req.param('id'))
    if (!r) return c.json({ code: 'not-found' }, 404)
    const text = new TextDecoder().decode(await getBlob(brandDir(dataDir), r.hash))
    return new Response(applyRecipe(text, recipeOf(r.id), current().guide), { headers: svgHeaders })
  })

  app.put('/api/brand/logo/:id/recipe', jsonLimit, async (c) => {
    const no = admin(c)
    if (no) return no
    const r = findLogo(c.req.param('id'))
    if (!r) return c.json({ code: 'not-found' }, 404)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const input = (body && typeof body.recipe === 'object' ? body.recipe : body) as Record<
      string,
      unknown
    > | null
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return c.json({ code: 'bad-recipe' }, 422)
    const parts = JSON.parse(r.parts) as Part[]
    const guide = current().guide
    const recipe: Record<string, string> = {}
    for (const [k, v] of Object.entries(input)) {
      if (!/^\d+$/.test(k) || Number(k) >= parts.length)
        return c.json({ code: 'bad-part', part: k }, 422)
      if (typeof v !== 'string' || !colourHex(guide, v))
        return c.json({ code: 'colour-not-in-guide', part: k }, 422)
      recipe[k] = v
    }
    db.query(
      'insert into brand_logo_recipes (logo_id, recipe, by_user, at) values (?, ?, ?, ?)',
    ).run(r.id, JSON.stringify(recipe), c.get('user').id, new Date().toISOString())
    return c.json({ logo: logoItem(r) })
  })

  // ---- header and footer partials (plan §5.5, decision #45) ----
  // The first <nav> of the header receives the main menu on export. Admins only, read and write.

  const versionsOf = (name: string) =>
    db
      .query(
        `select p.n, u.handle as by, p.at from brand_partials p join users u on u.id = p.by_user
         where p.name = ? order by p.n desc`,
      )
      .all(name) as { n: number; by: string; at: string }[]

  app.get('/api/brand/partials/:name', async (c) => {
    const no = admin(c)
    if (no) return no
    const name = c.req.param('name') as (typeof PARTIALS)[number]
    if (!PARTIALS.includes(name)) return c.json({ code: 'not-found' }, 404)
    const versions = versionsOf(name)
    const want =
      c.req.query('v') === undefined ? (versions[0]?.n ?? null) : parseN(c.req.query('v'))
    const row =
      want === null
        ? null
        : (db.query('select hash from brand_partials where name = ? and n = ?').get(name, want) as {
            hash: string
          } | null)
    if (want !== null && !row) return c.json({ code: 'not-found' }, 404)
    const html = row ? new TextDecoder().decode(await getBlob(brandDir(dataDir), row.hash)) : ''
    return c.json({ name, version: want, html, versions })
  })

  app.put('/api/brand/partials/:name', jsonLimit, async (c) => {
    const no = admin(c)
    if (no) return no
    const name = c.req.param('name') as (typeof PARTIALS)[number]
    if (!PARTIALS.includes(name)) return c.json({ code: 'not-found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { html?: unknown }
    if (typeof body.html !== 'string' || !body.html.trim())
      return c.json({ code: 'html-required' }, 400)
    const result = validateDesign({ html: body.html }, current().guide)
    if (result.errors.length)
      return c.json(
        { code: 'invalid-design', errors: result.errors, warnings: result.warnings },
        422,
      )
    if (name === 'header' && !/<nav[\s>]/i.test(body.html.replace(/<!--[\s\S]*?-->/g, '')))
      return c.json({ code: 'no-nav' }, 422)
    const hash = await putBlob(brandDir(dataDir), new TextEncoder().encode(body.html))
    const n = (versionsOf(name)[0]?.n ?? 0) + 1
    db.query('insert into brand_partials (name, n, hash, by_user, at) values (?, ?, ?, ?, ?)').run(
      name,
      n,
      hash,
      c.get('user').id,
      new Date().toISOString(),
    )
    return c.json({ name, version: n, warnings: result.warnings, versions: versionsOf(name) }, 201)
  })
}
