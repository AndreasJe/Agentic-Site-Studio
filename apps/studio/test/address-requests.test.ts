// Decision 22 Oct #7 and #8: "Send request now" (outside the private draft), de-duplicated with a
// request saved in a revision, and certificate-name suggestions from approved addresses.
import { afterEach, describe, expect, test } from 'bun:test'
import { type World, world } from './helpers/deploy-world.ts'
import { withStepUp } from './helpers/step-up.ts'

let w: World

/** Approving an address needs the Admin's passkey step-up (decision #50, item 5). */
const stepped = async (path: string) =>
  withStepUp(w.as('admina').call, await w.addPasskey('admina'), path)
afterEach(async () => {
  await w?.cleanup()
})

async function project(name: string, user: string) {
  const me = w.as(user)
  expect((await me.call('POST', '/api/projects', { name })).status).toBe(201)
  const added = await me.call('POST', `/api/p/${name}/structure/add-page`, {
    title: 'Offer',
    slug: 'offer',
    type: 'landing',
  })
  return { me, pageId: added.body.id as string }
}

const openInbox = () =>
  (
    w.db
      .query("select ref from inbox_items where kind = 'address-request' and done_at is null")
      .all() as { ref: string }[]
  ).map((r) => r.ref)

describe('send request now', () => {
  test('the Admin sees it at once, with no saved revision; the draft is untouched', async () => {
    w = await world({ agent: false })
    const { me, pageId } = await project('go', 'alex')
    const sent = await me.call('POST', '/api/p/go/address-requests/send', {
      name: 'promo',
      pageId,
      note: 'For the launch',
    })
    expect(sent.status).toBe(201)
    expect(sent.body.request).toMatchObject({ id: 'go/promo', status: 'pending', sentNow: true })
    // Not written into the draft's structure.
    const s = await me.call('GET', '/api/p/go/structure')
    expect(s.body.structure.addressRequests).toEqual([])

    const admin = w.as('admina')
    const list = await admin.call('GET', '/api/admin/addresses?status=pending')
    expect(list.body.requests).toHaveLength(1)
    expect(list.body.requests[0]).toMatchObject({
      id: 'go/promo',
      name: 'promo',
      pageTitle: 'Offer',
      note: 'For the launch',
      by: 'alex',
      revision: '',
      sentNow: true,
    })
    // It is in "Waiting for you", and approving it closes that item.
    expect(openInbox()).toEqual(['go/promo'])
    const ok = await stepped('/api/admin/addresses/go/promo/approve')
    expect(ok.status).toBe(200)
    expect(openInbox()).toEqual([])
    expect((await me.call('GET', '/api/p/go/address-requests')).body.requests[0]).toMatchObject({
      status: 'approved',
    })
  })

  test('the name rules are unchanged', async () => {
    w = await world({ agent: false })
    const { me, pageId } = await project('go', 'alex')
    for (const name of ['Promo', 'ab--c', 'www', '-x', 'x'.repeat(64)]) {
      const r = await me.call('POST', '/api/p/go/address-requests/send', { name, pageId })
      expect({ name, status: r.status, code: r.body.code }).toEqual({
        name,
        status: 400,
        code: 'bad-name',
      })
    }
    expect(
      (await me.call('POST', '/api/p/go/address-requests/send', { name: 'ok', pageId: 'nope' }))
        .status,
    ).toBe(400)
    expect(w.db.query('select count(*) as n from address_requests').get()).toEqual({ n: 0 })
  })

  test('the same name twice is refused; an approved name elsewhere is taken', async () => {
    w = await world({ agent: false })
    const a = await project('go', 'alex')
    const send = (x: typeof a, name: string) =>
      x.me.call('POST', '/api/p/go/address-requests/send', { name, pageId: x.pageId })
    expect((await send(a, 'promo')).status).toBe(201)
    expect((await send(a, 'promo')).body.code).toBe('already-sent')
    await stepped('/api/admin/addresses/go/promo/approve')
    const b = await project('other', 'alex')
    const r = await b.me.call('POST', '/api/p/other/address-requests/send', {
      name: 'promo',
      pageId: b.pageId,
    })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('name-taken')
  })

  test('a request saved with a revision still works, and the same name is one request', async () => {
    w = await world({ agent: false })
    const { me, pageId } = await project('go', 'alex')
    // In the draft, then also sent now, then saved: one request.
    await me.call('POST', '/api/p/go/structure/request-address', {
      name: 'promo',
      pageId,
      note: 'draft note',
    })
    await me.call('POST', '/api/p/go/address-requests/send', {
      name: 'promo',
      pageId,
      note: 'sent note',
    })
    await me.call('POST', '/api/p/go/structure/request-address', { name: 'only-saved', pageId })
    expect((await me.call('POST', '/api/p/go/draft/save', { msg: 'Saved' })).status).toBe(200)
    const admin = w.as('admina')
    const list = (await admin.call('GET', '/api/admin/addresses')).body.requests as {
      name: string
      note: string
      sentNow: boolean
      revision: string
    }[]
    expect(list.map((r) => r.name)).toEqual(['only-saved', 'promo'])
    const promo = list.find((r) => r.name === 'promo')
    expect(promo).toMatchObject({ note: 'sent note', sentNow: true })
    expect(promo?.revision).not.toBe('')
    expect(list.find((r) => r.name === 'only-saved')).toMatchObject({ sentNow: false })
    // Approved once: the decision answers both.
    expect((await stepped('/api/admin/addresses/go/promo/approve')).status).toBe(200)
    expect(
      (await admin.call('GET', '/api/admin/addresses?status=pending')).body.requests,
    ).toHaveLength(1)
  })

  test('only members can send, and a Creator cannot read the Admin list', async () => {
    w = await world({ agent: false })
    const { me, pageId } = await project('go', 'alex')
    const r = await w.as('rune').call('POST', '/api/p/go/address-requests/send', {
      name: 'promo',
      pageId,
    })
    expect(r.status).toBe(404)
    expect((await me.call('GET', '/api/admin/addresses')).status).toBe(403)
  })
})

describe('certificate-name suggestions', () => {
  async function approved(names: string[]) {
    const { me, pageId } = await project('go', 'alex')
    const admin = w.as('admina')
    for (const name of names) {
      await me.call('POST', '/api/p/go/address-requests/send', { name, pageId })
      await stepped(`/api/admin/addresses/go/${name}/approve`)
    }
    return { me, admin, pageId }
  }
  const setTarget = (domains: string[]) =>
    w.db
      .query(
        "insert or replace into deploy_targets (target, kind, host, port, username, inbox_dir, outbox_dir, domains, status, created_at, updated_at) values ('production', 'sftp', 'h', 22, 'u', 'in', 'out', ?, 'connecting', 'x', 'x')",
      )
      .run(JSON.stringify(domains))

  test('approved addresses are suggested per target, never added automatically', async () => {
    w = await world({ agent: false })
    const { admin } = await approved(['promo'])
    setTarget(['www.example.com'])
    const r = await admin.call('GET', '/api/deploy/certificate-suggestions')
    expect(r.status).toBe(200)
    expect(r.body.suggestions.production).toEqual([
      { name: 'promo', project: 'go', domain: 'promo.example.com' },
    ])
    const t = w.db
      .query("select domains from deploy_targets where target = 'production'")
      .get() as {
      domains: string
    }
    expect(JSON.parse(t.domains)).toEqual(['www.example.com'])
  })

  test('a name already on the certificate, or under its wildcard, is not suggested', async () => {
    w = await world({ agent: false })
    const { admin } = await approved(['promo', 'shop'])
    setTarget(['example.com', 'promo.example.com'])
    const some = await admin.call('GET', '/api/deploy/certificate-suggestions?target=production')
    expect(some.body.suggestions.production.map((s: { domain: string }) => s.domain)).toEqual([
      'shop.example.com',
    ])
    setTarget(['*.example.com'])
    const none = await admin.call('GET', '/api/deploy/certificate-suggestions?target=production')
    expect(none.body.suggestions.production).toEqual([])
  })

  test('a rejected name is not suggested; only Admins read the suggestions', async () => {
    w = await world({ agent: false })
    const { me, admin, pageId } = await approved([])
    await me.call('POST', '/api/p/go/address-requests/send', { name: 'nope', pageId })
    await admin.call('POST', '/api/admin/addresses/go/nope/reject', { note: 'No' })
    const r = await admin.call('GET', '/api/deploy/certificate-suggestions?target=production')
    expect(r.body.suggestions.production).toEqual([])
    expect((await me.call('GET', '/api/deploy/certificate-suggestions')).status).toBe(403)
  })
})
