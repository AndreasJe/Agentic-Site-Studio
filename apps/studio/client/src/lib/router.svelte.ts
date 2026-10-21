// A tiny history router: the server answers every non-API path with index.html.
export const route = $state({ path: location.pathname })

export function navigate(path: string, replace = false) {
  if (path === route.path) return
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  route.path = path
}

addEventListener('popstate', () => {
  route.path = location.pathname
})

/** Use on <a href>: plain clicks navigate inside the app, modified clicks open normally. */
export function link(node: HTMLAnchorElement) {
  const onclick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return
    const href = node.getAttribute('href')
    if (!href?.startsWith('/')) return
    e.preventDefault()
    navigate(href)
  }
  node.addEventListener('click', onclick)
  return { destroy: () => node.removeEventListener('click', onclick) }
}

export type Match =
  | { name: 'sign-in' }
  | { name: 'projects' }
  | { name: 'media' }
  | { name: 'brand' }
  | { name: 'brand-assets' }
  | { name: 'project'; id: string }
  | { name: 'revisions'; id: string }
  | { name: 'brief'; id: string }
  | { name: 'structure'; id: string }
  | { name: 'new-page'; id: string }
  | { name: 'design'; id: string }
  | { name: 'design-editor'; id: string; artboard: number }
  | { name: 'review'; id: string; rev?: string }
  | { name: 'not-found' }

export function match(path: string): Match {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/sign-in') return { name: 'sign-in' }
  if (p === '/' || p === '/projects') return { name: 'projects' }
  if (p === '/media') return { name: 'media' }
  if (p === '/brand') return { name: 'brand' }
  if (p === '/brand/assets') return { name: 'brand-assets' }
  const d = /^\/p\/([a-z0-9]+)\/design(?:\/([1-9][0-9]*))?$/.exec(p)
  if (d?.[1])
    return d[2]
      ? { name: 'design-editor', id: d[1], artboard: Number(d[2]) }
      : { name: 'design', id: d[1] }
  const r = /^\/p\/([a-z0-9]+)\/review(?:\/([a-z0-9-]+))?$/.exec(p)
  if (r?.[1]) return r[2] ? { name: 'review', id: r[1], rev: r[2] } : { name: 'review', id: r[1] }
  const m = /^\/p\/([a-z0-9]+)(\/revisions|\/brief|\/structure|\/pages\/new)?$/.exec(p)
  if (m?.[1]) {
    if (m[2] === '/revisions') return { name: 'revisions', id: m[1] }
    if (m[2] === '/brief') return { name: 'brief', id: m[1] }
    if (m[2] === '/structure') return { name: 'structure', id: m[1] }
    if (m[2] === '/pages/new') return { name: 'new-page', id: m[1] }
    return { name: 'project', id: m[1] }
  }
  return { name: 'not-found' }
}
