// M5 step 1: the review server (plan §7; decision #8): package, approval, findings, suggestions.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { openDb } from '../server/db/index.ts'
import { buildPackage, getPackage } from '../server/review/package.ts'
import { getBlob } from '../server/store/blobs.ts'
import { addPage, emptyStructure } from '../server/structure/structure.ts'
import { mockServer, type Reply } from './llm/mock-server.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
let stop = () => {}
afterEach(() => stop())
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any

const CSS = 'body{font-family:"PT Sans",sans-serif;color:#2e4163;background:#ffffff}'
const sec = (id: string, inner = '<h2>Hello</h2><p>Text</p>') =>
  `<section data-section="${id}">${inner}</section>`
const page = (...s: string[]) =>
  `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${s.join('')}</body></html>`
const HOME = page(sec('s-aaaaaa'), sec('s-bbbbbb', '<h2>Proof</h2><a href="x.html">x</a>'))
const ABOUT = page(sec('s-cccccc', '<h2>About</h2><a href="x.html">x</a>'))
const ITEMS = ['copy', 'media', 'interactions', 'mobile', 'motion', 'translated', 'tested']

const suggest = (suggestions: Json[]): Reply => ({
  kind: 'content',
  content: JSON.stringify({ suggestions }),
})

async function setup(script: Reply[] = [suggest([])]) {
  const mock = mockServer(script)
  stop = mock.stop
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-review-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({
    appUrl: new URL(APP),
    instanceId: 'qw',
    db,
    dataDir,
    llmEndpoint: {
      name: 'mock',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      model: 'm',
      capability: 'json_schema',
    },
  })
  const as = (handle: string) => {
    const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
    const s = createSession(db, user.id, Date.now())
    const headers = { origin: APP, cookie: `${SESSION_COOKIE}=${s.id}`, 'x-csrf-token': s.csrf }
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
    }
    return { call, headers }
  }
  const alex = as('alex')
  const rune = as('rune')
  await alex.call('POST', '/api/projects', { name: 'Go' })
  const ctx = { db, dataDir, instanceId: 'qw' }
  const D = '/api/p/go/design'
  const R = '/api/p/go/review'

  // Pages: home plus About (path about/index.html) and Team under About.
  let { structure } = { structure: emptyStructure('example.com') }
  const about = addPage(structure, { title: 'About', slug: 'about', type: 'core' })
  structure = about.structure
  const team = addPage(structure, {
    title: 'Team',
    slug: 'team',
    parent: about.id,
    type: 'core',
  })
  structure = team.structure
  await alex.call('PUT', '/api/p/go/draft', {
    files: { 'structure.json': JSON.stringify(structure) },
  })

  const make = async (pageId: string, html: string, extra: Json = {}) =>
    (
      await alex.call('POST', `${D}/artboards`, {
        pageId,
        html,
        css: CSS,
        description: 'x',
        ...extra,
      })
    ).body
  const check = (artboard: number, section: string, item: string, on = true) =>
    alex.call('PUT', `${D}/sections/${artboard}/${section}/check/${item}`, { on })
  const approveSection = async (artboard: number, section: string) => {
    for (const i of ITEMS) {
      const r = await check(artboard, section, i)
      if (r.status !== 200) throw new Error(`${i}: ${JSON.stringify(r.body)}`)
    }
    const r = await alex.call('POST', `${D}/sections/${artboard}/${section}/approve`)
    if (r.status !== 200) throw new Error(JSON.stringify(r.body))
  }
  const save = async (msg = 'Saved') =>
    (await alex.call('POST', '/api/p/go/draft/save', { msg })).body.revision as string

  // Home (with a mobile state) and Team have a Lead; About has none.
  const home = await make('home', HOME)
  await make('home', HOME, { role: 'state', kind: 'mobile', parentId: home.id })
  const teamBoard = await make(team.id, ABOUT)
  await make(team.id, ABOUT, { role: 'state', kind: 'mobile', parentId: teamBoard.id })

  return {
    db,
    dataDir,
    ctx,
    app,
    alex,
    rune,
    as,
    D,
    R,
    home,
    teamBoard,
    aboutId: about.id,
    teamId: team.id,
    make,
    check,
    approveSection,
    save,
    mock,
  }
}

const sections = (db: import('bun:sqlite').Database) =>
  db.query('select * from sections order by artboard_id, section_id').all()

describe('the review package', () => {
  test('paths come from the structure; a page without a Lead is left out', async () => {
    const t = await setup()
    const rev = await t.save()
    const pkg = await buildPackage(t.ctx, 'go', rev)
    expect(Object.keys(pkg.files)).toEqual([
      'about/team/index.html',
      'about/team/style.css',
      'index.html',
      'style.css',
    ])
    const dir = join(t.dataDir, 'go')
    expect(new TextDecoder().decode(await getBlob(dir, pkg.files['index.html'] as string))).toBe(
      HOME,
    )
    expect(
      new TextDecoder().decode(await getBlob(dir, pkg.files['about/team/style.css'] as string)),
    ).toBe(CSS)
    for (const p of Object.keys(pkg.files)) {
      expect(p.startsWith('/')).toBe(false)
      expect(p.split('/')).not.toContain('..')
    }
    expect(pkg.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the package is deterministic and write-once', async () => {
    const t = await setup()
    const rev = await t.save()
    const first = await buildPackage(t.ctx, 'go', rev)
    const file = join(t.dataDir, 'go', 'packages', `${rev}.json`)
    expect(existsSync(file)).toBe(true)
    const bytes = readFileSync(file)
    // a second build reuses the stored file and changes nothing
    expect(await buildPackage(t.ctx, 'go', rev)).toEqual(first)
    expect(getPackage(t.ctx, 'go', rev)).toEqual(first)
    expect(readFileSync(file).equals(bytes)).toBe(true)
    // a rebuild from scratch (stored file removed) gives the same hash
    rmSync(file)
    expect((await buildPackage(t.ctx, 'go', rev)).hash).toBe(first.hash)
    expect(getPackage(t.ctx, 'go', 'go-r99')).toBeNull()
  })

  test('the hash follows the content: a changed Lead gives another hash', async () => {
    const t = await setup()
    const r1 = await t.save()
    await t.alex.call('PUT', `${t.D}/artboards/${t.home.id}/html`, {
      html: page(
        sec('s-aaaaaa', '<h2>Changed</h2>'),
        sec('s-bbbbbb', '<h2>Proof</h2><a href="x.html">x</a>'),
      ),
      level: 'follow',
    })
    const r2 = await t.save()
    expect((await buildPackage(t.ctx, 'go', r1)).hash).not.toBe(
      (await buildPackage(t.ctx, 'go', r2)).hash,
    )
  })
})

describe('reading a revision', () => {
  test('lists saved revisions, newest first, and shows pages, Leads and blockers', async () => {
    const t = await setup()
    const r1 = await t.save('First')
    const r2 = await t.save('Second')
    const list = await t.alex.call('GET', t.R)
    expect(list.body.revisions.map((r: Json) => r.id)).toEqual([r2, r1])
    const v = (await t.alex.call('GET', `${t.R}/${r1}`)).body
    expect(v.pages.map((p: Json) => p.id)).toEqual(['home', t.aboutId, t.teamId])
    expect(v.pages[0].lead).toMatchObject({ letter: 'A', artboard: t.home.id })
    expect(v.pages[0].lead.sections[0]).toMatchObject({ id: 's-aaaaaa', progress: '1/7' })
    expect(v.pages[1].lead).toBeNull()
    expect(v.approved).toEqual({ n: 0, m: 3 })
    expect(v.package.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(v.canApprove).toBe(false)
    expect(v.approval).toBeNull()
    expect(v.blockers).toContainEqual({ page: t.aboutId, reason: 'no-lead' })
    expect(v.blockers).toContainEqual({
      page: 'home',
      reason: 'section-not-approved',
      sectionId: 's-aaaaaa',
    })
    expect((await t.alex.call('GET', `${t.R}/go-r99`)).status).toBe(404)
  })
})

describe('approving a revision', () => {
  test('is refused with blockers until every page has a Lead and every section is approved', async () => {
    const t = await setup()
    const rev = await t.save()
    const r = await t.alex.call('POST', `${t.R}/${rev}/approve`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('not-ready')
    expect(r.body.blockers.some((b: Json) => b.reason === 'no-lead' && b.page === t.aboutId)).toBe(
      true,
    )
    expect(r.body.blockers.some((b: Json) => b.reason === 'section-not-approved')).toBe(true)
    expect(t.db.query('select approved from projects where id = ?').get('go')).toEqual({
      approved: null,
    })
  })

  test('is accepted once all are approved and the revision is saved after approving', async () => {
    const t = await setup()
    const about = await t.make(t.aboutId, ABOUT)
    await t.make(t.aboutId, ABOUT, { role: 'state', kind: 'mobile', parentId: about.id })
    await t.approveSection(t.home.id, 's-aaaaaa')
    await t.approveSection(t.home.id, 's-bbbbbb')
    await t.approveSection(about.id, 's-cccccc')
    await t.approveSection(t.teamBoard.id, 's-cccccc')
    const rev = await t.save()
    const v = (await t.alex.call('GET', `${t.R}/${rev}`)).body
    expect(v.blockers).toEqual([])
    expect(v.canApprove).toBe(true)
    expect(v.approved).toEqual({ n: 4, m: 4 })
    const r = await t.alex.call('POST', `${t.R}/${rev}/approve`)
    expect(r.status).toBe(200)
    expect(r.body.approval).toMatchObject({ rev, by: 'alex', packageHash: v.package.hash })
    expect(t.db.query('select approved from projects where id = ?').get('go')).toEqual({
      approved: rev,
    })
    // idempotent: the same row, no second one
    const again = await t.alex.call('POST', `${t.R}/${rev}/approve`)
    expect(again.status).toBe(200)
    expect(again.body.approval).toEqual(r.body.approval)
    expect((t.db.query('select count(*) as n from revision_approvals').get() as Json).n).toBe(1)
    expect((await t.alex.call('GET', `${t.R}/${rev}`)).body.approval).toMatchObject({ rev })
    expect(JSON.parse(readFileSync(join(t.dataDir, 'go', 'project.json'), 'utf8')).approved).toBe(
      rev,
    )
  })

  test('the rule reads the revision, not the live database', async () => {
    const t = await setup()
    const about = await t.make(t.aboutId, ABOUT)
    await t.make(t.aboutId, ABOUT, { role: 'state', kind: 'mobile', parentId: about.id })
    const old = await t.save('Before approving')
    // approve everything live, after saving
    await t.approveSection(t.home.id, 's-aaaaaa')
    await t.approveSection(t.home.id, 's-bbbbbb')
    await t.approveSection(about.id, 's-cccccc')
    await t.approveSection(t.teamBoard.id, 's-cccccc')
    const blocked = await t.alex.call('POST', `${t.R}/${old}/approve`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.blockers.length).toBe(4)
    const fresh = await t.save('After approving')
    expect((await t.alex.call('POST', `${t.R}/${fresh}/approve`)).status).toBe(200)
    expect((await t.alex.call('GET', `${t.R}/${old}`)).body.approval).toBeNull()
  })

  test('an Admin may approve', async () => {
    const t = await setup()
    const rev = await t.save()
    // not ready, but the right is not what refuses it
    const admin = t.as('admina')
    const r = await admin.call('POST', `${t.R}/${rev}/approve`)
    expect(r.status).toBe(409)
    expect((await admin.call('GET', `${t.R}/${rev}`)).status).toBe(200)
  })
})

describe('accepting accessibility findings', () => {
  test('needs a reason of at least 3 characters after trim', async () => {
    const t = await setup()
    const rev = await t.save()
    const url = `${t.R}/${rev}/findings/accept`
    for (const reason of [undefined, '', '  ', ' ab ', 12]) {
      const r = await t.alex.call('POST', url, {
        rule: 'color-contrast',
        target: '#hero h2',
        reason,
      })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('reason-required')
    }
    expect((await t.alex.call('POST', url, { reason: 'Brand colour, signed off' })).status).toBe(
      400,
    )
    const ok = await t.alex.call('POST', url, {
      rule: 'color-contrast',
      target: '#hero h2',
      reason: '  Brand colour, signed off  ',
    })
    expect(ok.status).toBe(201)
    expect(ok.body.acceptances).toMatchObject([
      {
        rule: 'color-contrast',
        target: '#hero h2',
        reason: 'Brand colour, signed off',
        by: 'alex',
      },
    ])
    const v = (await t.alex.call('GET', `${t.R}/${rev}`)).body
    expect(v.acceptances).toHaveLength(1)
    // an Admin may accept too
    expect(
      (
        await t
          .as('admina')
          .call('POST', url, { rule: 'label', target: 'input', reason: 'Decorative' })
      ).status,
    ).toBe(201)
  })
})

describe('AI suggestions', () => {
  test('are returned for a section and never change a checkmark or any stored row', async () => {
    const t = await setup([
      suggest([{ item: 'copy', reason: 'The headline and text read clearly.' }]),
    ])
    const rev = await t.save()
    const before = JSON.stringify(sections(t.db))
    const usageBefore = (t.db.query('select count(*) as n from usage').get() as Json).n
    const approvalsBefore = (
      t.db.query('select count(*) as n from revision_approvals').get() as Json
    ).n
    const r = await t.alex.call('POST', `${t.R}/${rev}/suggest`, { sectionId: 's-aaaaaa' })
    expect(r.status).toBe(200)
    expect(r.body.suggestions).toEqual([
      { item: 'copy', reason: 'The headline and text read clearly.' },
    ])
    expect(JSON.stringify(sections(t.db))).toBe(before)
    expect((t.db.query('select count(*) as n from revision_approvals').get() as Json).n).toBe(
      approvalsBefore,
    )
    expect((t.db.query('select count(*) as n from a11y_acceptances').get() as Json).n).toBe(0)
    expect((t.db.query('select count(*) as n from usage').get() as Json).n).toBe(usageBefore + 1)
    // the revision shows the checkmark as it was
    const v = (await t.alex.call('GET', `${t.R}/${rev}`)).body
    expect(v.pages[0].lead.sections[0].checklist.copy).toBe(false)
    expect(v.pages[0].lead.sections[0].progress).toBe('1/7')
  })

  test('the section HTML goes in the untrusted part; a bad reply is retried then refused', async () => {
    const t = await setup([suggest([{ item: 'nonsense', reason: 'x' }])])
    const rev = await t.save()
    const r = await t.alex.call('POST', `${t.R}/${rev}/suggest`, { sectionId: 's-bbbbbb' })
    expect(r.status).toBe(502)
    expect(r.body.code).toBe('ai-failed')
    const sent = JSON.stringify(t.mock.bodies[0])
    expect(sent).toContain('Proof')
    expect(t.mock.bodies.length).toBe(3) // first try plus two retries
    expect(
      (await t.alex.call('POST', `${t.R}/${rev}/suggest`, { sectionId: 's-nope' })).status,
    ).toBe(404)
  })
})

describe('access', () => {
  test('a non-member gets 404 on every route; changes need Origin and CSRF', async () => {
    const t = await setup()
    const rev = await t.save()
    const routes: [string, string, unknown?][] = [
      ['GET', t.R],
      ['GET', `${t.R}/${rev}`],
      ['POST', `${t.R}/${rev}/approve`],
      ['POST', `${t.R}/${rev}/findings/accept`, { rule: 'r', target: 't', reason: 'because' }],
      ['POST', `${t.R}/${rev}/suggest`, { sectionId: 's-aaaaaa' }],
    ]
    for (const [m, p, b] of routes) {
      expect((await t.rune.call(m, p, b)).status).toBe(404)
      if (m === 'GET') continue
      const send = (headers: Record<string, string>) =>
        t.app.request(`${APP}${p}`, {
          method: m,
          headers: { ...t.alex.headers, ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(b ?? {}),
        })
      expect((await send({ 'x-csrf-token': 'wrong' })).status).toBe(403)
      expect((await send({ origin: 'http://evil.example' })).status).toBe(403)
    }
    expect((t.db.query('select count(*) as n from a11y_acceptances').get() as Json).n).toBe(0)
  })
})
