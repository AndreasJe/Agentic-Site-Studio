// Decision 22 Oct #12: project settings are enforced. Structure changes need an Admin when the
// project says so, release signing needs max(install rule, project rule), and the check job uses
// the stricter of the install's and the project's levels (checks: see checks.test.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { type World, world } from './helpers/deploy-world.ts'
import { type Fixture, releaseFixture } from './helpers/release-fixture.ts'

let w: World | undefined
let f: Fixture | undefined
afterEach(async () => {
  await w?.cleanup()
  await f?.cleanup()
  w = undefined
  f = undefined
})

describe('structureNeedsAdmin', () => {
  test('a Creator gets 403 structure-needs-admin on every structure change; an Admin does not', async () => {
    w = await world({ agent: false })
    const me = w.as('alex')
    const admin = w.as('admina')
    expect((await me.call('POST', '/api/projects', { name: 'go' })).status).toBe(201)
    const page = await me.call('POST', '/api/p/go/structure/add-page', {
      title: 'Offer',
      slug: 'offer',
      type: 'landing',
    })
    expect(page.status).toBe(200)
    const pageId = page.body.id as string
    const before = (await me.call('GET', '/api/p/go/structure')).body.structure.pages.length

    expect(
      (await admin.call('PUT', '/api/p/go/settings', { structureNeedsAdmin: true })).status,
    ).toBe(200)

    const changes: [string, unknown][] = [
      ['add-page', { title: 'Two', slug: 'two', type: 'landing' }],
      ['set-hidden', { id: pageId, hidden: true }],
      ['delete-page', { id: pageId }],
      ['set-pattern', { pattern: 'top-bar' }],
    ]
    for (const [action, body] of changes) {
      const r = await me.call('POST', `/api/p/go/structure/${action}`, body)
      expect({ action, status: r.status, code: r.body.code }).toEqual({
        action,
        status: 403,
        code: 'structure-needs-admin',
      })
    }
    for (const path of ['apply', 'accept']) {
      const r = await me.call('POST', `/api/p/go/structure/${path}`, { pages: [] })
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path,
        status: 403,
        code: 'structure-needs-admin',
      })
    }
    // Nothing changed, and reading is still open.
    const s = await me.call('GET', '/api/p/go/structure')
    expect(s.status).toBe(200)
    expect(s.body.structure.pages).toHaveLength(before)
    // Asking for an address is a request, not a change.
    expect(
      (await me.call('POST', '/api/p/go/structure/request-address', { name: 'promo', pageId }))
        .status,
    ).toBe(200)
    // The Admin can still change the structure (in their own draft).
    expect(
      (
        await admin.call('POST', '/api/p/go/structure/add-page', {
          title: 'Two',
          slug: 'two',
          type: 'landing',
        })
      ).status,
    ).toBe(200)
  })

  test('the generic draft routes are gated too: no structure.json by autosave, no older structure by continue (review)', async () => {
    w = await world({ agent: false })
    const me = w.as('alex')
    const admin = w.as('admina')
    expect((await me.call('POST', '/api/projects', { name: 'go' })).status).toBe(201)
    await me.call('POST', '/api/p/go/structure/add-page', {
      title: 'A',
      slug: 'a',
      type: 'landing',
    })
    const r1 = await me.call('POST', '/api/p/go/draft/save', { msg: 'first structure' })
    expect(r1.status).toBe(200)
    await me.call('POST', '/api/p/go/structure/add-page', {
      title: 'B',
      slug: 'b',
      type: 'landing',
    })
    expect(
      (await me.call('POST', '/api/p/go/draft/save', { msg: 'second structure' })).status,
    ).toBe(200)
    expect(
      (await admin.call('PUT', '/api/p/go/settings', { structureNeedsAdmin: true })).status,
    ).toBe(200)
    const put = await me.call('PUT', '/api/p/go/draft', { files: { 'structure.json': '{}' } })
    expect(put.status).toBe(403)
    expect(put.body.code).toBe('structure-needs-admin')
    // Other draft files still autosave.
    expect((await me.call('PUT', '/api/p/go/draft', { files: { 'notes.txt': 'x' } })).status).toBe(
      200,
    )
    const back = await me.call('POST', `/api/p/go/revisions/${r1.body.revision}/continue`, {})
    expect(back.status).toBe(403)
    expect(back.body.code).toBe('structure-needs-admin')
  })

  test('off by default, and off again when switched off', async () => {
    w = await world({ agent: false })
    const me = w.as('alex')
    const admin = w.as('admina')
    await me.call('POST', '/api/projects', { name: 'go' })
    const add = (slug: string) =>
      me.call('POST', '/api/p/go/structure/add-page', { title: slug, slug, type: 'landing' })
    expect((await add('a')).status).toBe(200)
    await admin.call('PUT', '/api/p/go/settings', { structureNeedsAdmin: true })
    expect((await add('b')).status).toBe(403)
    await admin.call('PUT', '/api/p/go/settings', { structureNeedsAdmin: false })
    expect((await add('b')).status).toBe(200)
  })

  test('another project is not affected', async () => {
    w = await world({ agent: false })
    const me = w.as('alex')
    await me.call('POST', '/api/projects', { name: 'go' })
    await me.call('POST', '/api/projects', { name: 'other' })
    await w.as('admina').call('PUT', '/api/p/go/settings', { structureNeedsAdmin: true })
    const r = await me.call('POST', '/api/p/other/structure/add-page', {
      title: 'a',
      slug: 'a',
      type: 'landing',
    })
    expect(r.status).toBe(200)
  })
})

describe('per-project two-person rule on release signing', () => {
  test('the project asks for two signatures under an install rule of one', async () => {
    f = await releaseFixture()
    const admin = f.as('admina')
    expect((await admin('PUT', '/api/p/go/settings', { twoPerson: { releases: 2 } })).status).toBe(
      200,
    )
    const { requestId } = await f.stageAndRequest()
    const review = (await admin('GET', `/api/admin/review/${requestId}`)).body
    expect(review.policy.releases).toBe(2)
    const ch = await admin('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.body.needed).toBe(2)
    const first = await admin(
      'POST',
      `/api/admin/review/${requestId}/sign`,
      await f.sign('admina', ch.body.publicKey),
    )
    expect(first.body).toMatchObject({ complete: false, sent: false })
  })

  test('the install rule still wins when it is stricter than the project (max)', async () => {
    f = await releaseFixture()
    const admin = f.as('admina')
    // The project says one; the install is raised afterwards to two.
    await admin('PUT', '/api/p/go/settings', { twoPerson: { releases: 1 } })
    f.db
      .query(
        "insert into settings (key, value) values ('two_person_rule', ?) on conflict (key) do update set value = excluded.value",
      )
      .run(JSON.stringify({ releases: 2, keys: 1, domains: 1 }))
    const { requestId } = await f.stageAndRequest()
    const ch = await admin('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.body.needed).toBe(2)
  })

  test('without a project rule the install rule applies', async () => {
    f = await releaseFixture()
    const { requestId } = await f.stageAndRequest()
    const ch = await f.as('admina')('POST', `/api/admin/review/${requestId}/challenge`)
    expect(ch.body.needed).toBe(1)
  })
})
