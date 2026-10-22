// The setup checklist (plan §22.2), the Projects overview and Project settings (§16.6); M8.4.
// Admin only. Every checklist item is computed from real state, never ticked by hand.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readTarget } from '../backup/service.ts'
import { ALL_CHECKS, FLOOR_CHECKS, levels } from '../checks/checks.ts'
import { audit } from '../governance/audit.ts'
import { currentPolicy, POLICY_PARTS } from '../governance/policy.ts'
import {
  type ProjectSettings,
  projectSettingsKey,
  readProjectSettings,
} from '../governance/project-settings.ts'
import { getMailSettings } from '../mail/settings.ts'
import { currentRevision, type StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

const one = (ctx: StoreContext, sql: string, ...args: (string | number)[]) =>
  ctx.db.query(sql).get(...args) as Record<string, unknown> | null

export type SetupItem = { id: string; done: boolean; link: string }

export function setupChecklist(ctx: StoreContext): SetupItem[] {
  const has = (sql: string) => !!one(ctx, sql)
  const lastBackup = (() => {
    const v = one(ctx, "select value from settings where key = 'backup_last_result'")
    try {
      return !!v && (JSON.parse(v.value as string) as { ok: boolean }).ok === true
    } catch {
      return false
    }
  })()
  return [
    {
      id: 'admin-passkey',
      done: has(
        "select 1 from passkeys p join users u on u.id = p.user_id where u.role = 'admin' and p.removed_at is null limit 1",
      ),
      link: '/admin/users',
    },
    {
      id: 'model-endpoint-tested',
      done: has('select 1 from model_endpoints where last_test_ok = 1 limit 1'),
      link: '/admin/models',
    },
    { id: 'mail', done: getMailSettings(ctx) !== null, link: '/admin/mail' },
    {
      id: 'production-paired',
      done: has("select 1 from deploy_targets where status = 'paired' limit 1"),
      link: '/admin/deployment',
    },
    {
      id: 'certificate',
      done: has("select 1 from cert_issues where status = 'issued' limit 1"),
      link: '/admin/deployment',
    },
    { id: 'backup-target', done: readTarget(ctx.db) !== null, link: '/admin/backups' },
    { id: 'backup-run', done: lastBackup, link: '/admin/backups' },
    {
      id: 'guide-version',
      done: has('select 1 from guide_versions where n > 1 limit 1'),
      link: '/brand',
    },
  ]
}

// --- project settings (§16.6): only what the plan describes ----------------------------------

const LEVEL_RANK = { off: 0, warn: 1, block: 2 } as const
type Lvl = keyof typeof LEVEL_RANK
const key = projectSettingsKey

const readSettings = readProjectSettings

class Bad extends Error {}

function parseSettings(ctx: StoreContext, input: Record<string, unknown>, cur: ProjectSettings) {
  const out = { ...cur }
  if (input.structureNeedsAdmin !== undefined) {
    if (typeof input.structureNeedsAdmin !== 'boolean') throw new Bad('structureNeedsAdmin')
    out.structureNeedsAdmin = input.structureNeedsAdmin
  }
  if (input.twoPerson !== undefined) {
    const t = input.twoPerson as Record<string, unknown> | null
    if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new Bad('twoPerson')
    const install = currentPolicy(ctx)
    const next: ProjectSettings['twoPerson'] = {}
    for (const [k, v] of Object.entries(t)) {
      if (!(POLICY_PARTS as string[]).includes(k) || (v !== 1 && v !== 2))
        throw new Bad('twoPerson')
      const part = k as keyof typeof install
      if (v < install[part]) throw new Bad('looser-than-install')
      next[part] = v
    }
    out.twoPerson = next
  }
  if (input.checks !== undefined) {
    const t = input.checks as Record<string, unknown> | null
    if (typeof t !== 'object' || t === null || Array.isArray(t)) throw new Bad('checks')
    const install = levels(ctx)
    const next: ProjectSettings['checks'] = {}
    for (const [id, v] of Object.entries(t)) {
      if (!ALL_CHECKS.includes(id) || (v !== 'warn' && v !== 'block')) throw new Bad('checks')
      // The floor is block everywhere already; a project can only go up from the install's level.
      if (FLOOR_CHECKS.includes(id)) continue
      const base = (install[id] ?? 'block') as Lvl
      if (LEVEL_RANK[v] < LEVEL_RANK[base]) throw new Bad('looser-than-install')
      next[id] = v
    }
    out.checks = next
  }
  return out
}

export function setupRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
  const admin = (c: Context<AppEnv>) =>
    c.get('user').role === 'admin' ? null : (c.json({ code: 'forbidden' }, 403) as Response)

  app.get('/api/admin/setup', (c) => admin(c) ?? c.json({ items: setupChecklist(ctx) }))

  app.get('/api/admin/projects', (c) => {
    const no = admin(c)
    if (no) return no
    const rows = ctx.db.query('select id, name, approved from projects order by id').all() as {
      id: string
      name: string
      approved: string | null
    }[]
    return c.json({
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        members: ctx.db
          .query(
            'select u.handle, u.name from members m join users u on u.id = m.user_id where m.project_id = ? order by u.handle',
          )
          .all(p.id),
        lastRevision: currentRevision(ctx.dataDir, p.id),
        approved: p.approved,
        staged: (one(ctx, 'select rev from staged where project_id = ?', p.id)?.rev ?? null) as
          | string
          | null,
        published: (one(
          ctx,
          "select rev from publication_requests where project_id = ? and status = 'published' order by id desc limit 1",
          p.id,
        )?.rev ?? null) as string | null,
      })),
    })
  })

  app.use(
    '/api/p/:project/settings',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  const view = (project: string) => ({
    project,
    members: ctx.db
      .query(
        'select u.handle, u.name, u.role from members m join users u on u.id = m.user_id where m.project_id = ? order by u.handle',
      )
      .all(project),
    install: { twoPerson: currentPolicy(ctx), checks: levels(ctx) },
    settings: readSettings(ctx, project),
  })

  app.get('/api/p/:project/settings', (c) => {
    const no = admin(c)
    if (no) return no
    const project = c.req.param('project')
    if (!one(ctx, 'select 1 from projects where id = ?', project))
      return c.json({ code: 'not-found' }, 404)
    return c.json(view(project))
  })

  app.put('/api/p/:project/settings', async (c) => {
    const no = admin(c)
    if (no) return no
    const project = c.req.param('project')
    if (!one(ctx, 'select 1 from projects where id = ?', project))
      return c.json({ code: 'not-found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const next = parseSettings(ctx, b, readSettings(ctx, project))
      let handles: string[] | undefined
      if (b.members !== undefined) {
        if (!Array.isArray(b.members) || b.members.some((h) => typeof h !== 'string'))
          throw new Bad('members')
        handles = b.members as string[]
        for (const h of handles)
          if (!one(ctx, 'select 1 from users where handle = ?', h)) throw new Bad('unknown-member')
      }
      ctx.db.transaction(() => {
        ctx.db
          .query(
            'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
          )
          .run(key(project), JSON.stringify(next))
        if (handles) {
          ctx.db.query('delete from members where project_id = ?').run(project)
          for (const h of handles)
            ctx.db
              .query(
                'insert or ignore into members (project_id, user_id) select ?, id from users where handle = ?',
              )
              .run(project, h)
        }
      })()
      audit(ctx, c.get('user').handle, 'project-settings.changed', { project, ...b })
      return c.json(view(project))
    } catch (e) {
      if (e instanceof Bad) return c.json({ code: 'bad-input', message: e.message }, 400)
      throw e
    }
  })
}
