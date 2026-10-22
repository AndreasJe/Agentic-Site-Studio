// M7: Admin decisions on address requests (plan §10.4) and Site settings > Languages (decision #9).
import { afterEach, describe, expect, test } from 'bun:test'
import { type World, world } from './helpers/deploy-world.ts'

let w: World
afterEach(async () => {
  await w?.cleanup()
})

async function withRequest(project: string, user: string, name: string, save = true) {
  const me = w.as(user)
  const made = await me.call('POST', '/api/projects', { name: project })
  expect(made.status).toBe(201)
  const added = await me.call('POST', `/api/p/${project}/structure/add-page`, {
    title: 'Offer',
    slug: 'offer',
    type: 'landing',
  })
  const pageId = added.body.id as string
  const req = await me.call('POST', `/api/p/${project}/structure/request-address`, {
    name,
    pageId,
    note: 'For the launch',
  })
  expect(req.status).toBe(200)
  if (save)
    expect((await me.call('POST', `/api/p/${project}/draft/save`, { msg: 'Saved' })).status).toBe(
      200,
    )
  return { me, pageId }
}

describe('address requests', () => {
  test('an Admin sees saved requests, approves with a note, and the Creator reads the answer', async () => {
    w = await world({ agent: false })
    const { me } = await withRequest('go', 'alex', 'promo')
    const admin = w.as('admina')
    const list = await admin.call('GET', '/api/admin/addresses?status=pending')
    expect(list.body.requests).toHaveLength(1)
    expect(list.body.requests[0]).toMatchObject({
      id: 'go/promo',
      project: 'go',
      name: 'promo',
      pageTitle: 'Offer',
      note: 'For the launch',
      by: 'alex',
      status: 'pending',
    })
    const ok = await admin.call('POST', '/api/admin/addresses/go/promo/approve', {
      note: 'Go ahead',
    })
    expect(ok.status).toBe(200)
    expect(ok.body.request).toMatchObject({
      status: 'approved',
      decidedBy: 'admina',
      decisionNote: 'Go ahead',
    })
    expect(
      (await admin.call('GET', '/api/admin/addresses?status=pending')).body.requests,
    ).toHaveLength(0)
    expect((await admin.call('GET', '/api/deploy/addresses')).body.addresses).toMatchObject([
      { project: 'go', name: 'promo', approvedBy: 'admina' },
    ])

    const mine = await me.call('GET', '/api/p/go/address-requests')
    expect(mine.body.requests[0]).toMatchObject({ status: 'approved', decisionNote: 'Go ahead' })
    // Answered once.
    const again = await admin.call('POST', '/api/admin/addresses/go/promo/reject', { note: 'No' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('already-decided')
    expect(JSON.stringify(w.db.query('select * from audit_log').all())).toContain(
      'address-request.approved',
    )
  })

  test('turning a request down needs a note', async () => {
    w = await world({ agent: false })
    await withRequest('go', 'alex', 'promo')
    const admin = w.as('admina')
    expect((await admin.call('POST', '/api/admin/addresses/go/promo/reject', {})).body.code).toBe(
      'note-required',
    )
    expect(
      (await admin.call('POST', '/api/admin/addresses/go/promo/reject', { note: '  ' })).status,
    ).toBe(400)
    const r = await admin.call('POST', '/api/admin/addresses/go/promo/reject', {
      note: 'Use campaign instead',
    })
    expect(r.body.request).toMatchObject({
      status: 'rejected',
      decisionNote: 'Use campaign instead',
    })
    // A turned-down name is not reserved.
    expect((await admin.call('GET', '/api/deploy/addresses')).body.addresses).toEqual([])
  })

  test('a draft request is private: the Admin sees it only once it is in a saved revision', async () => {
    w = await world({ agent: false })
    await withRequest('go', 'alex', 'promo', false)
    const admin = w.as('admina')
    expect((await admin.call('GET', '/api/admin/addresses')).body.requests).toEqual([])
    expect((await admin.call('POST', '/api/admin/addresses/go/promo/approve', {})).status).toBe(404)
  })

  test('only Admins decide; Creators cannot, and non-members cannot read the answers', async () => {
    w = await world({ agent: false })
    const { me } = await withRequest('go', 'alex', 'promo')
    for (const action of ['approve', 'reject']) {
      expect(
        (await me.call('POST', `/api/admin/addresses/go/promo/${action}`, { note: 'x' })).status,
      ).toBe(403)
    }
    expect((await me.call('GET', '/api/admin/addresses')).status).toBe(403)
    expect((await me.call('GET', '/api/deploy/addresses')).status).toBe(403)
    expect((await w.as('rune').call('GET', '/api/p/go/address-requests')).status).toBe(404)
    expect((await w.as('rune').call('GET', '/api/p/go/languages')).status).toBe(404)
  })

  test('the name rules are unchanged and checked again at approval; one name, one site', async () => {
    w = await world({ agent: false })
    const { me } = await withRequest('go', 'alex', 'promo')
    // A request that got past the screen (a hand-edited draft) with a reserved name is refused.
    const s = (await me.call('GET', '/api/p/go/structure')).body.structure
    s.addressRequests.push({
      name: 'www',
      pageId: s.pages[0].id,
      note: '',
      status: 'pending',
      by: 'alex',
      at: new Date().toISOString(),
    })
    await me.call('PUT', '/api/p/go/draft', { files: { 'structure.json': JSON.stringify(s) } })
    await me.call('POST', '/api/p/go/draft/save', { msg: 'Again' })
    const admin = w.as('admina')
    const bad = await admin.call('POST', '/api/admin/addresses/go/www/approve', {})
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('bad-name')

    // The same name asked for by two sites: the first approval wins.
    await withRequest('other', 'rune', 'promo')
    expect((await admin.call('POST', '/api/admin/addresses/go/promo/approve', {})).status).toBe(200)
    const second = await admin.call('POST', '/api/admin/addresses/other/promo/approve', {})
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('name-taken')
    // It can still be turned down with a note.
    expect(
      (await admin.call('POST', '/api/admin/addresses/other/promo/reject', { note: 'Taken' }))
        .status,
    ).toBe(200)
  })
})

describe('Site settings > Languages', () => {
  test('off by default; an Admin turns it on with a list and a default', async () => {
    w = await world({ agent: false })
    await w.as('alex').call('POST', '/api/projects', { name: 'Go' })
    const admin = w.as('admina')
    const off = await admin.call('GET', '/api/admin/languages/go')
    expect(off.body).toEqual({
      project: 'go',
      enabled: false,
      default: null,
      languages: [],
      subpaths: {},
    })

    const on = await admin.call('PUT', '/api/admin/languages/go', {
      enabled: true,
      default: 'en',
      languages: [
        { code: 'en', name: 'English' },
        { code: 'DA', name: 'Dansk' },
      ],
    })
    expect(on.status).toBe(200)
    expect(on.body).toMatchObject({
      enabled: true,
      default: 'en',
      languages: [
        { code: 'en', name: 'English' },
        { code: 'da', name: 'Dansk' },
      ],
      subpaths: { da: '/da/' },
    })
    // The Creator on the site can read it.
    expect((await w.as('alex').call('GET', '/api/p/go/languages')).body.subpaths).toEqual({
      da: '/da/',
    })
    // Turning it off keeps the list but serves no subpaths.
    const back = await admin.call('PUT', '/api/admin/languages/go', { enabled: false })
    expect(back.body).toMatchObject({ enabled: false, subpaths: {} })
    expect(back.body.languages).toHaveLength(2)
    expect(JSON.stringify(w.db.query('select * from audit_log').all())).toContain(
      'site-languages.changed',
    )
  })

  test('storage is per site', async () => {
    w = await world({ agent: false })
    await w.as('alex').call('POST', '/api/projects', { name: 'Go' })
    await w.as('rune').call('POST', '/api/projects', { name: 'Other' })
    const admin = w.as('admina')
    await admin.call('PUT', '/api/admin/languages/go', {
      enabled: true,
      default: 'en',
      languages: ['en', 'da'],
    })
    expect((await admin.call('GET', '/api/admin/languages/other')).body.enabled).toBe(false)
    expect((await admin.call('GET', '/api/admin/languages/nope')).status).toBe(404)
  })

  test('bad lists are refused and Creators cannot change them', async () => {
    w = await world({ agent: false })
    const alex = w.as('alex')
    await alex.call('POST', '/api/projects', { name: 'Go' })
    expect((await alex.call('PUT', '/api/admin/languages/go', { enabled: true })).status).toBe(403)
    expect((await alex.call('GET', '/api/admin/languages/go')).status).toBe(403)
    const admin = w.as('admina')
    const put = (b: unknown) => admin.call('PUT', '/api/admin/languages/go', b)
    expect((await put({ enabled: true })).body.code).toBe('no-languages')
    expect((await put({ enabled: true, languages: ['en'] })).body.code).toBe('bad-default')
    expect((await put({ enabled: true, default: 'sv', languages: ['en'] })).body.code).toBe(
      'bad-default',
    )
    expect((await put({ enabled: true, default: 'en', languages: ['en', 'en'] })).body.code).toBe(
      'duplicate-language',
    )
    expect((await put({ enabled: true, default: 'en', languages: ['en', '../x'] })).body.code).toBe(
      'bad-code',
    )
    expect((await put({ enabled: true, default: 'en', languages: ['en', 'css'] })).body.code).toBe(
      'bad-code',
    )
    expect((await put({ enabled: 'yes' })).body.code).toBe('bad-enabled')
    expect(
      (
        await put({
          enabled: true,
          default: 'en',
          languages: Array.from({ length: 13 }, (_, i) => `a${String.fromCharCode(97 + i)}`),
        })
      ).status,
    ).toBe(400)
  })
})
