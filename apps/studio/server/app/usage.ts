// Usage statistics (M8.2; plan §15, decision #22). Site and project figures are the default.
// Per-person figures are visible only to that person and to Admins.
import type { Context, Hono } from 'hono'
import { requireCapability } from '../auth/roles.ts'
import { audit } from '../governance/audit.ts'
import type { StoreContext } from '../store/revisions.ts'
import { applyUsageRetention, retentionDays, setRetentionDays, usageStats } from '../usage/stats.ts'
import { canSee } from './access.ts'
import type { AppEnv } from './projects.ts'

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function usageRoutes(app: Hono<AppEnv>, ctx: StoreContext, now: () => number = Date.now) {
  const range = (c: Context<AppEnv>) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    return {
      from: from && DAY.test(from) ? from : undefined,
      to: to && DAY.test(to) ? to : undefined,
    }
  }

  app.use('/api/admin/usage', requireCapability('models'))
  app.use('/api/admin/usage/*', requireCapability('models'))

  // The whole site, optionally narrowed to one project.
  app.get('/api/admin/usage', (c) =>
    c.json({
      stats: usageStats(ctx.db, { project: c.req.query('project'), ...range(c) }),
      retentionDays: retentionDays(ctx.db),
    }),
  )

  app.get('/api/admin/usage/retention', (c) => c.json({ days: retentionDays(ctx.db) }))

  app.put('/api/admin/usage/retention', async (c) => {
    const { days } = (await c.req.json().catch(() => ({}))) as { days?: unknown }
    try {
      setRetentionDays(ctx.db, days as number)
    } catch (e) {
      return c.json({ code: 'bad-input', message: (e as Error).message }, 400)
    }
    audit(ctx, c.get('user').handle, 'usage-retention.changed', { days })
    return c.json({ days: retentionDays(ctx.db) })
  })

  // The same job the timer runs.
  app.post('/api/admin/usage/retention/run', (c) => {
    const r = applyUsageRetention(ctx.db, now)
    audit(ctx, c.get('user').handle, 'usage-retention.run', { deleted: r.deleted })
    return c.json({ result: r })
  })

  // One project, for its members and Admins. Never split by person.
  app.get('/api/p/:project/usage', (c) => {
    const project = c.req.param('project')
    if (!canSee(ctx, c.get('user'), project)) return c.json({ code: 'not-found' }, 404)
    return c.json({ stats: usageStats(ctx.db, { project, ...range(c) }) })
  })

  // One person's own figures: that person, or an Admin. Anyone else gets 403.
  app.get('/api/usage/person/:handle', (c) => {
    const user = c.get('user')
    const handle = c.req.param('handle')
    if (user.role !== 'admin' && user.handle !== handle) return c.json({ code: 'forbidden' }, 403)
    return c.json({
      handle,
      stats: usageStats(ctx.db, { user: handle, project: c.req.query('project'), ...range(c) }),
      retentionDays: retentionDays(ctx.db),
    })
  })
}
