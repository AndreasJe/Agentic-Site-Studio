// Checks that read the unpacked package and need no browser. Each one returns
// { findings: [{ message, file?, target?, rule? }] }; the runner turns that into a status.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { listFiles, pages } from './package.js'

const rel = (root, f) => relative(root, f).split(sep).join('/')
const read = (root, path) => readFileSync(join(root, path), 'utf8')

// ---- validators: the app's design validator, rerun on every page ----

const VALIDATOR = new URL('../../../packages/shared/src/design-validate.ts', import.meta.url)
let validatorModule

// Node strips the types when it imports the .ts file; its own dependencies (css-tree, parse5)
// resolve from packages/shared. Nothing is copied.
async function loadValidator() {
  validatorModule ??= import(VALIDATOR.href)
  return (await validatorModule).validateDesign
}

const hrefs = (html, tag, attr) => {
  const out = []
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const v = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(m[0])
    if (v) out.push(v[1] ?? v[2])
  }
  return out
}

function stylesheetsOf(root, page, html) {
  const css = []
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\srel\s*=\s*["']?stylesheet/i.test(m[0])) continue
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0])
    const ref = href?.[1] ?? href?.[2]
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue
    const clean = ref.split('#')[0].split('?')[0]
    const target = resolve(
      clean.startsWith('/') ? root : dirname(join(root, page)),
      clean.replace(/^\//, ''),
    )
    if (target.startsWith(resolve(root) + sep) && existsSync(target) && statSync(target).isFile())
      css.push(readFileSync(target, 'utf8'))
  }
  return css.join('\n')
}

export async function validatorsCheck({ root, job }) {
  const guide = job.guide
  if (!guide || typeof guide !== 'object')
    return {
      findings: [{ message: 'The job carries no guide, so the guide rules cannot be checked.' }],
    }
  let validateDesign
  try {
    validateDesign = await loadValidator()
  } catch (e) {
    return {
      findings: [{ message: `The shared design validator could not be loaded: ${e.message}` }],
    }
  }
  const findings = []
  for (const page of pages(root)) {
    const html = read(root, page)
    const css = stylesheetsOf(root, page, html)
    const r = validateDesign({ html, css }, guide)
    for (const i of r.errors) findings.push({ message: i.message, file: page, rule: i.rule })
  }
  return { findings }
}

// ---- svg: the logo studio's allowlist (apps/studio/server/brand/logo.ts), not imported ----

const SVG_ALLOWED = new Set([
  'path',
  'g',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'line',
  'svg',
  'title',
  'defs',
  'lineargradient',
  'stop',
])
const SVG_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const SVG_ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** The first reason the SVG is not clean vector, or null. */
export function svgProblem(text) {
  if (/<\s*([\w.-]+:)?script/i.test(text)) return 'script'
  if (/<\s*([\w.-]+:)?foreignObject/i.test(text)) return 'foreignObject'
  if (/<\s*([\w.-]+:)?(set|animate\w*|handler|iframe|embed|object)\b/i.test(text))
    return 'animation or embedded content'
  if (/(javascript|vbscript)\s*:/i.test(text)) return 'script URL'
  if (/<!\s*(ENTITY|DOCTYPE)/i.test(text)) return 'entity'
  if (/(^|[\s"'/])on[a-z]+\s*=/i.test(text)) return 'event handler'
  for (const m of text.matchAll(/\b(?:[\w.-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
    if (!(m[1] ?? m[2] ?? m[3] ?? '').trim().startsWith('#')) return 'external reference'
  for (const m of text.matchAll(/url\(\s*(['"]?)([^)]*)\1\s*\)/gi))
    if (!(m[2] ?? '').trim().startsWith('#')) return 'external reference'
  if (/@import/i.test(text)) return 'external reference'
  let last = 0
  for (const m of text.matchAll(SVG_TOKEN)) {
    const at = m.index ?? 0
    if (text.slice(last, at).includes('<')) return 'malformed markup'
    last = at + m[0].length
    if (m[0].startsWith('<![CDATA[')) return 'CDATA'
    const tag = m[2]?.toLowerCase()
    if (!tag) continue
    if (!SVG_ALLOWED.has(tag)) return `element ${tag}`
    if (m[1]) continue
    for (const a of (m[3] ?? '').matchAll(SVG_ATTR)) {
      if ((a[1] ?? '').toLowerCase().startsWith('on')) return 'event handler'
      if (/javascript:|data:|expression\s*\(/i.test(a[2] ?? a[3] ?? '')) return 'script or data url'
    }
  }
  if (text.slice(last).includes('<')) return 'malformed markup'
  return null
}

export async function svgCheck({ root }) {
  const findings = []
  for (const f of listFiles(root)) {
    if (extname(f).toLowerCase() !== '.svg') continue
    const why = svgProblem(readFileSync(f, 'utf8'))
    if (why)
      findings.push({ message: `Not clean vector: ${why}.`, file: rel(root, f), rule: 'svg' })
  }
  return { findings }
}

// ---- pinned: every .js is on the pinned list with a matching checksum ----

export async function pinnedCheck({ root, job }) {
  const pinned = new Map((job.pinned ?? []).map((p) => [p.path, String(p.sha256).toLowerCase()]))
  const findings = []
  for (const f of listFiles(root)) {
    if (!/\.(?:js|mjs|cjs)$/i.test(f)) continue
    const path = rel(root, f)
    const want = pinned.get(path)
    if (!want) {
      findings.push({
        message: 'This script is not on the pinned list.',
        file: path,
        rule: 'unpinned',
      })
      continue
    }
    const got = createHash('sha256').update(readFileSync(f)).digest('hex')
    if (got !== want)
      findings.push({
        message: 'This script does not match its pinned checksum.',
        file: path,
        rule: 'checksum',
      })
  }
  return { findings }
}

// ---- secrets: a regex scan (gitleaks comes later, on the VM) ----

const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/],
  ['gcp-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['gcp-service-account', /"type"\s*:\s*"service_account"/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['slack-token', /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
  ['api-key-assignment', /\bapi[_-]?key["']?\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{16,}/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
]
const SCAN_MAX = 8 * 1024 * 1024

export async function secretsCheck({ root }) {
  const findings = []
  for (const f of listFiles(root)) {
    if (statSync(f).size > SCAN_MAX) continue
    const text = readFileSync(f).toString('latin1')
    for (const [rule, re] of SECRET_RULES)
      if (re.test(text))
        findings.push({
          message: `Looks like a secret (${rule}). Remove it from the site.`,
          file: rel(root, f),
          rule,
        })
  }
  return { findings }
}

// ---- navigation: every page is reachable by links from index.html ----

export async function navigationCheck({ root }) {
  const all = pages(root)
  if (!all.includes('index.html'))
    return { findings: [{ message: 'There is no index.html to start from.', rule: 'no-index' }] }
  const base = resolve(root)
  const graph = new Map()
  for (const page of all) {
    const out = new Set()
    for (const raw of hrefs(read(root, page), 'a', 'href')) {
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue
      const clean = raw.split('#')[0].split('?')[0]
      if (!clean) continue
      let target = resolve(
        clean.startsWith('/') ? base : dirname(join(base, page)),
        clean.replace(/^\//, ''),
      )
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
      if (target.startsWith(base + sep)) out.add(rel(base, target))
    }
    graph.set(page, out)
  }
  const reached = new Set(['index.html'])
  const queue = ['index.html']
  while (queue.length) {
    for (const next of graph.get(queue.shift()) ?? [])
      if (graph.has(next) && !reached.has(next)) {
        reached.add(next)
        queue.push(next)
      }
  }
  return {
    findings: all
      .filter((p) => !reached.has(p))
      .map((p) => ({
        message: 'No link from index.html leads to this page.',
        file: p,
        rule: 'unreachable',
      })),
  }
}

// ---- seo: title, description, lang, one h1 ----

export async function seoCheck({ root }) {
  const findings = []
  for (const page of pages(root)) {
    const html = read(root, page).replace(/<!--[\s\S]*?-->/g, '')
    const add = (rule, message) => findings.push({ message, file: page, rule })
    if (!/<title\b[^>]*>\s*\S[\s\S]*?<\/title>/i.test(html)) add('title', 'The page has no title.')
    const desc = /<meta\b[^>]*\sname\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0]
    if (!desc || !/\scontent\s*=\s*["'][^"']*\S/i.test(desc))
      add('description', 'The page has no meta description.')
    if (!/<html\b[^>]*\slang\s*=\s*["']?[A-Za-z]/i.test(html))
      add('lang', 'The html element has no lang attribute.')
    const h1s = (html.match(/<h1\b/gi) ?? []).length
    if (h1s !== 1) add('h1', `The page has ${h1s} h1 headings; it needs exactly one.`)
  }
  return { findings }
}
