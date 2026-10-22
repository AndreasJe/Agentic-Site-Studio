// Model endpoints and roles (M8.2; plan §15, decision #36). Admin only. No response carries an
// API key; `keySet` says whether one is stored.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireCapability } from '../auth/roles.ts'
import { audit } from '../governance/audit.ts'
import type { Endpoint } from '../llm/llm.ts'
import {
  addEndpoint,
  checkEndpointSave,
  deleteEndpoint,
  isRole,
  listEndpoints,
  MODEL_ROLES,
  ModelError,
  roleMap,
  setRole,
  testEndpoint,
  updateEndpoint,
} from '../models/models.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

type Body = Record<string, unknown>
const STATUS: Record<string, 400 | 404 | 409> = {
  'bad-input': 400,
  'not-found': 404,
  'name-taken': 409,
  'blocked-host': 400,
}

export function modelRoutes(
  app: Hono<AppEnv>,
  ctx: StoreContext,
  fallback?: Endpoint,
  opts: { localModelHosts?: boolean } = {},
) {
  // The .env endpoint may be a local one; Test connection may call its origin.
  const trustedOrigin = fallback ? new URL(fallback.baseUrl).origin : undefined
  // The same host rule when an endpoint is saved (decision #50, item 13).
  const hosts = { trustedOrigin, localHosts: opts.localModelHosts === true }
  const body = async (c: Context<AppEnv>) => {
    const b = (await c.req.json().catch(() => ({}))) as unknown
    return (typeof b === 'object' && b !== null && !Array.isArray(b) ? b : {}) as Body
  }
  const fail = (c: Context<AppEnv>, e: unknown) => {
    if (e instanceof ModelError)
      return c.json({ code: e.code, message: e.message }, STATUS[e.code] ?? 400)
    throw e
  }
  const id = (c: Context<AppEnv>) => {
    const n = Number(c.req.param('id'))
    return Number.isInteger(n) && n > 0 ? n : 0
  }

  app.use('/api/admin/models', requireCapability('models'))
  app.use('/api/admin/models/*', requireCapability('models'))
  app.use(
    '/api/admin/models/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  app.get('/api/admin/models', (c) =>
    c.json({
      endpoints: listEndpoints(ctx),
      roles: roleMap(ctx),
      roleNames: MODEL_ROLES,
      // The .env endpoint, shown as the default until an Admin adds one. Without its key.
      fallback: fallback
        ? {
            name: fallback.name,
            baseUrl: fallback.baseUrl,
            model: fallback.model,
            capability: fallback.capability,
            keySet: fallback.apiKey !== '',
          }
        : null,
    }),
  )

  app.post('/api/admin/models', async (c) => {
    try {
      const b = await body(c)
      await checkEndpointSave(ctx, null, b, hosts)
      const e = addEndpoint(ctx, b, c.get('user').handle)
      audit(ctx, c.get('user').handle, 'model-endpoint.added', { id: e.id, name: e.name })
      return c.json({ endpoint: e }, 201)
    } catch (err) {
      return fail(c, err)
    }
  })

  // Roles before :id so "roles" is never read as an id.
  app.put('/api/admin/models/roles', async (c) => {
    const b = await body(c)
    try {
      const entries = Object.entries(b)
      for (const [role, endpointId] of entries) {
        if (!isRole(role)) throw new ModelError('bad-input', `Unknown role ${role}.`)
        if (endpointId !== null && !(Number.isInteger(endpointId) && (endpointId as number) > 0))
          throw new ModelError('bad-input', 'An endpoint is an id, or null for the default.')
      }
      ctx.db.transaction(() => {
        for (const [role, endpointId] of entries)
          setRole(ctx, role as never, endpointId as number | null)
      })()
      audit(ctx, c.get('user').handle, 'model-roles.changed', { roles: b })
      return c.json({ roles: roleMap(ctx) })
    } catch (err) {
      return fail(c, err)
    }
  })

  app.put('/api/admin/models/:id', async (c) => {
    try {
      const b = await body(c)
      await checkEndpointSave(ctx, id(c), b, hosts)
      const e = updateEndpoint(ctx, id(c), b)
      audit(ctx, c.get('user').handle, 'model-endpoint.changed', { id: e.id, name: e.name })
      return c.json({ endpoint: e })
    } catch (err) {
      return fail(c, err)
    }
  })

  app.delete('/api/admin/models/:id', (c) => {
    try {
      deleteEndpoint(ctx, id(c))
      audit(ctx, c.get('user').handle, 'model-endpoint.removed', { id: id(c) })
      return c.json({ ok: true })
    } catch (err) {
      return fail(c, err)
    }
  })

  app.post('/api/admin/models/:id/test', async (c) => {
    try {
      return c.json({
        result: await testEndpoint(ctx, id(c), {
          signal: c.req.raw.signal,
          ...hosts,
        }),
      })
    } catch (err) {
      return fail(c, err)
    }
  })
}
