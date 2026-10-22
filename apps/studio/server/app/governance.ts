// Governance and Admin keys (plan §13.8–§13.9, §16.3–§16.4; M7.4). Every change waits for Admin
// passkeys under the CURRENT rule and is audited; signing goes through /api/admin/signing/:id.
// Admin only: a Creator gets 403 on every route here.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireCapability } from '../auth/roles.ts'
import { recentAudit } from '../governance/audit.ts'
import { POLICY_REF, startPolicyChange } from '../governance/change.ts'
import {
  beginAddKey,
  finishAddKey,
  listKeys,
  startApproveKey,
  startRemoveKey,
} from '../governance/keys.ts'
import {
  currentPolicy,
  PRESETS,
  type PresetName,
  parsePolicy,
  presetOf,
  strictest,
} from '../governance/policy.ts'
import { beginStepUp, finishStepUp } from '../governance/stepup.ts'
import { signingView } from '../release/release.ts'
import type { Fail, SigningRow, WebAuthnDeps } from '../release/signing.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

type Json = Record<string, unknown>
const KEY_ID = /^[A-Za-z0-9_-]{1,1024}$/

const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => ({}))) as unknown
  return (typeof b === 'object' && b !== null && !Array.isArray(b) ? b : {}) as Json
}
const refuse = (c: Context<AppEnv>, f: Fail) => c.json({ code: f.code }, f.status)

export function governanceRoutes(app: Hono<AppEnv>, ctx: StoreContext, deps: WebAuthnDeps) {
  for (const path of [
    '/api/admin/governance',
    '/api/admin/governance/*',
    '/api/admin/audit',
    '/api/admin/keys',
    '/api/admin/keys/*',
  ]) {
    app.use(path, requireCapability('governance'))
    app.use(
      path,
      bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
    )
  }

  const pending = (ref: string) =>
    ctx.db
      .query(
        "select * from signing_requests where ref = ? and status in ('open', 'signed', 'sent') order by id desc limit 1",
      )
      .get(ref) as SigningRow | null

  app.get('/api/admin/governance', (c) => {
    const policy = currentPolicy(ctx)
    const p = pending(POLICY_REF)
    return c.json({
      policy,
      preset: presetOf(policy),
      presets: PRESETS,
      newAdminNeeds: strictest(policy),
      pending: p ? { effect: JSON.parse(p.effect) as unknown, ...signingView(ctx, p) } : null,
    })
  })

  /** `{ preset }` or `{ policy }`: starts the change; the response is the passkey request. */
  app.post('/api/admin/governance/policy', async (c) => {
    const b = await body(c)
    const to =
      typeof b.preset === 'string' && Object.hasOwn(PRESETS, b.preset)
        ? { ...PRESETS[b.preset as PresetName] }
        : parsePolicy(b.policy)
    if (!to) return c.json({ code: 'bad-policy' }, 400)
    const r = await startPolicyChange(ctx, deps, c.get('user'), to)
    if (!r.ok) return refuse(c, r)
    return c.json(r.options, 201)
  })

  app.get('/api/admin/audit', (c) => {
    const limit = Number(c.req.query('limit') ?? 200)
    return c.json({ entries: recentAudit(ctx, Number.isSafeInteger(limit) ? limit : 200) })
  })

  // ---- keys -------------------------------------------------------------------------------
  app.get('/api/admin/keys', (c) => {
    const policy = currentPolicy(ctx)
    return c.json({ keys: listKeys(ctx), keyRule: policy.keys, newAdminNeeds: strictest(policy) })
  })

  /** Adding your own device (#28): register it here, then approve it like any key. */
  // A stolen session must not be able to add a device of its own: adding one needs a fresh
  // assertion by one of the Admin's approved keys first.
  app.post('/api/admin/keys/register/options', async (c) => {
    const user = c.get('user')
    const b = await body(c)
    const change = { action: 'add-key' }
    if (b.stepUp === undefined) {
      return c.json(
        { code: 'step-up-required', stepUp: await beginStepUp(ctx, deps, user, change) },
        428,
      )
    }
    const ok = await finishStepUp(ctx, deps, user, change, b.stepUp)
    if (!ok.ok) return c.json({ code: ok.code }, 403)
    return c.json(beginAddKey(ctx, deps, user))
  })

  app.post('/api/admin/keys/register', async (c) => {
    const r = await finishAddKey(ctx, deps, c.get('user'), await body(c))
    if (!r.ok) return refuse(c, r)
    return c.json({ keyId: r.keyId, status: 'waiting' }, 201)
  })

  app.post('/api/admin/keys/:keyId/approve', async (c) => {
    const keyId = c.req.param('keyId')
    if (!KEY_ID.test(keyId)) return c.json({ code: 'not-found' }, 404)
    const r = await startApproveKey(ctx, deps, c.get('user'), keyId)
    if (!r.ok) return refuse(c, r)
    return c.json(r.options, 201)
  })

  app.post('/api/admin/keys/:keyId/remove', async (c) => {
    const keyId = c.req.param('keyId')
    if (!KEY_ID.test(keyId)) return c.json({ code: 'not-found' }, 404)
    const r = await startRemoveKey(ctx, deps, c.get('user'), keyId)
    if (!r.ok) return refuse(c, r)
    return c.json(r.options, 201)
  })
}
