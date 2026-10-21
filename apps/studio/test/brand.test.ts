// M4 step 2: Brand and rules (plan §5): install-wide, write-once guide versions, the change
// overview, derived colours refused unless pinned, the logo studio's checks and the locked
// header and footer partials.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mix } from '@site-studio/shared/colour'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { openDb } from '../server/db/index.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-brand-'))
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
    const upload = async (path: string, name: string, bytes: Uint8Array | string) => {
      const form = new FormData()
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      form.append('file', new File([data as Uint8Array<ArrayBuffer>], name))
      const r = await app.request(`${APP}${path}`, { method: 'POST', headers, body: form })
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
    }
    const raw = (path: string) => app.request(`${APP}${path}`, { headers })
    return { call, upload, raw }
  }
  const alex = as('alex')
  const admin = as('admina')
  await alex.call('POST', '/api/projects', { name: 'Go' })
  await alex.call('POST', '/api/projects', { name: 'Docs' })
  return { dataDir, db, alex, admin }
}

const current = async (who: { call: (m: string, p: string) => Promise<{ body: Json }> }) =>
  (await who.call('GET', '/api/brand/guide')).body

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('guide versions', () => {
  test('v1 is seeded from the QualiWare guide, and everyone signed in can read it', async () => {
    const { alex, dataDir } = await setup()
    const r = await alex.call('GET', '/api/brand/guide')
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(1)
    expect(r.body.guide.version).toBe(1)
    expect(r.body.guide.fonts).toEqual(['PT Sans', 'PT Sans Narrow', 'PT Serif', 'PT Mono'])
    expect(r.body.guide.dominant).toBe('PT Sans')
    expect(r.body.guide.colors['dark-green'].hex).toBe('#2b675b')
    expect(r.body.guide.colors['ice-blue'].hex).toBe('#d2e9e3')
    expect(r.body.guide.colors['dark-blue'].hex).toBe('#2e4163')
    expect(r.body.guide.colors.white).toEqual({ hex: '#ffffff', role: 'base' })
    expect(existsSync(join(dataDir, 'brand', 'guide-v1.json'))).toBe(true)
    const list = await alex.call('GET', '/api/brand/guide/versions')
    expect(list.body.versions.map((v: { n: number }) => v.n)).toEqual([1])
    expect((await alex.call('GET', '/api/brand/guide/v/1')).body.guide.dominant).toBe('PT Sans')
    expect((await alex.call('GET', '/api/brand/guide/v/9')).status).toBe(404)
    expect((await alex.call('GET', '/api/brand/guide/v/x')).status).toBe(404)
  })

  test('seeding twice does not add a version', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-brand-'))
    dirs.push(dataDir)
    const db = openDb(':memory:')
    createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
    createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
    expect(readdirSync(join(dataDir, 'brand')).filter((f) => f.startsWith('guide-'))).toEqual([
      'guide-v1.json',
    ])
  })

  test('a Creator cannot write: save, rollback, logo, recipe or partial all give 403', async () => {
    const { alex } = await setup()
    const { guide } = await current(alex)
    expect((await alex.call('POST', '/api/brand/guide', { guide, basedOn: 1 })).status).toBe(403)
    expect((await alex.call('POST', '/api/brand/guide/rollback/1')).status).toBe(403)
    expect((await alex.upload('/api/brand/logo', 'l.svg', '<svg></svg>')).status).toBe(403)
    expect((await alex.call('PUT', '/api/brand/logo/1/recipe', { recipe: {} })).status).toBe(403)
    expect(
      (await alex.call('PUT', '/api/brand/partials/header', { html: '<nav></nav>' })).status,
    ).toBe(403)
    expect((await alex.call('GET', '/api/brand/partials/header')).status).toBe(403)
    expect((await alex.call('GET', '/api/brand/guide/versions')).body.versions).toHaveLength(1)
  })

  test('saving makes the next number, write-once, with who, when and the version it came from', async () => {
    const { admin, dataDir, alex } = await setup()
    const { guide } = await current(admin)
    const next = clone(guide)
    next.colors['alert-red'] = { hex: '#b1263d', role: 'destructive-only' }
    const r = await admin.call('POST', '/api/brand/guide', { guide: next, basedOn: 1 })
    expect(r.status).toBe(201)
    expect(r.body.version.n).toBe(2)
    expect(r.body.version.from).toBe(1)
    expect(r.body.version.by).toBe('admina')
    expect(r.body.version.summary).toMatch(/colour/i)
    expect(r.body.guide.version).toBe(2)
    expect((await current(alex)).version).toBe(2)
    const v1 = readFileSync(join(dataDir, 'brand', 'guide-v1.json'), 'utf8')
    expect(JSON.parse(v1).colors['alert-red']).toBeUndefined()
    const v2 = JSON.parse(readFileSync(join(dataDir, 'brand', 'guide-v2.json'), 'utf8'))
    expect(v2.colors['alert-red'].hex).toBe('#b1263d')
    expect((await alex.call('GET', '/api/brand/guide/v/1')).body.guide.colors['alert-red']).toBe(
      undefined,
    )
    const versions = (await alex.call('GET', '/api/brand/guide/versions')).body.versions
    expect(versions.map((v: { n: number }) => v.n)).toEqual([2, 1])
    expect(versions[0].from).toBe(1)
    expect(typeof versions[0].at).toBe('string')
  })

  test('a stale basedOn is refused with 409 and changes nothing', async () => {
    const { admin } = await setup()
    const { guide } = await current(admin)
    const a = clone(guide)
    a.fonts.push('PT Sans Caption')
    expect((await admin.call('POST', '/api/brand/guide', { guide: a, basedOn: 1 })).status).toBe(
      201,
    )
    const b = clone(guide)
    b.dominant = 'PT Serif'
    const stale = await admin.call('POST', '/api/brand/guide', { guide: b, basedOn: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('stale')
    expect(stale.body.current).toBe(2)
    expect((await current(admin)).version).toBe(2)
  })

  test('an invalid guide is refused with 422 and the errors', async () => {
    const { admin } = await setup()
    const { guide } = await current(admin)
    const bad = clone(guide)
    bad.dominant = 'Comic Sans'
    const r = await admin.call('POST', '/api/brand/guide', { guide: bad, basedOn: 1 })
    expect(r.status).toBe(422)
    expect(r.body.errors.join(' ')).toContain('Comic Sans')
    const worse = await admin.call('POST', '/api/brand/guide', { guide: { fonts: [] }, basedOn: 1 })
    expect(worse.status).toBe(422)
    expect((await admin.call('POST', '/api/brand/guide', { guide, basedOn: 'one' })).status).toBe(
      400,
    )
    expect((await current(admin)).version).toBe(1)
  })

  test('a derived colour whose hex is not the OKLab value is refused; pinned is accepted', async () => {
    const { admin } = await setup()
    const { guide } = await current(admin)
    const old = clone(guide)
    // The old guide's sRGB-mixed value for 20% dark-green + white (golden file: differs).
    old.derived.push({ hex: '#d5e1de', recipe: '20% dark-green + white', use: 'hover' })
    const refused = await admin.call('POST', '/api/brand/guide', { guide: old, basedOn: 1 })
    expect(refused.status).toBe(422)
    expect(refused.body.errors.join(' ')).toContain('#d3dfdc')
    expect(refused.body.mismatches[0].computed).toBe('#d3dfdc')
    old.derived[1].pinned = true
    const pinned = await admin.call('POST', '/api/brand/guide', { guide: old, basedOn: 1 })
    expect(pinned.status).toBe(201)
    // Taking the OKLab value instead is the other sign-off action.
    const taken = clone(guide)
    taken.derived.push({
      hex: mix('#2b675b', '#ffffff', 0.2),
      recipe: '20% dark-green + white',
      use: 'hover',
    })
    expect(taken.derived[1].hex).toBe('#d3dfdc')
    const ok = await admin.call('POST', '/api/brand/guide', { guide: taken, basedOn: 2 })
    expect(ok.status).toBe(201)
  })

  test('the response is a change overview: fonts, colours, derived colours and motion', async () => {
    const { admin } = await setup()
    const { guide } = await current(admin)
    const next = clone(guide)
    next.fonts = ['PT Sans', 'PT Serif', 'PT Sans Caption']
    next.colors['dark-green'].hex = '#2b675c'
    next.colors['alert-red'] = { hex: '#b1263d', role: 'destructive-only' }
    delete next.colors['dark-blue']
    next.derived = [
      { hex: mix('#2b675c', '#ffffff', 0.2), recipe: '20% dark-green + white', use: 'hover' },
    ]
    next.motion.durations.ui = 250
    next.motion.easing.entrance = 'ease-in'
    delete next.motion.distances.rise
    const r = await admin.call('POST', '/api/brand/guide', { guide: next, basedOn: 1 })
    expect(r.status).toBe(201)
    const o = r.body.overview
    expect(o.fonts.added).toEqual(['PT Sans Caption'])
    expect(o.fonts.removed.sort()).toEqual(['PT Mono', 'PT Sans Narrow'])
    expect(o.colours.added).toEqual([
      { name: 'alert-red', hex: '#b1263d', role: 'destructive-only' },
    ])
    expect(o.colours.removed.map((c: { name: string }) => c.name)).toEqual(['dark-blue'])
    expect(o.colours.changed[0]).toMatchObject({
      name: 'dark-green',
      from: { hex: '#2b675b' },
      to: { hex: '#2b675c' },
    })
    expect(o.derived.added.map((d: { recipe: string }) => d.recipe)).toEqual([
      '20% dark-green + white',
    ])
    expect(o.derived.removed.map((d: { recipe: string }) => d.recipe)).toEqual([
      '62% ice-blue + white',
    ])
    expect(o.motion.changed).toEqual([{ key: 'durations.ui', from: 200, to: 250 }])
    expect(o.motion.added).toEqual([{ key: 'easing.entrance', value: 'ease-in' }])
    expect(o.motion.removed).toEqual([{ key: 'distances.rise', value: 8 }])
    expect(o.empty).toBe(false)
  })

  test('saving with no change is refused', async () => {
    const { admin } = await setup()
    const { guide } = await current(admin)
    const r = await admin.call('POST', '/api/brand/guide', { guide: clone(guide), basedOn: 1 })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('no-changes')
  })

  test('rollback makes a new version that copies the old one; nothing is removed', async () => {
    const { admin, dataDir } = await setup()
    const { guide } = await current(admin)
    const a = clone(guide)
    a.dominant = 'PT Serif'
    await admin.call('POST', '/api/brand/guide', { guide: a, basedOn: 1 })
    const r = await admin.call('POST', '/api/brand/guide/rollback/1')
    expect(r.status).toBe(201)
    expect(r.body.version.n).toBe(3)
    expect(r.body.version.summary).toMatch(/v1/)
    const now = await current(admin)
    expect(now.version).toBe(3)
    expect(now.guide.dominant).toBe('PT Sans')
    expect(now.guide.version).toBe(3)
    expect(
      readdirSync(join(dataDir, 'brand'))
        .filter((f) => f.startsWith('guide-'))
        .sort(),
    ).toEqual(['guide-v1.json', 'guide-v2.json', 'guide-v3.json'])
    expect((await admin.call('POST', '/api/brand/guide/rollback/9')).status).toBe(404)
  })

  test('affected projects: every project uses the current guide for now', async () => {
    const { alex } = await setup()
    const r = await alex.call('GET', '/api/brand/guide/affected')
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(1)
    expect(r.body.projects.map((p: { id: string }) => p.id).sort()).toEqual(['docs', 'go'])
  })
})

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>QW</title><g fill="#2b675b"><path d="M0 0h10v10H0z"/></g><rect x="10" y="10" width="5" height="5" fill="#2e4163"/><circle cx="5" cy="15" r="2" style="fill:#d2e9e3"/><path d="M1 1h2" fill="none"/></svg>`
const NS = 'xmlns="http://www.w3.org/2000/svg"'

describe('brand assets: logo', () => {
  test('a clean vector is stored in the blob store and its parts are listed', async () => {
    const { admin, alex, dataDir } = await setup()
    const r = await admin.upload('/api/brand/logo', 'qw.svg', LOGO)
    expect(r.status).toBe(201)
    expect(r.body.logo.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(r.body.logo.parts.map((p: { tag: string }) => p.tag)).toEqual(['g', 'rect', 'circle'])
    expect(r.body.logo.parts[0]).toMatchObject({ index: 0, fill: '#2b675b' })
    expect(r.body.logo.parts[2].fill).toBe('#d2e9e3')
    const x = r.body.logo.hash.slice(7)
    expect(existsSync(join(dataDir, 'brand', 'blobs', 'sha256', x.slice(0, 2), x.slice(2)))).toBe(
      true,
    )
    // Creators can read it.
    const got = await alex.call('GET', '/api/brand/logo')
    expect(got.body.logo.id).toBe(r.body.logo.id)
    const file = await alex.raw(`/api/brand/logo/${r.body.logo.id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-security-policy')).toContain('sandbox')
  })

  test.each([
    ['a script', `<svg ${NS}><script>alert(1)</script></svg>`],
    ['an event handler', `<svg ${NS}><rect onclick="x()" fill="#000"/></svg>`],
    ['an embedded image', `<svg ${NS}><image href="data:image/png;base64,AAAA"/></svg>`],
    ['a foreignObject', `<svg ${NS}><foreignObject><p>x</p></foreignObject></svg>`],
    ['a style element', `<svg ${NS}><style>rect{fill:red}</style><rect/></svg>`],
    ['an external url()', `<svg ${NS}><rect fill="url(https://x.test/a)"/></svg>`],
    ['an external href', `<svg ${NS}><a href="https://x.test"><rect/></a></svg>`],
    ['a use element', `<svg ${NS}><use href="#a"/></svg>`],
    ['a text element', `<svg ${NS}><text>Hi</text></svg>`],
  ])('refuses %s', async (_name, svg) => {
    const { admin } = await setup()
    const r = await admin.upload('/api/brand/logo', 'bad.svg', svg)
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('unsafe-svg')
    expect((await admin.call('GET', '/api/brand/logo')).body.logo).toBeNull()
  })

  test('only an SVG is accepted', async () => {
    const { admin } = await setup()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    expect((await admin.upload('/api/brand/logo', 'a.png', png)).status).toBe(415)
  })

  test('the recolour recipe is limited to guide and derived colours, and the original is kept', async () => {
    const { admin, alex } = await setup()
    const up = await admin.upload('/api/brand/logo', 'qw.svg', LOGO)
    const id = up.body.logo.id
    const put = (recipe: Record<string, string>) =>
      admin.call('PUT', `/api/brand/logo/${id}/recipe`, { recipe })
    expect((await put({ 0: 'hot-pink' })).status).toBe(422)
    expect((await put({ 9: 'dark-green' })).status).toBe(422)
    expect((await put({ 0: '#ff00ff' })).status).toBe(422)
    const ok = await put({ 0: 'dark-blue', 1: '62% ice-blue + white', 2: 'white' })
    expect(ok.status).toBe(200)
    expect(ok.body.logo.recipe).toEqual({ 0: 'dark-blue', 1: '62% ice-blue + white', 2: 'white' })
    const svg = await (await alex.raw(`/api/brand/logo/${id}/preview`)).text()
    expect(svg).toContain('fill="#2e4163"')
    expect(svg).toContain('fill="#e3f1ee"')
    expect(svg).toContain('fill:#ffffff')
    expect(svg).not.toContain('#2b675b')
    // The original bytes are untouched.
    expect(await (await alex.raw(`/api/brand/logo/${id}/file`)).text()).toBe(LOGO)
    expect((await alex.call('GET', '/api/brand/logo')).body.logo.recipe[0]).toBe('dark-blue')
  })
})

const HEADER = '<header><nav><a href="index.html">Home</a></nav></header>'

describe('brand assets: header and footer partials', () => {
  test('each save is a new version and nothing is overwritten', async () => {
    const { admin } = await setup()
    expect((await admin.call('GET', '/api/brand/partials/header')).body).toMatchObject({
      version: null,
      html: '',
    })
    const a = await admin.call('PUT', '/api/brand/partials/header', { html: HEADER })
    expect(a.status).toBe(201)
    expect(a.body.version).toBe(1)
    const b = await admin.call('PUT', '/api/brand/partials/header', {
      html: HEADER.replace('Home', 'Start'),
    })
    expect(b.body.version).toBe(2)
    const got = (await admin.call('GET', '/api/brand/partials/header')).body
    expect(got.html).toContain('Start')
    expect(got.versions.map((v: { n: number }) => v.n)).toEqual([2, 1])
    const old = await admin.call('GET', '/api/brand/partials/header?v=1')
    expect(old.body.html).toContain('Home')
    const footer = await admin.call('PUT', '/api/brand/partials/footer', {
      html: '<footer><p>QualiWare</p></footer>',
    })
    expect(footer.body.version).toBe(1)
    expect((await admin.call('GET', '/api/brand/partials/other')).status).toBe(404)
  })

  test('the header needs a nav, and the validator refuses an inline script', async () => {
    const { admin } = await setup()
    const none = await admin.call('PUT', '/api/brand/partials/header', {
      html: '<header><p>x</p></header>',
    })
    expect(none.status).toBe(422)
    expect(none.body.code).toBe('no-nav')
    const script = await admin.call('PUT', '/api/brand/partials/header', {
      html: `${HEADER}<script>alert(1)</script>`,
    })
    expect(script.status).toBe(422)
    expect(script.body.errors.map((e: { rule: string }) => e.rule)).toContain('inline-script')
    const colour = await admin.call('PUT', '/api/brand/partials/footer', {
      html: '<footer style="color:#ff00ff">x</footer>',
    })
    expect(colour.status).toBe(422)
    expect((await admin.call('GET', '/api/brand/partials/header')).body.version).toBeNull()
  })
})
