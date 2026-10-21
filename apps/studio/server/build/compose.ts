// Compose a page (plan §9.1): the header partial right after <body…>, the footer before </body>,
// and the structure's main menu in the header's first <nav> as relative links between pages.
import type { MenuItem } from '../structure/structure.ts'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The relative link from the folder `from` to the page in folder `to` ('' is the site root). */
export function relativeLink(from: string, to: string): string {
  const a = from ? from.split('/') : []
  const b = to ? to.split('/') : []
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  const rel = [...Array<string>(a.length - common).fill('..'), ...b.slice(common)]
  return [...rel, 'index.html'].join('/')
}

/** The menu as nested lists. `dirOf` returns a built page's folder, or null if it isn't built. */
export function menuHtml(
  items: MenuItem[],
  from: string,
  dirOf: (pageId: string) => string | null,
): string {
  const li = (item: MenuItem): string => {
    const kids = menuHtml(item.children ?? [], from, dirOf)
    let href: string | null = null
    if (item.page) {
      const dir = dirOf(item.page)
      if (dir !== null) href = relativeLink(from, dir)
    } else if (item.url) href = item.url
    // An item whose page isn't built has no link; its children still show.
    if (href === null) return kids.replace(/^<ul>|<\/ul>$/g, '')
    return `<li><a href="${esc(href)}">${esc(item.label)}</a>${kids}</li>`
  }
  const inner = items.map(li).join('')
  return inner ? `<ul>${inner}</ul>` : ''
}

export function fillNav(header: string, menu: string): string {
  return header.replace(
    /(<nav\b[^>]*>)[\s\S]*?(<\/nav>)/i,
    (_m, open: string, close: string) => `${open}${menu}${close}`,
  )
}

export function compose(
  html: string,
  partials: { header?: string; footer?: string },
  menu: string,
): string {
  let out = html
  const body = /<body\b[^>]*>/i.exec(out)
  if (partials.header && body) {
    const at = body.index + body[0].length
    out = out.slice(0, at) + fillNav(partials.header, menu) + out.slice(at)
  }
  if (partials.footer) {
    const at = out.toLowerCase().lastIndexOf('</body>')
    if (at >= 0) out = out.slice(0, at) + partials.footer + out.slice(at)
  }
  return out
}

/** Point the stylesheet link at the hashed name; every other attribute stays as written. */
export function relinkCss(html: string, from: string, to: string): string {
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(<link\\b[^>]*?\\bhref\\s*=\\s*)(["'])(?:\\./)?${name}\\2`, 'gi')
  return html.replace(re, (_m, pre: string, q: string) => `${pre}${q}${to}${q}`)
}
