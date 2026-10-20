// Client-side view of structure.json (plan §10; server/structure/structure.ts is the authority:
// every change goes through the API and the server's refusals are shown as they come).
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
  miniBrief?: { goal: string; visitorAction: string; expires?: string }
}
export type MenuItem = { page?: string; url?: string; label: string; children?: MenuItem[] }
export type Structure = {
  roots: { address: string; home: string }[]
  pages: Page[]
  pattern: Pattern
  menus: Record<string, Record<MenuName, MenuItem[]>>
  redirects: { from: string; to: string }[]
  addressRequests: { name: string; pageId: string; status: string }[]
}
export type Finding = {
  check: string
  message: string
  page?: string
  menu?: MenuName
  root?: string
}
export type StructureView = { structure: Structure; findings: Finding[]; pagesAndJobs: string }

export const MENUS: MenuName[] = ['main', 'footer', 'utility']
export const PATTERNS: Pattern[] = ['top-bar', 'mega-menu', 'sidebar', 'overlay', 'one-page']
export const TYPES: PageType[] = ['core', 'landing', 'campaign', 'customer-story']

/** Mirrors the server's fixed limits (decision #44) so the screen can show "n of max". */
export const LIMITS: Record<Pattern, Record<MenuName, { items: number; depth: number }>> = {
  'top-bar': {
    main: { items: 7, depth: 2 },
    footer: { items: 12, depth: 1 },
    utility: { items: 4, depth: 1 },
  },
  'mega-menu': {
    main: { items: 8, depth: 3 },
    footer: { items: 12, depth: 1 },
    utility: { items: 4, depth: 1 },
  },
  sidebar: {
    main: { items: 12, depth: 3 },
    footer: { items: 12, depth: 1 },
    utility: { items: 4, depth: 1 },
  },
  overlay: {
    main: { items: 10, depth: 2 },
    footer: { items: 12, depth: 1 },
    utility: { items: 4, depth: 1 },
  },
  'one-page': {
    main: { items: 6, depth: 1 },
    footer: { items: 12, depth: 1 },
    utility: { items: 4, depth: 1 },
  },
}

export const DEFAULT_PLACEMENT: Record<PageType, Placement> = {
  core: 'menu',
  landing: 'hidden',
  campaign: 'hidden',
  'customer-story': 'menu',
}

export const page = (s: Structure, id: string) => s.pages.find((p) => p.id === id)

export function pathOf(s: Structure, id: string): string {
  const parts: string[] = []
  const first = page(s, id)
  for (let p = first; p; p = p.parent ? page(s, p.parent) : undefined)
    if (p.slug) parts.unshift(p.slug)
  return `${first?.root ?? ''}/${parts.join('/')}`
}

/** The first hidden page on the way up, the page itself included. */
export function hiddenBy(s: Structure, id: string): Page | undefined {
  for (let p = page(s, id); p; p = p.parent ? page(s, p.parent) : undefined)
    if (p.placement === 'hidden') return p
  return undefined
}

export type Node = { page: Page; depth: number; num: string }

/** Pages of one address in tree order, numbered 1, 1.1, 1.2 … */
export function treeOf(s: Structure, root: string): Node[] {
  const out: Node[] = []
  const walk = (parent: string | null, depth: number, prefix: string) => {
    s.pages
      .filter((p) => p.root === root && p.parent === parent)
      .forEach((p, i) => {
        const num = `${prefix}${i + 1}`
        out.push({ page: p, depth, num })
        walk(p.id, depth + 1, `${num}.`)
      })
  }
  walk(null, 1, '')
  return out
}

export function menusHolding(s: Structure, id: string): MenuName[] {
  const p = page(s, id)
  const m = p && s.menus[p.root]
  if (!m) return []
  const has = (items: MenuItem[]): boolean =>
    items.some((i) => i.page === id || (i.children ? has(i.children) : false))
  return MENUS.filter((n) => has(m[n]))
}

export const countItems = (items: MenuItem[]) => items.length
