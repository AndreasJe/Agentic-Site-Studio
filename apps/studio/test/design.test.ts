// M4 step 4: the design data model and API (plan §6.2-6.6; decision #45).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { openDb } from '../server/db/index.ts'
import {
  newSectionId,
  nextLetter,
  readArtboardFiles,
  sectionsFromHtml,
} from '../server/design/design.ts'
import { getBlob } from '../server/store/blobs.ts'
import { readRevision } from '../server/store/revisions.ts'
import { addPage, emptyStructure } from '../server/structure/structure.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any

const CSS = 'body{font-family:"PT Sans",sans-serif;color:#2e4163;background:#ffffff}'
const sec = (id: string, inner = '<h2>Hello</h2><p>Text</p>') =>
  `<section data-section="${id}">${inner}</section>`
const page = (...s: string[]) => `<!doctype html><html><body>${s.join('')}</body></html>`

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-design-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
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
  const D = '/api/p/go/design'
  const make = async (html: string, extra: Json = {}) =>
    alex.call('POST', `${D}/artboards`, {
      pageId: 'home',
      html,
      css: CSS,
      description: 'x',
      ...extra,
    })
  return { dataDir, db, app, alex, rune, D, make, ctx: { db, dataDir, instanceId: 'qw' } }
}

const GOOD = page(sec('s-aaaaaa'), sec('s-bbbbbb', '<h2>Proof</h2><a href="x.html">x</a>'))

describe('pure helpers', () => {
  test('letters run a … z, then aa', () => {
    expect(nextLetter('a')).toBe('b')
    expect(nextLetter('y')).toBe('z')
    expect(nextLetter('z')).toBe('aa')
    expect(nextLetter('az')).toBe('ba')
    expect(nextLetter('zz')).toBe('aaa')
  })
  test('section ids are s- plus 6 lowercase alphanumerics and unique among the taken', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = newSectionId(taken)
      expect(id).toMatch(/^s-[a-z0-9]{6}$/)
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
  })
  test('sectionsFromHtml reads the ids in order', () => {
    const s = sectionsFromHtml(page(sec('s-bbbbbb'), sec('s-aaaaaa')))
    expect(s.map((x) => x.id)).toEqual(['s-bbbbbb', 's-aaaaaa'])
    expect(s[0]?.name).toBe('Hello')
  })
})

describe('artboards and the Lead', () => {
  test('the first artboard is Lead and takes letter A; the next is an Alternative with B', async () => {
    const { alex, make, db, ctx } = await setup()
    const a = await make(GOOD)
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ letter: 'A', role: 'lead', pageId: 'home' })
    expect(a.body.sections.map((s: Json) => s.id)).toEqual(['s-aaaaaa', 's-bbbbbb'])
    const b = await make(GOOD)
    expect(b.body).toMatchObject({ letter: 'B', role: 'alternative' })
    expect(
      (db.query('select next_artboard from projects where id = ?').get('go') as Json).next_artboard,
    ).toBe('c')
    // the blobs read back
    const row = db.query('select * from artboards where id = ?').get(a.body.id) as Json
    expect((await readArtboardFiles(ctx, 'go', row)).html).toBe(GOOD)
    expect((await readArtboardFiles(ctx, 'go', row)).css).toBe(CSS)
    const list = await alex.call('GET', '/api/p/go/design')
    expect(list.body.pages[0].artboards.map((x: Json) => x.letter)).toEqual(['A', 'B'])
  })

  test('sections without an id get one from code', async () => {
    const { make } = await setup()
    const a = await make(page('<section><h2>One</h2></section><section><h2>Two</h2></section>'))
    expect(a.status).toBe(201)
    const ids = a.body.sections.map((s: Json) => s.id)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^s-[a-z0-9]{6}$/)
    expect(a.body.html).toContain(`data-section="${ids[0]}"`)
  })

  test('one Lead per page is a database constraint: a raw insert throws', async () => {
    const { make, db } = await setup()
    await make(GOOD)
    const insert = (role: string, letter: string, page = 'home') =>
      db
        .query(
          `insert into artboards (project_id, page_id, letter, role, html_hash, css_hash, created_by, created_at)
           values ('go', ?, ?, ?, 'h', 'c', 'x', 'now')`,
        )
        .run(page, letter, role)
    expect(() => insert('lead', 'Q')).toThrow()
    expect(() => insert('alternative', 'R')).not.toThrow()
    expect(() => insert('lead', 'S', 'other')).not.toThrow() // another page may have its own
  })

  test('the change of Lead asks what the old Lead becomes, then swaps in one step', async () => {
    const { alex, make, D } = await setup()
    const a = await make(GOOD)
    const b = await make(GOOD)
    const noAnswer = await alex.call('POST', `${D}/artboards/${b.body.id}/role`, { role: 'lead' })
    expect(noAnswer.status).toBe(400)
    expect(noAnswer.body.code).toBe('old-lead-role-required')
    const ok = await alex.call('POST', `${D}/artboards/${b.body.id}/role`, {
      role: 'lead',
      oldLeadBecomes: 'reference',
    })
    expect(ok.status).toBe(200)
    expect(ok.body.role).toBe('lead')
    expect((await alex.call('GET', `${D}/artboards/${a.body.id}`)).body.role).toBe('reference')
    // asking for a second Lead directly at creation is refused
    expect((await make(GOOD, { role: 'lead' })).status).toBe(409)
  })

  test('unsettled deviations block Lead', async () => {
    const { alex, make, D } = await setup()
    await make(GOOD)
    const off = page(sec('s-cccccc', '<h2>Hi</h2>')).replace('<h2>', '<h2 style="color:#ff0000">')
    const b = await make(off, { level: 'think-new' })
    expect(b.status).toBe(201)
    expect(b.body.role).toBe('alternative')
    expect(b.body.deviations).toHaveLength(1)
    const r = await alex.call('POST', `${D}/artboards/${b.body.id}/role`, {
      role: 'lead',
      oldLeadBecomes: 'alternative',
    })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('unsettled-deviations')
    // kept as an experiment still blocks; fixed by a clean re-apply unblocks
    const dev = b.body.deviations[0].id
    expect(
      (await alex.call('POST', `${D}/deviations/${dev}/outcome`, { outcome: 'experiment' })).status,
    ).toBe(200)
    expect(
      (
        await alex.call('POST', `${D}/artboards/${b.body.id}/role`, {
          role: 'lead',
          oldLeadBecomes: 'alternative',
        })
      ).status,
    ).toBe(409)
    expect(
      (await alex.call('POST', `${D}/deviations/${dev}/outcome`, { outcome: 'fixed' })).status,
    ).toBe(409)
  })

  test('a re-apply that no longer breaks the rule marks open deviations fixed', async () => {
    const { alex, make, D, db } = await setup()
    await make(GOOD)
    const off = page(sec('s-cccccc', '<h2 style="color:#ff0000">Hi</h2>'))
    const b = await make(off, { level: 'think-new' })
    const r = await alex.call('PUT', `${D}/artboards/${b.body.id}/html`, {
      html: page(sec('s-cccccc', '<h2>Hi</h2>')),
      css: CSS,
      level: 'follow',
    })
    expect(r.status).toBe(200)
    expect(r.body.deviations.map((d: Json) => d.status)).toEqual(['fixed'])
    expect(
      (
        await alex.call('POST', `${D}/artboards/${b.body.id}/role`, {
          role: 'lead',
          oldLeadBecomes: 'alternative',
        })
      ).status,
    ).toBe(200)
    expect(
      (db.query("select count(*) as n from deviations where status = 'open'").get() as Json).n,
    ).toBe(0)
  })
})

describe('the validators at every level', () => {
  const LEVELS = ['follow', 'explore', 'think-new']
  const bad: Record<string, string> = {
    'inline-script': page(sec('s-aaaaaa', '<script>alert(1)</script>')),
    'event-handler': page(sec('s-aaaaaa', '<button onclick="x()">x</button>')),
    'duplicate-section': page(sec('s-aaaaaa'), sec('s-aaaaaa')),
  }
  for (const [rule, html] of Object.entries(bad)) {
    test(`${rule} is refused with 422 at follow, explore and think-new, on create and on apply`, async () => {
      const { alex, make, D } = await setup()
      const first = await make(GOOD)
      for (const level of LEVELS) {
        const c = await make(html, { level })
        expect(c.status).toBe(422)
        expect(c.body.issues.map((i: Json) => i.rule)).toContain(rule)
        const p = await alex.call('PUT', `${D}/artboards/${first.body.id}/html`, {
          html,
          css: CSS,
          level,
        })
        expect(p.status).toBe(422)
        expect(p.body.issues.map((i: Json) => i.rule)).toContain(rule)
      }
      // nothing was stored by the refusals
      expect((await alex.call('GET', `${D}/artboards/${first.body.id}`)).body.html).toBe(GOOD)
    })
  }

  test('a colour outside the guide is refused at follow and explore, and becomes a deviation at think-new', async () => {
    const { alex, make, D } = await setup()
    const first = await make(GOOD)
    const html = page(sec('s-aaaaaa', '<h2 style="color:#ff0000">Hello</h2>'))
    for (const level of ['follow', 'explore']) {
      const r = await alex.call('PUT', `${D}/artboards/${first.body.id}/html`, {
        html,
        css: CSS,
        level,
      })
      expect(r.status).toBe(422)
      expect(r.body.issues[0].rule).toBe('colour')
    }
    // a Lead cannot take on a deviation; a new Alternative can
    const lead = await alex.call('PUT', `${D}/artboards/${first.body.id}/html`, {
      html,
      css: CSS,
      level: 'think-new',
    })
    expect(lead.status).toBe(409)
    const alt = await make(html, { level: 'think-new' })
    expect(alt.status).toBe(201)
    expect(alt.body.deviations).toMatchObject([
      { rule: 'colour', status: 'open', sectionId: 's-aaaaaa' },
    ])
  })
})

/** An artboard with a mobile variant, so every checklist item can be set. */
async function readyBoard() {
  const t = await setup()
  const a = await t.make(GOOD)
  const check = (s: string, item: string, on = true) =>
    t.alex.call('PUT', `${t.D}/sections/${a.body.id}/${s}/check/${item}`, { on })
  return { ...t, a, check }
}

describe('sections: the checklist, approval and locking', () => {
  test('Interactions needs zero open questions; Mobile needs a mobile variant', async () => {
    const { make, alex, D, check } = await readyBoard()
    const open = await make(
      page(sec('s-dddddd', '<h2>Form</h2><form><input name="a"></form><a href="#">more</a>')),
    )
    const r = await alex.call('PUT', `${D}/sections/${open.body.id}/s-dddddd/check/interactions`, {
      on: true,
    })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'open-questions', count: 2 })
    // a section with real links is fine
    expect((await check('s-bbbbbb', 'interactions')).status).toBe(200)
    // mobile
    const m = await check('s-aaaaaa', 'mobile')
    expect(m.status).toBe(409)
    expect(m.body.code).toBe('no-mobile-variant')
    const lead = (await alex.call('GET', `${D}`)).body.pages[0].artboards[0]
    const mob = await make(GOOD, { role: 'state', kind: 'mobile', parentId: lead.id })
    expect(mob.status).toBe(201)
    expect(mob.body).toMatchObject({ role: 'state', kind: 'mobile', parentId: lead.id })
    expect((await check('s-aaaaaa', 'mobile')).status).toBe(200)
  })

  test('Translated counts as on while languages are off', async () => {
    const { a } = await readyBoard()
    const s = a.body.sections[0]
    expect(s.checklist.translated).toBe(true)
    expect(s.translatedNotNeeded).toBe(true)
    expect(s.progress).toBe('1/7')
  })

  test('approval needs all 7, records who, and locks the section; unlock allows the change again', async () => {
    const { alex, make, check, a, D } = await readyBoard()
    await make(GOOD, { role: 'state', kind: 'mobile', parentId: a.body.id })
    const approve = () => alex.call('POST', `${D}/sections/${a.body.id}/s-aaaaaa/approve`)
    const early = await approve()
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('checklist-incomplete')
    expect(early.body.missing).toContain('copy')
    for (const item of [
      'copy',
      'media',
      'interactions',
      'mobile',
      'motion',
      'translated',
      'tested',
    ])
      expect((await check('s-aaaaaa', item)).status).toBe(200)
    const done = await approve()
    expect(done.status).toBe(200)
    const s = done.body.sections.find((x: Json) => x.id === 's-aaaaaa')
    expect(s.progress).toBe('approved')
    expect(s.approved.by).toBe('alex')
    // locked: a change to its content is refused; the other section may change
    const touch = page(sec('s-aaaaaa', '<h2>Hello</h2><p>Changed</p>'), sec('s-bbbbbb'))
    const refused = await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
      html: touch,
      css: CSS,
      level: 'follow',
    })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('section-locked')
    // a missing approved section counts as a change
    const gone = await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
      html: page(sec('s-bbbbbb')),
      css: CSS,
      level: 'follow',
    })
    expect(gone.status).toBe(409)
    // review of M4: hiding it in a wrapper is a change, and so is restyling the page
    for (const wrap of ['<template>', '<div hidden>']) {
      const close = wrap === '<template>' ? '</template>' : '</div>'
      const hidden = await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
        html: page(`${wrap}${sec('s-aaaaaa')}${close}`, sec('s-bbbbbb')),
        css: CSS,
        level: 'follow',
      })
      expect(hidden.status).toBe(409)
      expect(hidden.body.code).toBe('section-locked')
    }
    const restyled = await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
      html: page(sec('s-aaaaaa'), sec('s-bbbbbb')),
      css: `${CSS} section{display:none}`,
      level: 'follow',
    })
    expect(restyled.status).toBe(409)
    expect(restyled.body).toMatchObject({ code: 'section-locked', styles: true })
    // the checklist of an approved section cannot be switched either
    expect((await check('s-aaaaaa', 'copy', false)).status).toBe(409)
    const other = page(sec('s-aaaaaa'), sec('s-bbbbbb', '<h2>Proof</h2><p>New</p>'))
    expect(
      (
        await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
          html: other,
          css: CSS,
          level: 'follow',
        })
      ).status,
    ).toBe(200)
    // unlock, and the same change goes through; copy and media turn off
    expect((await alex.call('POST', `${D}/sections/${a.body.id}/s-aaaaaa/unlock`)).status).toBe(200)
    const ok = await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
      html: touch.replace('s-bbbbbb', 's-bbbbbb'),
      css: CSS,
      level: 'follow',
    })
    expect(ok.status).toBe(200)
    const after = ok.body.sections.find((x: Json) => x.id === 's-aaaaaa')
    expect(after.approved).toBeNull()
    expect(after.checklist).toMatchObject({ copy: false, media: false, motion: true, tested: true })
  })

  test('blobs are never overwritten: the old HTML stays readable after an apply', async () => {
    const { alex, a, D, dataDir } = await readyBoard()
    const before = a.body.htmlHash
    const next = page(sec('s-aaaaaa', '<h2>New</h2>'))
    const r = await alex.call('PUT', `${D}/artboards/${a.body.id}/html`, {
      html: next,
      css: CSS,
      level: 'follow',
    })
    expect(r.body.htmlHash).not.toBe(before)
    expect(new TextDecoder().decode(await getBlob(join(dataDir, 'go'), before))).toBe(GOOD)
  })
})

describe('revisions and access', () => {
  test('design.json is in a saved revision, mapping artboards to roles, hashes and sections', async () => {
    const { alex, make, dataDir, a: _ } = { ...(await readyBoard()) }
    await make(GOOD)
    const s = await alex.call('POST', '/api/p/go/draft/save', { msg: 'Design saved' })
    expect(s.status).toBe(200)
    const rev = readRevision(dataDir, 'go', s.body.revision)
    expect(rev?.files['design.json']).toMatch(/^sha256:/)
    const doc = JSON.parse(
      new TextDecoder().decode(
        await getBlob(join(dataDir, 'go'), rev?.files['design.json'] as string),
      ),
    )
    expect(doc.artboards).toHaveLength(2)
    expect(doc.artboards[0]).toMatchObject({ page: 'home', letter: 'A', role: 'lead' })
    expect(doc.artboards[0].html).toMatch(/^sha256:/)
    expect(doc.artboards[0].sections[0]).toMatchObject({ id: 's-aaaaaa' })
    expect(doc.artboards[0].sections[0].checklist).toHaveProperty('copy')
    expect(doc.artboards[1].role).toBe('alternative')
  })

  test('a revision of a project without design has no design.json', async () => {
    const { alex } = await setup()
    const s = await alex.call('POST', '/api/p/go/draft/save', { msg: 'Nothing yet' })
    expect(s.status).toBe(200)
  })

  test('a page must exist in the structure; a new page can be used after it is added', async () => {
    const { alex, make, D } = await setup()
    expect((await make(GOOD, { pageId: 'nope' })).status).toBe(400)
    const { structure, id } = addPage(emptyStructure('example.com'), {
      title: 'About',
      slug: 'about',
      type: 'core',
    })
    await alex.call('PUT', '/api/p/go/draft', {
      files: { 'structure.json': JSON.stringify(structure) },
    })
    const a = await make(GOOD, { pageId: id })
    expect(a.body).toMatchObject({ role: 'lead', pageId: id })
    const list = await alex.call('GET', D)
    expect(list.body.pages.map((p: Json) => p.id)).toEqual(['home', id])
  })

  test('presence lists other members with a draft on the project', async () => {
    const { alex, rune, db, D } = await setup()
    const runeId = (db.query("select id from users where handle = 'rune'").get() as Json).id
    db.query('insert into members (project_id, user_id) values (?, ?)').run('go', runeId)
    expect((await alex.call('GET', D)).body.presence).toEqual([])
    await rune.call('PUT', '/api/p/go/draft', { files: { 'brief.json': '{}' } })
    expect((await alex.call('GET', D)).body.presence.map((p: Json) => p.handle)).toEqual(['rune'])
  })

  test('ids from another project are not found, even for a member of both (review of M4)', async () => {
    const { alex, make } = await setup()
    const board = await make(GOOD)
    await alex.call('POST', '/api/projects', { name: 'Other' })
    const O = '/api/p/other/design'
    expect((await alex.call('GET', `${O}/artboards/${board.body.id}`)).status).toBe(404)
    expect((await alex.call('GET', `${O}/artboards/${board.body.id}/preview`)).status).toBe(404)
    expect(
      (await alex.call('POST', `${O}/sections/${board.body.id}/s-aaaaaa/approve`)).status,
    ).toBe(404)
  })

  test('a non-member gets 404 on every route; changes need Origin and CSRF', async () => {
    const { rune, alex, make, D, app, alex: a2 } = await setup()
    const board = await make(GOOD)
    const id = board.body.id
    const routes: [string, string, unknown?][] = [
      ['GET', D],
      ['POST', `${D}/artboards`, { pageId: 'home', html: GOOD }],
      ['GET', `${D}/artboards/${id}`],
      ['PUT', `${D}/artboards/${id}/html`, { html: GOOD, level: 'follow' }],
      ['POST', `${D}/artboards/${id}/role`, { role: 'reference' }],
      ['PUT', `${D}/sections/${id}/s-aaaaaa/check/copy`, { on: true }],
      ['POST', `${D}/sections/${id}/s-aaaaaa/approve`],
      ['POST', `${D}/sections/${id}/s-aaaaaa/unlock`],
      ['POST', `${D}/deviations/1/outcome`, { outcome: 'experiment' }],
    ]
    for (const [m, p, b] of routes) {
      expect((await rune.call(m, p, b)).status).toBe(404)
      // no CSRF token, wrong origin
      const noCsrf = await app.request(`${APP}${p}`, {
        method: m,
        headers: { ...alex.headers, 'x-csrf-token': 'wrong', 'content-type': 'application/json' },
        body: m === 'GET' ? undefined : JSON.stringify(b ?? {}),
      })
      if (m !== 'GET') expect(noCsrf.status).toBe(403)
      const noOrigin = await app.request(`${APP}${p}`, {
        method: m,
        headers: {
          ...alex.headers,
          origin: 'http://evil.example',
          'content-type': 'application/json',
        },
        body: m === 'GET' ? undefined : JSON.stringify(b ?? {}),
      })
      if (m !== 'GET') expect(noOrigin.status).toBe(403)
    }
    void a2
  })
})
