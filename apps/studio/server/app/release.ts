// Release routes (plan §13.3, §13.4; M7.3): the Admin review page, acknowledgements, the passkey
// signing ceremony, send back, production commands (freeze, unfreeze, activate) and "Waiting for
// you". Admin only: a Creator gets 403 on every route here (permission-cases.md, Roles).
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireCapability } from '../auth/roles.ts'
import { lastHeartbeat, pollAll } from '../deploy/outbox.ts'
import { createPasskeyCommand, sendAppCommand } from '../release/commands.ts'
import { afterSignature, RE_SIGN_CODES, useMail } from '../release/complete.ts'
import { markDone, openItems } from '../release/inbox.ts'
import {
  acknowledge,
  releaseChallengeFor,
  requestOf,
  reviewOf,
  sendBack,
  signingFor,
  signingView,
} from '../release/release.ts'
import {
  addSignature,
  type Fail,
  getSigning,
  requestOptions,
  type SigningRow,
  type WebAuthnDeps,
} from '../release/signing.ts'
import { targetExists, transportOf } from '../release/targets.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

type Json = Record<string, unknown>
const TARGET = /^[a-z][a-z0-9-]{0,31}$/

const idOf = (c: Context<AppEnv>, name: string) => {
  const n = Number(c.req.param(name))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => ({}))) as unknown
  return (typeof b === 'object' && b !== null && !Array.isArray(b) ? b : {}) as Json
}
const refuse = (c: Context<AppEnv>, f: Fail) => c.json({ code: f.code }, f.status)

export function releaseRoutes(app: Hono<AppEnv>, ctx: StoreContext, deps: WebAuthnDeps) {
  useMail(ctx, { appOrigin: deps.appOrigin })
  for (const path of [
    '/api/admin/review/*',
    '/api/admin/inbox',
    '/api/admin/inbox/*',
    '/api/admin/commands/*',
    '/api/admin/signing/*',
  ]) {
    app.use(path, requireCapability('publish'))
    app.use(
      path,
      bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
    )
  }

  /** Read production's outbox before showing anything that depends on it. */
  const poll = async () => {
    try {
      await pollAll(ctx)
    } catch {
      // unreachable: what was read before still shows
    }
  }

  // ---- the review page ------------------------------------------------------------------
  app.get('/api/admin/review/:requestId', async (c) => {
    const id = idOf(c, 'requestId')
    if (!id) return c.json({ code: 'not-found' }, 404)
    await poll()
    const review = await reviewOf(ctx, id)
    if (!review) return c.json({ code: 'not-found' }, 404)
    const s = review.signing
    return c.json({
      ...review,
      reSign:
        !!s &&
        (s.status === 'stale' || (s.status === 'refused' && RE_SIGN_CODES.has(s.outcome ?? ''))),
    })
  })

  app.post('/api/admin/review/:requestId/acknowledge', async (c) => {
    const id = idOf(c, 'requestId')
    if (!id) return c.json({ code: 'not-found' }, 404)
    const r = acknowledge(ctx, id, c.get('user'), await body(c))
    if (!r.ok) return refuse(c, r)
    return c.json({ ok: true, review: await reviewOf(ctx, id) })
  })

  app.post('/api/admin/review/:requestId/challenge', async (c) => {
    const id = idOf(c, 'requestId')
    if (!id) return c.json({ code: 'not-found' }, 404)
    await poll()
    const r = await releaseChallengeFor(ctx, deps, id, c.get('user'))
    if (!r.ok) return refuse(c, r)
    return c.json(r.options)
  })

  app.post('/api/admin/review/:requestId/sign', async (c) => {
    const id = idOf(c, 'requestId')
    if (!id) return c.json({ code: 'not-found' }, 404)
    if (!requestOf(ctx, id)) return c.json({ code: 'not-found' }, 404)
    const row = signingFor(ctx, id)
    if (!row) return c.json({ code: 'no-challenge' }, 409)
    const user = c.get('user')
    const added = await addSignature(ctx, deps, row, user, await body(c))
    if (!added.ok) return refuse(c, added)
    const done = await afterSignature(ctx, deps, row.id, user.handle)
    if (!done.ok)
      return c.json(
        { code: done.code, signing: signingView(ctx, getSigning(ctx, row.id)) },
        done.status,
      )
    return c.json({
      complete: added.complete,
      sent: done.delivered,
      signing: signingView(ctx, getSigning(ctx, row.id)),
    })
  })

  /** A fully signed release whose upload failed: try the upload again (no new signatures). */
  app.post('/api/admin/review/:requestId/deliver', async (c) => {
    const id = idOf(c, 'requestId')
    if (!id) return c.json({ code: 'not-found' }, 404)
    const row = signingFor(ctx, id)
    if (row?.status !== 'signed') return c.json({ code: 'not-signed' }, 409)
    const done = await afterSignature(ctx, deps, row.id, c.get('user').handle)
    if (!done.ok) return refuse(c, done)
    return c.json({ sent: done.delivered, signing: signingView(ctx, getSigning(ctx, row.id)) })
  })

  app.post('/api/admin/review/:requestId/send-back', async (c) => {
    const id = idOf(c, 'requestId')
    if (!id) return c.json({ code: 'not-found' }, 404)
    const r = sendBack(ctx, id, c.get('user'), await body(c))
    if (!r.ok) return refuse(c, r)
    return c.json({ ok: true, review: await reviewOf(ctx, id) })
  })

  // ---- Waiting for you --------------------------------------------------------------------
  app.get('/api/admin/inbox', async (c) => {
    await poll()
    return c.json({ items: openItems(ctx) })
  })

  app.post('/api/admin/inbox/:id/done', (c) => {
    const id = idOf(c, 'id')
    if (!id || !markDone(ctx, id)) return c.json({ code: 'not-found' }, 404)
    return c.json({ ok: true })
  })

  // ---- production commands ----------------------------------------------------------------
  const targetOf = (c: Context<AppEnv>) => {
    const t = c.req.param('target') ?? ''
    return TARGET.test(t) && targetExists(ctx, t) ? t : null
  }

  app.get('/api/admin/commands/:target', async (c) => {
    const target = targetOf(c)
    if (!target) return c.json({ code: 'not-found' }, 404)
    await poll()
    const rows = ctx.db
      .query(
        "select * from signing_requests where target = ? and kind = 'command' order by id desc limit 100",
      )
      .all(target) as SigningRow[]
    return c.json({
      target,
      paired: transportOf(ctx, target) !== null,
      heartbeat: lastHeartbeat(ctx, target),
      commands: rows.map((r) => ({ purpose: r.purpose, ...signingView(ctx, r) })),
    })
  })

  /** The kill switch (decisions #1, #33): the app's signature alone, so it works at once. */
  app.post('/api/admin/commands/:target/freeze', async (c) => {
    const target = targetOf(c)
    if (!target) return c.json({ code: 'not-found' }, 404)
    const r = await sendAppCommand(ctx, deps, target, 'freeze', c.get('user').handle)
    if (!r.ok) return refuse(c, r)
    return c.json({
      sent: true,
      sequence: r.sequence,
      signing: signingView(ctx, getSigning(ctx, r.id)),
    })
  })

  /** Unfreeze and activate (rollback, #35): one Admin's passkey, 24 hours to sign and send. */
  const passkeyCommand = (name: 'unfreeze' | 'activate') => async (c: Context<AppEnv>) => {
    const target = targetOf(c)
    if (!target) return c.json({ code: 'not-found' }, 404)
    if (!transportOf(ctx, target)) return c.json({ code: 'not-paired' }, 409)
    const b = await body(c)
    let args: Json | undefined
    if (name === 'activate') {
      const release = b.release
      if (!Number.isSafeInteger(release) || (release as number) < 1)
        return c.json({ code: 'bad-release' }, 400)
      args = { release }
    }
    const user = c.get('user')
    const row = await createPasskeyCommand(ctx, deps, {
      target,
      command: name,
      args,
      purpose: name,
      ref: `target:${target}`,
      needed: 1,
      who: user.handle,
    })
    return c.json(requestOptions(ctx, deps, row, user), 201)
  }
  app.post('/api/admin/commands/:target/unfreeze', passkeyCommand('unfreeze'))
  app.post('/api/admin/commands/:target/activate', passkeyCommand('activate'))

  // ---- any signing request (commands, governance, keys) ----------------------------------
  app.get('/api/admin/signing/:id', async (c) => {
    const id = idOf(c, 'id')
    const row = id ? getSigning(ctx, id) : null
    if (!row) return c.json({ code: 'not-found' }, 404)
    await poll()
    const fresh = getSigning(ctx, row.id)
    return c.json({
      purpose: row.purpose,
      ...signingView(ctx, fresh),
      options: fresh?.status === 'open' ? requestOptions(ctx, deps, fresh, c.get('user')) : null,
    })
  })

  app.post('/api/admin/signing/:id/sign', async (c) => {
    const id = idOf(c, 'id')
    const row = id ? getSigning(ctx, id) : null
    if (!row) return c.json({ code: 'not-found' }, 404)
    // Releases are signed on their review page, which checks the request first.
    if (row.kind === 'release') return c.json({ code: 'use-review' }, 409)
    const user = c.get('user')
    const added = await addSignature(ctx, deps, row, user, await body(c))
    if (!added.ok) return refuse(c, added)
    const done = await afterSignature(ctx, deps, row.id, user.handle)
    if (!done.ok)
      return c.json(
        { code: done.code, signing: signingView(ctx, getSigning(ctx, row.id)) },
        done.status,
      )
    return c.json({
      complete: added.complete,
      sent: done.delivered,
      signing: signingView(ctx, getSigning(ctx, row.id)),
    })
  })

  app.post('/api/admin/signing/:id/deliver', async (c) => {
    const id = idOf(c, 'id')
    const row = id ? getSigning(ctx, id) : null
    if (!row || row.kind === 'release') return c.json({ code: 'not-found' }, 404)
    if (row.status !== 'signed') return c.json({ code: 'not-signed' }, 409)
    const done = await afterSignature(ctx, deps, row.id, c.get('user').handle)
    if (!done.ok) return refuse(c, done)
    return c.json({ sent: done.delivered, signing: signingView(ctx, getSigning(ctx, row.id)) })
  })
}
