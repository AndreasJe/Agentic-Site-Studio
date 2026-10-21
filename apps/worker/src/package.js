import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

export function listFiles(root, dir = root) {
  const out = []
  for (const name of readdirSync(dir)) {
    const f = join(dir, name)
    if (statSync(f).isDirectory()) out.push(...listFiles(root, f))
    else out.push(f)
  }
  return out
}

export function pages(root) {
  return listFiles(root)
    .filter((f) => extname(f) === '.html')
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort()
}

const SKIP = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

// Internal references in href/src/poster/srcset values, resolved inside the package.
export function brokenLinks(root) {
  const broken = []
  const base = resolve(root)
  for (const page of pages(root)) {
    const html = readFileSync(join(root, page), 'utf8')
    const refs = []
    for (const m of html.matchAll(/\s(?:href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
      refs.push(m[1] ?? m[2])
    for (const m of html.matchAll(/\ssrcset\s*=\s*"([^"]*)"/gi))
      for (const part of m[1].split(',')) refs.push(part.trim().split(/\s+/)[0])
    for (const raw of refs) {
      if (!raw || SKIP.test(raw)) continue
      const clean = raw.split('#')[0].split('?')[0]
      if (!clean) continue
      const target = resolve(
        clean.startsWith('/') ? base : dirname(join(base, page)),
        clean.replace(/^\//, ''),
      )
      const inside = target === base || target.startsWith(base + sep)
      const ok =
        inside &&
        existsSync(target) &&
        (statSync(target).isFile() || existsSync(join(target, 'index.html')))
      if (!ok) broken.push({ page, ref: raw })
    }
  }
  return broken
}

// Static scan for inline script and inline event handlers (floor).
export function inlineCode(root) {
  const found = []
  for (const page of pages(root)) {
    const html = readFileSync(join(root, page), 'utf8')
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      const attrs = m[1]
      const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1]?.toLowerCase()
      const data = type && !/javascript|module|ecmascript/.test(type)
      if (!/\bsrc\s*=/i.test(attrs) && !data) found.push({ page, kind: 'inline-script' })
    }
    for (const m of html.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi))
      found.push({ page, kind: 'inline-handler', attr: m[1] })
    for (const _ of html.matchAll(/(?:href|src)\s*=\s*["']\s*javascript:/gi))
      found.push({ page, kind: 'javascript-url' })
  }
  return found
}

export function hasReducedMotionSupport(root) {
  return listFiles(root)
    .filter((f) => /\.(css|js|html)$/.test(f))
    .some((f) => readFileSync(f, 'utf8').includes('prefers-reduced-motion'))
}
