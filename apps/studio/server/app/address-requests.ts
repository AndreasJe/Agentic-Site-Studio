// "Send request now" and certificate-name suggestions (decision 22 Oct #7 and #8).
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { listAddressRequests } from '../deploy/address.ts'
import { SendRequestError, sendAddressRequest } from '../deploy/address-requests.ts'
import { certificateSuggestions } from '../deploy/suggestions.ts'
import type { StoreContext } from '../store/revisions.ts'
import { type Structure, validateStructure } from '../structure/structure.ts'
import { canSee, readDraftFile } from './access.ts'
import type { AppEnv } from './projects.ts'

export function addressRequestRoutes(app: Hono<AppEnv>, ctx: StoreContext) {
  app.use(
    '/api/p/:project/address-requests/send',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  // The request goes to the Admin at once. It is stored beside the project, not in the draft.
  app.post('/api/p/:project/address-requests/send', async (c: Context<AppEnv>) => {
    const user = c.get('user')
    const project = c.req.param('project') ?? ''
    if (!canSee(ctx, user, project)) return c.json({ code: 'not-found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof b.name !== 'string' || typeof b.pageId !== 'string')
      return c.json({ code: 'bad-input', message: 'A name and a page are needed.' }, 400)
    const text = await readDraftFile(ctx, user, project, 'structure.json')
    const s: Structure | null = text ? validateStructure(JSON.parse(text)) : null
    const page = s?.pages.find((p) => p.id === b.pageId)
    if (!page) return c.json({ code: 'bad-input', message: 'No such page.' }, 400)
    try {
      sendAddressRequest(ctx, {
        project,
        name: b.name,
        pageId: page.id,
        pageTitle: page.title,
        note: typeof b.note === 'string' ? b.note : '',
        by: user.handle,
      })
    } catch (e) {
      if (e instanceof SendRequestError)
        return c.json({ code: e.code, message: e.message }, e.status)
      throw e
    }
    const mine = (await listAddressRequests(ctx, { project })).find((r) => r.name === b.name)
    return c.json({ request: mine }, 201)
  })

  // Names the target's certificate could carry, from approved addresses. Admin only.
  app.get('/api/deploy/certificate-suggestions', async (c) => {
    if (c.get('user').role !== 'admin') return c.json({ code: 'forbidden' }, 403)
    const only = c.req.query('target')
    const targets = only
      ? [only]
      : (
          ctx.db.query('select target from deploy_targets order by target').all() as {
            target: string
          }[]
        ).map((t) => t.target)
    const suggestions: Record<string, Awaited<ReturnType<typeof certificateSuggestions>>> = {}
    for (const t of targets) suggestions[t] = await certificateSuggestions(ctx, t)
    return c.json({ suggestions })
  })
}
