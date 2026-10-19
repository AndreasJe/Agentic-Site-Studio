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
  | { name: 'project'; id: string }
  | { name: 'revisions'; id: string }
  | { name: 'not-found' }

export function match(path: string): Match {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/sign-in') return { name: 'sign-in' }
  if (p === '/' || p === '/projects') return { name: 'projects' }
  const m = /^\/p\/([a-z0-9]+)(\/revisions)?$/.exec(p)
  if (m?.[1]) return m[2] ? { name: 'revisions', id: m[1] } : { name: 'project', id: m[1] }
  return { name: 'not-found' }
}
