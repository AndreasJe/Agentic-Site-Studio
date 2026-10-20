// M3 step 1: the structure model and API (plan §10; decision #44; M3 Done when).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { openDb } from '../server/db/index.ts'
import {
  addPage,
  addRoot,
  addToMenu,
  deletePage,
  emptyStructure,
  isHidden,
  MENU_LIMITS,
  movePage,
  navigationChecks,
  pagesAndJobsText,
  pathOf,
  removeFromMenu,
  reorderPage,
  requestAddress,
  type Structure,
  StructureError,
  setHidden,
  setPlacement,
  validateStructure,
} from '../server/structure/structure.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const page = (s: Structure, o: Parameters<typeof addPage>[1]) => addPage(s, o)
const empty = () => emptyStructure('example.com')
const NOW = { by: 'alex', at: '2026-10-20T10:00:00Z' }
const EX = 'example.com'

/** home, products > go, about. */
function tree() {
  let s = empty()
  let r = page(s, { title: 'Products', slug: 'products', type: 'core' })
  s = r.structure
  const products = r.id
  r = page(s, { title: 'Go', slug: 'go', parent: products, type: 'core' })
  s = r.structure
  const go = r.id
  r = page(s, { title: 'About', slug: 'about', type: 'core' })
  s = r.structure
  const about = r.id
  return { s, products, go, about }
}

describe('pages and addresses', () => {
  test('a new structure has one root with a home page', () => {
    const s = empty()
    expect(s.roots).toEqual([{ address: EX, home: 'home' }])
    expect(s.pages).toMatchObject([{ id: 'home', title: 'Home', parent: null, root: EX }])
    expect(validateStructure(s)).toBe(s)
    expect(pathOf(s, 'home')).toBe('example.com/')
  })

  test('paths come from the tree: root address, parent slugs, own slug', () => {
    const { s, go } = tree()
    expect(pathOf(s, go)).toBe('example.com/products/go')
  })

  test('slugs are lower-case letters, digits and hyphens, unique among siblings', () => {
    const { s, products } = tree()
    for (const slug of ['Bad', 'a b', 'a_b', '', 'å'])
      expect(() => page(s, { title: 'X', slug, type: 'core' })).toThrow(StructureError)
    expect(() => page(s, { title: 'Again', slug: 'products', type: 'core' })).toThrow('taken')
    // The same slug under another parent is fine.
    expect(() => page(s, { title: 'Go', slug: 'go', type: 'core' })).not.toThrow()
    expect(() => page(s, { title: 'Go', slug: 'go', parent: products, type: 'core' })).toThrow(
      'taken',
    )
  })

  test('the page type sets the default placement (plan 10.1)', () => {
    let s = empty()
    const place = (type: 'core' | 'landing' | 'campaign' | 'customer-story', slug: string) => {
      const r = page(s, {
        title: slug,
        slug,
        type,
        miniBrief: { goal: 'g', visitorAction: 'a', expires: '2026-12-31' },
      })
      s = r.structure
      return s.pages.find((p) => p.id === r.id)?.placement
    }
    expect(place('core', 'a')).toBe('menu')
    expect(place('landing', 'b')).toBe('hidden')
    expect(place('campaign', 'c')).toBe('hidden')
    expect(place('customer-story', 'd')).toBe('menu')
    expect(() => page(s, { title: 'C', slug: 'cc', type: 'campaign' })).toThrow('expir')
  })

  test('moving a parent moves its children, and an approved page leaves redirects', () => {
    const { s, products, go, about } = tree()
    const approved = new Set(['example.com/products', 'example.com/products/go'])
    const moved = movePage(s, products, { parent: about, approvedPaths: approved })
    expect(pathOf(moved, products)).toBe('example.com/about/products')
    expect(pathOf(moved, go)).toBe('example.com/about/products/go')
    expect(moved.redirects).toEqual([
      { from: 'example.com/products', to: 'example.com/about/products' },
      { from: 'example.com/products/go', to: 'example.com/about/products/go' },
    ])
  })

  test('moving a page that was never approved leaves no redirect', () => {
    const { s, products, about } = tree()
    const moved = movePage(s, products, { parent: about, approvedPaths: new Set() })
    expect(moved.redirects).toEqual([])
  })

  test('a page cannot move into itself or its own children; a new slug can be given', () => {
    const { s, products, go } = tree()
    expect(() => movePage(s, products, { parent: go, approvedPaths: new Set() })).toThrow('itself')
    const renamed = movePage(s, products, {
      parent: null,
      slug: 'offer',
      approvedPaths: new Set(['example.com/products']),
    })
    expect(pathOf(renamed, products)).toBe('example.com/offer')
    expect(renamed.redirects).toContainEqual({
      from: 'example.com/products',
      to: 'example.com/offer',
    })
  })

  test('hidden: a hidden parent makes its children hidden; a visible parent can have hidden ones', () => {
    const { s, products, go } = tree()
    const h = setHidden(s, products, true)
    expect(isHidden(h, products)).toBe(true)
    expect(isHidden(h, go)).toBe(true)
    const child = setHidden(s, go, true)
    expect(isHidden(child, go)).toBe(true)
    expect(isHidden(child, products)).toBe(false)
    expect(isHidden(setHidden(h, products, false), go)).toBe(false)
  })

  test('hiding or re-placing a page takes it out of the menus', () => {
    const { s, products, go } = tree()
    let m = addToMenu(s, EX, 'main', { page: products })
    m = addToMenu(m, EX, 'main', { page: go }, products)
    const hidden = setHidden(m, products, true)
    expect(JSON.stringify(hidden.menus)).not.toContain(products)
    expect(JSON.stringify(hidden.menus)).not.toContain(go)
    expect(setPlacement(s, go, 'hidden').pages.find((p) => p.id === go)?.placement).toBe('hidden')
  })

  test('deleting a page removes its menu entries and moves its children up', () => {
    const { s, products, go } = tree()
    const m = addToMenu(s, EX, 'footer', { page: products })
    const d = deletePage(m, products)
    expect(d.pages.find((p) => p.id === products)).toBeUndefined()
    expect(d.pages.find((p) => p.id === go)?.parent).toBeNull()
    expect(pathOf(d, go)).toBe('example.com/go')
    expect(d.menus[EX]?.footer).toEqual([])
    expect(() => deletePage(s, 'home')).toThrow('home')
  })
})

describe('menus (M3 Done when)', () => {
  test('a hidden page cannot be added to any menu', () => {
    const { s, products, go } = tree()
    const h = setHidden(s, products, true)
    for (const menu of ['main', 'footer', 'utility'] as const) {
      expect(() => addToMenu(h, EX, menu, { page: products })).toThrow('hidden')
      // Hidden through its parent counts too.
      expect(() => addToMenu(h, EX, menu, { page: go })).toThrow('hidden')
    }
  })

  test("a page on another address cannot be added to this address's menus", () => {
    const { s, products } = tree()
    const two = addRoot(s, 'go.example.com')
    const other = page(two, { title: 'FAQ', slug: 'faq', root: 'go.example.com', type: 'core' })
    expect(() => addToMenu(other.structure, EX, 'main', { page: other.id })).toThrow('address')
    expect(() => addToMenu(other.structure, 'go.example.com', 'main', { page: products })).toThrow(
      'address',
    )
    const ok = addToMenu(other.structure, 'go.example.com', 'main', { page: other.id })
    expect(ok.menus['go.example.com']?.main).toEqual([{ page: other.id, label: 'FAQ' }])
  })

  test('menu limits come from the pattern', () => {
    expect(MENU_LIMITS['top-bar'].main).toEqual({ items: 7, depth: 2 })
    expect(MENU_LIMITS['top-bar'].footer.items).toBe(12)
    expect(MENU_LIMITS['top-bar'].utility.items).toBe(4)
    let s = empty()
    for (let i = 0; i < 8; i++)
      s = page(s, { title: `P${i}`, slug: `p${i}`, type: 'core' }).structure
    for (let i = 0; i < 7; i++) s = addToMenu(s, EX, 'main', { page: `p${i}` })
    expect(() => addToMenu(s, EX, 'main', { page: 'p7' })).toThrow('limit')
    // The same page twice in one menu is refused; utility holds four.
    expect(() => addToMenu(s, EX, 'main', { page: 'p0' })).toThrow('already')
    for (let i = 0; i < 4; i++) s = addToMenu(s, EX, 'utility', { page: `p${i}` })
    expect(() => addToMenu(s, EX, 'utility', { page: 'p4' })).toThrow('limit')
    // A pattern with more room accepts the eighth.
    const mega: Structure = { ...s, pattern: 'mega-menu' }
    expect(addToMenu(mega, EX, 'main', { page: 'p7' }).menus[EX]?.main).toHaveLength(8)
  })

  test('depth comes from the pattern: top-bar allows one level of children, no more', () => {
    const { s, products, go, about } = tree()
    let m = addToMenu(s, EX, 'main', { page: products })
    m = addToMenu(m, EX, 'main', { page: go }, products)
    expect(m.menus[EX]?.main[0]?.children).toEqual([{ page: go, label: 'Go' }])
    const deep = addPage(m, { title: 'Deep', slug: 'deep', parent: go, type: 'core' })
    expect(() => addToMenu(deep.structure, EX, 'main', { page: deep.id }, go)).toThrow('depth')
    // Footer is flat.
    expect(() => addToMenu(m, EX, 'footer', { page: go }, about)).toThrow('depth')
    const onePage: Structure = { ...s, pattern: 'one-page' }
    expect(() => addToMenu(onePage, EX, 'main', { page: go }, products)).toThrow()
  })

  test('menu items can be https links, with a label; other links are refused', () => {
    const s = empty()
    const m = addToMenu(s, EX, 'utility', { url: 'https://example.org/login', label: 'Log in' })
    expect(m.menus[EX]?.utility).toEqual([{ url: 'https://example.org/login', label: 'Log in' }])
    expect(() => addToMenu(s, EX, 'utility', { url: 'http://x.org', label: 'x' })).toThrow('https')
    expect(() => addToMenu(s, EX, 'utility', { url: 'https://x.org' })).toThrow('label')
    expect(() => addToMenu(s, EX, 'utility', { page: 'nope' })).toThrow('page')
  })
})

describe('removing menu items and reordering pages', () => {
  test('a menu item is removed by page or by url, children included', () => {
    const { s, products, go, about } = tree()
    let m = addToMenu(s, EX, 'main', { page: products })
    m = addToMenu(m, EX, 'main', { page: go }, products)
    m = addToMenu(m, EX, 'main', { page: about })
    m = addToMenu(m, EX, 'footer', { url: 'https://x.dev/a', label: 'A' })
    const sub = removeFromMenu(m, EX, 'main', { page: go })
    expect(sub.menus[EX]?.main[0]?.children).toEqual([])
    const top = removeFromMenu(m, EX, 'main', { page: products })
    expect(top.menus[EX]?.main).toEqual([{ page: about, label: 'About' }])
    expect(removeFromMenu(m, EX, 'footer', { url: 'https://x.dev/a' }).menus[EX]?.footer).toEqual(
      [],
    )
    expect(() => removeFromMenu(m, EX, 'utility', { page: about })).toThrow('not in')
    expect(() => removeFromMenu(m, EX, 'main', {})).toThrow('page or a url')
  })

  test('a page moves up or down among its siblings only', () => {
    const { s, products, go, about } = tree()
    const order = (x: Structure) => x.pages.map((p) => p.id)
    // Children travel with their parent.
    expect(order(reorderPage(s, about, 'up'))).toEqual(['home', about, products, go])
    expect(order(reorderPage(s, products, 'down'))).toEqual(['home', about, products, go])
    expect(() => reorderPage(s, products, 'up')).toThrow('first')
    expect(() => reorderPage(s, about, 'down')).toThrow('last')
    expect(() => reorderPage(s, 'home', 'down')).toThrow('home')
    const up = reorderPage(s, about, 'up')
    expect(validateStructure(up)).toBe(up)
  })

  test('the API does both', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-structure-'))
    dirs.push(dataDir)
    const db = openDb(':memory:')
    seedTestAccounts(db)
    const app = createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
    const res = await app.request(`${APP}/api/sign-in`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alex', password: 'alex' }),
    })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const { csrf } = (await res.json()) as { csrf: string }
    const call = async (path: string, body: unknown) => {
      const r = await app.request(`${APP}/api${path}`, {
        method: 'POST',
        headers: {
          origin: APP,
          'content-type': 'application/json',
          cookie,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify(body),
      })
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      return { status: r.status, body: (await r.json()) as Record<string, any> }
    }
    await call('/projects', { name: 'Go' })
    await call('/p/go/structure/add-page', { title: 'A', slug: 'a', type: 'core' })
    await call('/p/go/structure/add-page', { title: 'B', slug: 'b', type: 'core' })
    const up = await call('/p/go/structure/reorder-page', { id: 'b', direction: 'up' })
    expect(up.body.structure.pages.map((p: { id: string }) => p.id)).toEqual(['home', 'b', 'a'])
    expect((await call('/p/go/structure/reorder-page', { id: 'b', direction: 'up' })).status).toBe(
      400,
    )
    await call('/p/go/structure/add-to-menu', { root: EX, menu: 'main', page: 'a' })
    const rm = await call('/p/go/structure/remove-from-menu', { root: EX, menu: 'main', page: 'a' })
    expect(rm.status).toBe(200)
    expect(rm.body.structure.menus[EX].main).toEqual([])
  })
})

describe('address requests', () => {
  test('names are lower-case letters, digits and hyphens', () => {
    const { s, about } = tree()
    for (const name of ['Go', 'a.b', 'a b', '', 'a_b'])
      expect(() => requestAddress(s, { name, pageId: about, note: '', ...NOW })).toThrow(
        StructureError,
      )
    const r = requestAddress(s, { name: 'go-2', pageId: about, note: 'For the newsletter', ...NOW })
    expect(r.addressRequests).toEqual([
      { name: 'go-2', pageId: about, note: 'For the newsletter', status: 'pending', ...NOW },
    ])
  })

  test('reserved names are refused', () => {
    const { s, about } = tree()
    for (const name of ['www', 'api', 'admin', 'preview', 'staging', 'studio'])
      expect(() => requestAddress(s, { name, pageId: about, note: '', ...NOW })).toThrow('reserved')
  })

  test('a name already taken, by a root or a request, is refused; a declined one is free', () => {
    const { s, about } = tree()
    const req = (st: Structure, name: string, pageId = about) =>
      requestAddress(st, { name, pageId, note: '', ...NOW })
    expect(() => req(addRoot(s, 'go.example.com'), 'go')).toThrow('taken')
    const asked = req(s, 'promo')
    expect(() => req(asked, 'promo')).toThrow('taken')
    const declined: Structure = {
      ...asked,
      addressRequests: asked.addressRequests.map((r) => ({ ...r, status: 'declined' as const })),
    }
    expect(() => req(declined, 'promo')).not.toThrow()
    expect(() => req(s, 'x', 'nope')).toThrow('page')
  })
})

describe('navigation checks (plan 10.2)', () => {
  const kinds = (s: Structure, approved = new Set<string>()) =>
    navigationChecks(s, approved).map((f) => f.check)

  test('a clean structure has no findings', () => {
    const { s, products, about } = tree()
    let m = addToMenu(s, EX, 'main', { page: products })
    m = addToMenu(m, EX, 'main', { page: about })
    expect(navigationChecks(m, new Set())).toEqual([])
  })

  test('a menu item pointing to no page is reported', () => {
    const { s, products, about } = tree()
    let m = addToMenu(s, EX, 'main', { page: products })
    m = addToMenu(m, EX, 'main', { page: about })
    const bad: Structure = {
      ...m,
      menus: {
        [EX]: {
          main: [...(m.menus[EX]?.main ?? []), { page: 'ghost', label: 'Ghost' }],
          footer: [],
          utility: [],
        },
      },
    }
    expect(navigationChecks(bad, new Set())).toEqual([
      expect.objectContaining({ check: 'menu-item-missing-page', menu: 'main' }),
    ])
  })

  test('a hidden page in a menu is reported', () => {
    const { s, products, about } = tree()
    let m = addToMenu(s, EX, 'main', { page: products })
    m = addToMenu(m, EX, 'main', { page: about })
    const bad: Structure = {
      ...m,
      pages: m.pages.map((p) => (p.id === about ? { ...p, placement: 'hidden' as const } : p)),
    }
    expect(navigationChecks(bad, new Set())).toEqual([
      expect.objectContaining({ check: 'hidden-in-menu', page: about }),
    ])
  })

  test('a visible page nobody can reach is reported; a child of a reachable page is reachable', () => {
    const { s, products, go, about } = tree()
    const m = addToMenu(s, EX, 'main', { page: products })
    const found = navigationChecks(m, new Set())
    // go sits under products (section navigation and breadcrumbs); about is nowhere.
    expect(found.map((f) => f.page)).toEqual([about])
    expect(found[0]?.check).toBe('unreachable')
    expect(found.some((f) => f.page === go)).toBe(false)
    // Hidden pages are not asked to be reachable.
    expect(kinds(setHidden(m, about, true))).toEqual([])
  })

  test('a menu that does not fit the pattern is reported', () => {
    const { s, products, about } = tree()
    const over: Structure = {
      ...s,
      menus: {
        [EX]: {
          main: Array.from({ length: 8 }, (_, i) => ({
            page: i % 2 ? about : products,
            label: 'P',
          })),
          footer: [],
          utility: [],
        },
      },
    }
    expect(navigationChecks(over, new Set())).toEqual([
      expect.objectContaining({ check: 'menu-over-pattern', menu: 'main' }),
    ])
  })

  test('a moved page from an approved revision without a redirect is reported', () => {
    const { s, products, about } = tree()
    const approved = new Set(['example.com/products', 'example.com/products/go'])
    const moved = movePage(s, products, { parent: about, approvedPaths: approved })
    expect(kinds(moved, approved)).not.toContain('redirect-missing')
    const lost: Structure = { ...moved, redirects: [] }
    const findings = navigationChecks(lost, approved).filter((f) => f.check === 'redirect-missing')
    expect(findings.map((f) => f.path)).toEqual(['example.com/products', 'example.com/products/go'])
  })
})

describe('pages and their jobs', () => {
  test("the text follows the tree, with numbers and each page's job", () => {
    let s = empty()
    const a = page(s, {
      title: 'Products',
      slug: 'products',
      type: 'core',
      miniBrief: { goal: 'Show what we sell', visitorAction: 'Pick one' },
    })
    s = a.structure
    s = page(s, { title: 'Go', slug: 'go', parent: a.id, type: 'core' }).structure
    expect(pagesAndJobsText(s)).toBe(
      ['1. Home: Not set yet.', '2. Products: Show what we sell', '2.1. Go: Not set yet.'].join(
        '\n',
      ),
    )
    expect(pagesAndJobsText(addRoot(s, 'go.example.com'))).toContain('go.example.com')
  })
})

describe('the structure API', () => {
  async function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-structure-'))
    dirs.push(dataDir)
    const db = openDb(':memory:')
    seedTestAccounts(db)
    const app = createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
    const as = async (handle: string) => {
      const res = await app.request(`${APP}/api/sign-in`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ handle, password: handle }),
      })
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      const { csrf } = (await res.json()) as { csrf: string }
      return async (method: string, path: string, body?: unknown) => {
        const r = await app.request(`${APP}${path}`, {
          method,
          headers: {
            origin: APP,
            'content-type': 'application/json',
            cookie,
            'x-csrf-token': csrf,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        // biome-ignore lint/suspicious/noExplicitAny: test helper
        return { status: r.status, body: (await r.json()) as Record<string, any> }
      }
    }
    return { db, as }
  }

  test('non-members get 404 on every route', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Go' })
    const rune = await as('rune')
    expect((await rune('GET', '/api/p/go/structure')).status).toBe(404)
    const add = { title: 'X', slug: 'x', type: 'core' }
    expect((await rune('POST', '/api/p/go/structure/add-page', add)).status).toBe(404)
    const ask = { name: 'x', pageId: 'home' }
    expect((await rune('POST', '/api/p/go/structure/request-address', ask)).status).toBe(404)
    expect((await alex('GET', '/api/p/go/structure')).status).toBe(200)
  })

  test('GET gives a fresh structure, findings and the generated text', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Go' })
    const r = await alex('GET', '/api/p/go/structure')
    expect(r.body.structure.pages).toHaveLength(1)
    expect(r.body.findings).toEqual([])
    expect(r.body.pagesAndJobs).toBe('1. Home: Not set yet.')
  })

  test('actions change the caller’s draft, and bad input is a 400 with a code', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Go' })
    const p = '/api/p/go/structure'
    const add = await alex('POST', `${p}/add-page`, {
      title: 'Products',
      slug: 'products',
      type: 'core',
    })
    expect(add.status).toBe(200)
    const id = add.body.id as string
    expect(
      (await alex('POST', `${p}/add-page`, { title: 'P', slug: 'products', type: 'core' })).status,
    ).toBe(400)
    expect(
      (await alex('POST', `${p}/add-page`, { title: 'P', slug: 'Bad', type: 'core' })).body.code,
    ).toBe('bad-structure')
    expect(
      (await alex('POST', `${p}/add-page`, { title: 'P', slug: 'p', type: 'nope' })).status,
    ).toBe(400)
    const menu = await alex('POST', `${p}/add-to-menu`, { root: EX, menu: 'main', page: id })
    expect(menu.status).toBe(200)
    expect(menu.body.structure.menus[EX].main).toHaveLength(1)
    const hid = await alex('POST', `${p}/set-hidden`, { id, hidden: true })
    expect(hid.body.structure.menus[EX].main).toHaveLength(0)
    expect(
      (await alex('POST', `${p}/add-to-menu`, { root: EX, menu: 'main', page: id })).status,
    ).toBe(400)
    const move = await alex('POST', `${p}/move-page`, { id, parent: null, slug: 'offer' })
    expect(move.body.structure.pages.find((x: { id: string }) => x.id === id).slug).toBe('offer')
    const req = await alex('POST', `${p}/request-address`, {
      name: 'promo',
      pageId: id,
      note: 'hi',
    })
    expect(req.body.structure.addressRequests[0]).toMatchObject({
      name: 'promo',
      by: 'alex',
      status: 'pending',
    })
    expect((await alex('POST', `${p}/request-address`, { name: 'www', pageId: id })).status).toBe(
      400,
    )
    const del = await alex('POST', `${p}/delete-page`, { id })
    expect(del.body.structure.pages).toHaveLength(1)
    expect((await alex('POST', `${p}/nonsense`, {})).status).toBe(400)
    // What was saved is what comes back.
    expect((await alex('GET', p)).body.structure.addressRequests).toHaveLength(1)
  })
})
