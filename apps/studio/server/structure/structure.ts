// The site structure as a document (plan §10; contracts/structure.schema.json; decision #44).
// Pure functions: every change returns a new Structure and throws StructureError on a bad request.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/structure.schema.json'), 'utf8'),
)
const validate = addFormats(new Ajv2020({ strict: false })).compile(schema)

export type PageType = 'core' | 'landing' | 'campaign' | 'customer-story'
export type Placement = 'menu' | 'hidden' | 'own-address'
export type Pattern = 'top-bar' | 'mega-menu' | 'sidebar' | 'overlay' | 'one-page'
export type MenuName = 'main' | 'footer' | 'utility'
export type Page = {
  id: string
  title: string
  slug: string
  parent: string | null
  root: string
  type: PageType
  placement: Placement
  status: 'decided' | 'proposed' | 'added-later'
  allowSearch?: boolean
  miniBrief?: { goal: string; visitorAction: string; expires?: string }
}
export type MenuItem = { page?: string; url?: string; label: string; children?: MenuItem[] }
export type Structure = {
  roots: { address: string; home: string }[]
  pages: Page[]
  pattern: Pattern
  menus: Record<string, Record<MenuName, MenuItem[]>>
  redirects: { from: string; to: string }[]
  addressRequests: {
    name: string
    pageId: string
    note: string
    status: 'pending' | 'approved' | 'declined'
    by: string
    at: string
  }[]
}

export class StructureError extends Error {}

const SLUG = /^[a-z0-9-]+$/
const ADDRESS = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const RESERVED = ['www', 'api', 'admin', 'preview', 'staging', 'studio']

/** Fixed defaults per pattern (decision #44): items per level, and how many levels deep. */
const FLAT = { footer: { items: 12, depth: 1 }, utility: { items: 4, depth: 1 } }
export const MENU_LIMITS: Record<Pattern, Record<MenuName, { items: number; depth: number }>> = {
  'top-bar': { main: { items: 7, depth: 2 }, ...FLAT },
  'mega-menu': { main: { items: 8, depth: 3 }, ...FLAT },
  sidebar: { main: { items: 12, depth: 3 }, ...FLAT },
  overlay: { main: { items: 10, depth: 2 }, ...FLAT },
  'one-page': { main: { items: 6, depth: 1 }, ...FLAT },
}

const DEFAULT_PLACEMENT: Record<PageType, Placement> = {
  core: 'menu',
  landing: 'hidden',
  campaign: 'hidden',
  'customer-story': 'menu',
}

const fail = (m: string): never => {
  throw new StructureError(m)
}

export function validateStructure(s: Structure): Structure {
  if (!validate(s)) {
    const e = validate.errors?.[0]
    fail(`structure.json is not valid: ${e?.instancePath ?? ''} ${e?.message ?? ''}`.trim())
  }
  return s
}

const emptyMenus = (): Record<MenuName, MenuItem[]> => ({ main: [], footer: [], utility: [] })

export function emptyStructure(projectAddress: string): Structure {
  return addRoot(
    { roots: [], pages: [], pattern: 'top-bar', menus: {}, redirects: [], addressRequests: [] },
    projectAddress,
  )
}

/** A new address: a root of its own, with its own home page. */
export function addRoot(s: Structure, address: string, homeTitle = 'Home'): Structure {
  if (!ADDRESS.test(address)) fail(`"${address}" is not a valid address`)
  if (s.roots.some((r) => r.address === address)) fail(`The address ${address} already exists`)
  const home = uniqueId(s, s.roots.length ? `${address.split('.')[0]}-home` : 'home')
  return {
    ...s,
    roots: [...s.roots, { address, home }],
    pages: [
      ...s.pages,
      {
        id: home,
        title: homeTitle,
        slug: '',
        parent: null,
        root: address,
        type: 'core',
        placement: 'menu',
        status: 'decided',
      },
    ],
    menus: { ...s.menus, [address]: emptyMenus() },
  }
}

const find = (s: Structure, id: string): Page => {
  const p = s.pages.find((x) => x.id === id)
  return p ?? fail(`No such page: ${id}`)
}

function uniqueId(s: Structure, base: string): string {
  const taken = new Set(s.pages.map((p) => p.id))
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

function checkSlug(s: Structure, slug: string, root: string, parent: string | null, self?: string) {
  if (!SLUG.test(slug)) fail('A slug is lower-case letters, digits and hyphens')
  if (
    s.pages.some((p) => p.id !== self && p.root === root && p.parent === parent && p.slug === slug)
  )
    fail(`The slug "${slug}" is taken here`)
}

export function pathOf(s: Structure, id: string): string {
  const parts: string[] = []
  const root = find(s, id).root
  for (let p: Page | undefined = find(s, id); p; p = p.parent ? find(s, p.parent) : undefined)
    if (p.slug) parts.unshift(p.slug)
  return `${root}/${parts.join('/')}`
}

export const allPaths = (s: Structure) => new Set(s.pages.map((p) => pathOf(s, p.id)))

export function isHidden(s: Structure, id: string): boolean {
  for (let p: Page | undefined = find(s, id); p; p = p.parent ? find(s, p.parent) : undefined)
    if (p.placement === 'hidden') return true
  return false
}

function descendants(s: Structure, id: string): Page[] {
  const out: Page[] = []
  for (const c of s.pages.filter((p) => p.parent === id)) out.push(c, ...descendants(s, c.id))
  return out
}

export function addPage(
  s: Structure,
  o: {
    title: string
    slug: string
    type: PageType
    parent?: string | null
    root?: string
    placement?: Placement
    status?: Page['status']
    miniBrief?: Page['miniBrief']
  },
): { structure: Structure; id: string } {
  const parent = o.parent ?? null
  const root = parent ? find(s, parent).root : (o.root ?? s.roots[0]?.address ?? '')
  if (!s.roots.some((r) => r.address === root)) fail(`No such address: ${root}`)
  if (!o.title.trim()) fail('A page needs a title')
  checkSlug(s, o.slug, root, parent)
  if (o.type === 'campaign' && !o.miniBrief?.expires) fail('A campaign needs an expiry date')
  const id = uniqueId(s, o.slug)
  const page: Page = {
    id,
    title: o.title.trim(),
    slug: o.slug,
    parent,
    root,
    type: o.type,
    placement: o.placement ?? DEFAULT_PLACEMENT[o.type],
    status: o.status ?? 'added-later',
    ...(o.miniBrief ? { miniBrief: o.miniBrief } : {}),
  }
  return { structure: { ...s, pages: [...s.pages, page] }, id }
}

function dropFromMenus(s: Structure, ids: Set<string>): Structure {
  const clean = (items: MenuItem[]): MenuItem[] =>
    items
      .filter((i) => !(i.page && ids.has(i.page)))
      .map((i) => (i.children ? { ...i, children: clean(i.children) } : i))
  const menus = Object.fromEntries(
    Object.entries(s.menus).map(([root, m]) => [
      root,
      { main: clean(m.main), footer: clean(m.footer), utility: clean(m.utility) },
    ]),
  )
  return { ...s, menus }
}

export function movePage(
  s: Structure,
  id: string,
  o: { parent: string | null; slug?: string; root?: string; approvedPaths: Set<string> },
): Structure {
  const page = find(s, id)
  if (s.roots.some((r) => r.home === id)) fail('A home page stays where it is')
  if (o.parent && (o.parent === id || descendants(s, id).some((d) => d.id === o.parent)))
    fail('A page cannot move into itself or its own children')
  const root = o.parent ? find(s, o.parent).root : (o.root ?? page.root)
  if (!s.roots.some((r) => r.address === root)) fail(`No such address: ${root}`)
  const slug = o.slug ?? page.slug
  checkSlug(s, slug, root, o.parent, id)
  const subtree = [page, ...descendants(s, id)]
  const inSubtree = new Set(subtree.map((p) => p.id))
  const before = new Map(subtree.map((p) => [p.id, pathOf(s, p.id)]))
  const moved: Structure = {
    ...s,
    pages: s.pages.map((p) =>
      p.id === id
        ? { ...p, parent: o.parent, slug, root }
        : inSubtree.has(p.id)
          ? { ...p, root }
          : p,
    ),
  }
  let redirects = s.redirects
  for (const p of subtree) {
    const from = before.get(p.id) as string
    const to = pathOf(moved, p.id)
    if (from === to) continue
    if (o.approvedPaths.has(from))
      redirects = [...redirects.filter((r) => r.from !== from), { from, to }]
    // Earlier redirects to the old address follow the page, so there are no chains.
    redirects = redirects.map((r) => (r.to === from ? { ...r, to } : r))
  }
  const now = new Set(subtree.map((p) => pathOf(moved, p.id)))
  return { ...moved, redirects: redirects.filter((r) => !now.has(r.from)) }
}

export function setPlacement(s: Structure, id: string, placement: Placement): Structure {
  find(s, id)
  const next: Structure = {
    ...s,
    pages: s.pages.map((p) => (p.id === id ? { ...p, placement } : p)),
  }
  // Hidden pages, and everything below them, are out of every menu.
  return placement === 'hidden'
    ? dropFromMenus(next, new Set([id, ...descendants(s, id).map((d) => d.id)]))
    : next
}

export const setHidden = (s: Structure, id: string, hidden: boolean) =>
  setPlacement(s, id, hidden ? 'hidden' : 'menu')

export function deletePage(s: Structure, id: string): Structure {
  const page = find(s, id)
  if (s.roots.some((r) => r.home === id)) fail('A home page cannot be deleted')
  const rest = s.pages.filter((p) => p.id !== id)
  // Children move up one level, keeping their order.
  for (const k of s.pages.filter((p) => p.parent === id)) {
    checkSlug({ ...s, pages: rest }, k.slug, k.root, page.parent, k.id)
    rest[rest.findIndex((p) => p.id === k.id)] = { ...k, parent: page.parent }
  }
  return dropFromMenus({ ...s, pages: rest }, new Set([id]))
}

export function setPattern(s: Structure, pattern: Pattern): Structure {
  if (!(pattern in MENU_LIMITS)) fail(`Unknown navigation pattern: ${pattern}`)
  return { ...s, pattern }
}

function locate(
  items: MenuItem[],
  page: string,
  depth = 1,
): { item: MenuItem; depth: number } | null {
  for (const i of items) {
    if (i.page === page) return { item: i, depth }
    const hit = i.children ? locate(i.children, page, depth + 1) : null
    if (hit) return hit
  }
  return null
}

export function addToMenu(
  s: Structure,
  root: string,
  menu: MenuName,
  item: { page?: string; url?: string; label?: string },
  under?: string,
): Structure {
  if (!s.roots.some((r) => r.address === root)) fail(`No such address: ${root}`)
  if (!['main', 'footer', 'utility'].includes(menu)) fail(`No such menu: ${menu}`)
  const limits = MENU_LIMITS[s.pattern][menu]
  const menus = structuredClone(s.menus[root] ?? emptyMenus())
  const items = menus[menu]
  let entry: MenuItem
  if (item.page !== undefined) {
    const p = find(s, item.page)
    if (p.root !== root)
      fail(`${p.title} lives on another address and cannot go in this address's menus`)
    if (isHidden(s, p.id)) fail(`${p.title} is hidden and cannot go in a menu`)
    if (locate(items, p.id)) fail(`${p.title} is already in this menu`)
    entry = { page: p.id, label: item.label?.trim() || p.title }
  } else {
    if (!item.url?.startsWith('https://') || !URL.canParse(item.url))
      fail('A link must be an https address')
    if (!item.label?.trim()) fail('A link needs a label')
    entry = { url: item.url, label: (item.label as string).trim() }
  }
  const full = () =>
    fail(`The ${menu} menu is at its limit of ${limits.items} items for the ${s.pattern} pattern`)
  if (under) {
    if (limits.depth < 2)
      fail(`The ${menu} menu is flat in the ${s.pattern} pattern (depth limit ${limits.depth})`)
    const parent = locate(items, under) ?? fail('The parent page is not in this menu')
    if (parent.depth + 1 > limits.depth)
      fail(`The ${menu} menu is at its depth limit of ${limits.depth}`)
    if ((parent.item.children?.length ?? 0) >= limits.items) full()
    parent.item.children = [...(parent.item.children ?? []), entry]
  } else {
    if (items.length >= limits.items) full()
    items.push(entry)
  }
  return { ...s, menus: { ...s.menus, [root]: menus } }
}

export function removeFromMenu(
  s: Structure,
  root: string,
  menu: MenuName,
  item: { page?: string; url?: string },
): Structure {
  if (!s.roots.some((r) => r.address === root)) fail(`No such address: ${root}`)
  if (!['main', 'footer', 'utility'].includes(menu)) fail(`No such menu: ${menu}`)
  if (item.page === undefined && item.url === undefined) fail('Name a page or a url to remove')
  const menus = structuredClone(s.menus[root] ?? emptyMenus())
  let found = false
  const clean = (items: MenuItem[]): MenuItem[] =>
    items
      .filter((i) => {
        const hit = !found && (item.page !== undefined ? i.page === item.page : i.url === item.url)
        if (hit) found = true
        return !hit
      })
      .map((i) => (i.children ? { ...i, children: clean(i.children) } : i))
  menus[menu] = clean(menus[menu])
  if (!found) fail('That item is not in this menu')
  return { ...s, menus: { ...s.menus, [root]: menus } }
}

/** Sibling order is the order of the pages array (the tree and its numbers follow it). */
export function reorderPage(s: Structure, id: string, direction: 'up' | 'down'): Structure {
  const page = find(s, id)
  if (s.roots.some((r) => r.home === id)) fail('A home page stays where it is')
  if (direction !== 'up' && direction !== 'down') fail('Move a page up or down')
  const homes = new Set(s.roots.map((r) => r.home)) // a home page always stays first
  const sibs = s.pages.filter(
    (p) => p.root === page.root && p.parent === page.parent && !homes.has(p.id),
  )
  const i = sibs.findIndex((p) => p.id === id)
  const other = sibs[direction === 'up' ? i - 1 : i + 1]
  if (!other)
    throw new StructureError(
      direction === 'up' ? 'It is already the first' : 'It is already the last',
    )
  const pages = [...s.pages]
  const a = pages.findIndex((p) => p.id === id)
  const b = pages.findIndex((p) => p.id === other.id)
  ;[pages[a], pages[b]] = [pages[b] as Page, pages[a] as Page]
  // Swapping alone would split subtrees; keep each page's descendants right after it.
  const kids = (pid: string): Page[] =>
    pages.filter((p) => p.parent === pid).flatMap((k) => [k, ...kids(k.id)])
  const moving = new Set([...kids(id), ...kids(other.id)].map((p) => p.id))
  const rest = pages.filter((p) => !moving.has(p.id))
  for (const pid of [id, other.id]) {
    const at = rest.findIndex((p) => p.id === pid)
    rest.splice(at + 1, 0, ...kids(pid))
  }
  return { ...s, pages: rest }
}

export function requestAddress(
  s: Structure,
  o: { name: string; pageId: string; note: string; by: string; at: string },
): Structure {
  if (!SLUG.test(o.name)) fail('A name is lower-case letters, digits and hyphens')
  if (RESERVED.includes(o.name)) fail(`"${o.name}" is a reserved name`)
  find(s, o.pageId)
  const taken =
    s.roots.some((r) => r.address.split('.')[0] === o.name) ||
    s.addressRequests.some((r) => r.name === o.name && r.status !== 'declined')
  if (taken) fail(`The name "${o.name}" is already taken`)
  return {
    ...s,
    addressRequests: [
      ...s.addressRequests,
      { name: o.name, pageId: o.pageId, note: o.note, status: 'pending', by: o.by, at: o.at },
    ],
  }
}

export type Finding = {
  check:
    | 'menu-item-missing-page'
    | 'hidden-in-menu'
    | 'unreachable'
    | 'menu-over-pattern'
    | 'redirect-missing'
  message: string
  page?: string
  menu?: MenuName
  root?: string
  path?: string
}

/** Plan §10.2. `approvedPaths` are the addresses in the approved revision. */
export function navigationChecks(s: Structure, approvedPaths: Set<string>): Finding[] {
  const out: Finding[] = []
  const ids = new Set(s.pages.map((p) => p.id))
  for (const { address: root, home } of s.roots) {
    const menus = s.menus[root] ?? emptyMenus()
    const inMenus = new Set<string>([home])
    for (const menu of ['main', 'footer', 'utility'] as const) {
      const limits = MENU_LIMITS[s.pattern][menu]
      let tooBig = false
      const walk = (items: MenuItem[], depth: number) => {
        if (depth > limits.depth || items.length > limits.items) tooBig = true
        for (const i of items) {
          if (i.page !== undefined) {
            inMenus.add(i.page)
            if (!ids.has(i.page))
              out.push({
                check: 'menu-item-missing-page',
                message: `"${i.label}" in the ${menu} menu points to a page that does not exist`,
                page: i.page,
                menu,
                root,
              })
            else if (isHidden(s, i.page))
              out.push({
                check: 'hidden-in-menu',
                message: `"${i.label}" is hidden but sits in the ${menu} menu`,
                page: i.page,
                menu,
                root,
              })
          }
          if (i.children) walk(i.children, depth + 1)
        }
      }
      walk(menus[menu], 1)
      if (tooBig)
        out.push({
          check: 'menu-over-pattern',
          message: `The ${menu} menu on ${root} does not fit the ${s.pattern} pattern`,
          menu,
          root,
        })
    }
    // Reachable: in a menu, or under a reachable page (section navigation and breadcrumbs).
    const reachable = (p: Page): boolean =>
      inMenus.has(p.id) || (p.parent !== null && reachable(find(s, p.parent)))
    for (const p of s.pages.filter((x) => x.root === root))
      if (!isHidden(s, p.id) && !reachable(p))
        out.push({
          check: 'unreachable',
          message: `${p.title} is not reachable through any menu or breadcrumb`,
          page: p.id,
          root,
        })
  }
  const live = allPaths(s)
  const redirected = new Set(s.redirects.map((r) => r.from))
  for (const path of [...approvedPaths].sort())
    if (!live.has(path) && !redirected.has(path))
      out.push({
        check: 'redirect-missing',
        message: `${path} moved or went away without a redirect`,
        path,
      })
  return out
}

/** The text for the brief's block "Pages and their jobs" (plan §4.7, §4.9). */
export function pagesAndJobsText(s: Structure): string {
  const lines: string[] = []
  for (const { address } of s.roots) {
    if (s.roots.length > 1) lines.push(address)
    const walk = (parent: string | null, prefix: string) => {
      s.pages
        .filter((p) => p.root === address && p.parent === parent)
        .forEach((p, i) => {
          const n = `${prefix}${i + 1}`
          lines.push(`${n}. ${p.title}: ${p.miniBrief?.goal.trim() || 'Not set yet.'}`)
          walk(p.id, `${n}.`)
        })
    }
    walk(null, '')
  }
  return lines.join('\n')
}
