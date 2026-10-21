// Design validator (plan §5.3, M4). Checks generated HTML + CSS against the security floor
// (floor: true, always refuses) and against the guide. parse5 for HTML, css-tree for CSS.
import { type CssNode, generate, parse as parseCss, walk } from 'css-tree'
import { parse as parseHtml } from 'parse5'
import { NAMED_COLOURS } from './css-colours.ts'
import type { Guide } from './guide-validate.ts'

export type Issue = { rule: string; message: string; sectionId?: string; floor: boolean }
export type DesignResult = { errors: Issue[]; warnings: Issue[] }

const SECTION_ID = /^s-[a-z0-9]{6}$/
const NETWORK_APIS = ['RTCPeerConnection', 'WebSocket', 'EventSource']
const URL_ATTRS = ['href', 'src', 'srcset', 'action', 'poster']
const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])
const COLOUR_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset'])
const COLOUR_PROP =
  /^(color|background(-color|-image)?|border(-[a-z]+)*|outline(-color)?|fill|stroke|box-shadow|text-shadow|text-decoration(-color)?|caret-color|accent-color|column-rule(-color)?|--.+)$/

type Attr = { name: string; value: string }
type Node = {
  nodeName: string
  tagName?: string
  attrs?: Attr[]
  value?: string
  childNodes?: Node[]
  content?: { childNodes: Node[] }
}
type Colour = { hex: string; alpha: number }

/** null if the URL is fine, otherwise why it is refused. */
function urlProblem(raw: string, externalHttpsOk: boolean): string | null {
  const v = raw.trim()
  if (v === '') return null
  const low = [...v.toLowerCase()].filter((c) => c.charCodeAt(0) > 32).join('')
  if (low.startsWith('javascript:')) return 'javascript:'
  if (low.startsWith('//')) return 'protocol-relative'
  if (low.startsWith('https://')) return externalHttpsOk ? null : 'absolute'
  if (low.startsWith('http://')) return 'absolute'
  if (low.startsWith('/')) return 'root-relative'
  return null
}

function parseHexColour(h: string): Colour | null {
  if (!/^[0-9a-f]+$/i.test(h)) return null
  let s = h.toLowerCase()
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('')
  if (s.length !== 6 && s.length !== 8) return null
  return {
    hex: `#${s.slice(0, 6)}`,
    alpha: s.length === 8 ? Number.parseInt(s.slice(6), 16) / 255 : 1,
  }
}

const byte = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0')

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return `#${byte(f(0) * 255)}${byte(f(8) * 255)}${byte(f(4) * 255)}`
}

function parseFunctionColour(name: string, args: string): Colour | null {
  const parts = args
    .trim()
    .split(/[\s,/]+/)
    .filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const num = (p: string, pctScale: number) => {
    const m = /^([+-]?\d*\.?\d+)(%|deg)?$/.exec(p)
    if (!m) return Number.NaN
    return m[2] === '%' ? (Number(m[1]) / 100) * pctScale : Number(m[1])
  }
  const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1
  if (Number.isNaN(alpha)) return null
  const [p0, p1, p2] = parts as [string, string, string]
  if (name === 'rgb') {
    const c = [num(p0, 255), num(p1, 255), num(p2, 255)]
    if (c.some(Number.isNaN)) return null
    return { hex: `#${c.map(byte).join('')}`, alpha }
  }
  const h = num(p0, 360)
  const s = num(p1, 1)
  const l = num(p2, 1)
  if ([h, s, l].some(Number.isNaN)) return null
  return { hex: hslToHex(((h % 360) + 360) % 360, s, l), alpha }
}

export function validateDesign(
  input: { html: string; css?: string },
  guide: Pick<Guide, 'fonts' | 'colors' | 'derived'>,
): DesignResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (rule: string, message: string, floor: boolean, sectionId?: string) =>
    errors.push({ rule, message, floor, ...(sectionId ? { sectionId } : {}) })

  type Source = { css: string; kind: 'sheet' | 'attr'; sectionId?: string }
  const sources: Source[] = []
  if (input.css) sources.push({ css: input.css, kind: 'sheet' })

  // ---- HTML ----
  for (const api of NETWORK_APIS) {
    if (input.html.includes(api))
      err('network-api', `${api} is not allowed (peer and push connections).`, true)
  }
  const doc = parseHtml(input.html, { scriptingEnabled: false }) as unknown as Node
  const seen = new Map<string, number>()

  const visit = (node: Node, inherited?: string) => {
    let sectionId = inherited
    const tag = node.tagName
    if (tag) {
      const attrs = node.attrs ?? []
      const attr = (n: string) => attrs.find((a) => a.name === n)?.value
      const sec = attr('data-section')
      if (sec !== undefined) {
        if (!SECTION_ID.test(sec)) {
          err(
            'section-id-format',
            `data-section "${sec}" must match s-xxxxxx (6 lowercase letters or digits).`,
            true,
            inherited,
          )
        }
        const n = (seen.get(sec) ?? 0) + 1
        seen.set(sec, n)
        if (n === 2)
          err('duplicate-section', `data-section "${sec}" is used more than once.`, true, sec)
        sectionId = sec
      }
      if (tag === 'script' && attr('src') === undefined) {
        err(
          'inline-script',
          'Inline <script> is not allowed; use an external script.',
          true,
          sectionId,
        )
      }
      for (const a of attrs) {
        const name = a.name.toLowerCase()
        if (name.startsWith('on'))
          err('event-handler', `Inline event handler "${a.name}" is not allowed.`, true, sectionId)
        if (name.startsWith('data-ss-'))
          err(
            'annotation',
            `Annotation "${a.name}" is not allowed; only data-section.`,
            true,
            sectionId,
          )
        if (URL_ATTRS.includes(name)) {
          const values =
            name === 'srcset'
              ? a.value.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '')
              : [a.value]
          for (const v of values) {
            const p = urlProblem(v, tag === 'a' && name === 'href')
            if (p === 'javascript:')
              err('inline-script', `javascript: URL in ${name} is not allowed.`, true, sectionId)
            else if (p)
              err('absolute-url', `${name}="${v}" is ${p}; use a relative path.`, true, sectionId)
          }
        }
        if (name === 'style') sources.push({ css: a.value, kind: 'attr', sectionId })
      }
      if (tag === 'form') {
        if (attr('action') !== undefined || attr('method')?.toLowerCase() === 'post') {
          err(
            'form-destination',
            'A form with an action or method="post" is not allowed.',
            true,
            sectionId,
          )
        } else {
          warnings.push({
            rule: 'form-open-question',
            message: 'This form has no destination yet (open question).',
            floor: false,
            ...(sectionId ? { sectionId } : {}),
          })
        }
      }
      if (tag === 'style') {
        const text = (node.childNodes ?? []).map((c) => c.value ?? '').join('')
        sources.push({ css: text, kind: 'sheet', sectionId })
      }
    }
    for (const c of node.childNodes ?? []) visit(c, sectionId)
    for (const c of node.content?.childNodes ?? []) visit(c, sectionId)
  }
  visit(doc)

  // ---- CSS ----
  // Only guide and registered derived colours (§5.3); white and black only if the guide lists them.
  const allowed = new Set<string>(Object.values(guide.colors).map((c) => c.hex.toLowerCase()))
  for (const d of guide.derived) allowed.add(d.hex.toLowerCase())
  const fonts = new Set(guide.fonts.map((f) => f.toLowerCase()))

  const parsed: { ast: CssNode; sectionId?: string }[] = []
  const customProps = new Set<string>()
  for (const s of sources) {
    try {
      const ast = parseCss(s.css, { context: s.kind === 'attr' ? 'declarationList' : 'stylesheet' })
      parsed.push({ ast, sectionId: s.sectionId })
      walk(ast, (n: CssNode) => {
        if (n.type === 'Declaration' && n.property.startsWith('--')) customProps.add(n.property)
      })
    } catch {
      err('css-parse', 'The CSS could not be parsed.', false, s.sectionId)
    }
  }

  let motion = false
  let reducedMotion = false

  const checkColour = (c: Colour | null, text: string, sectionId?: string) => {
    if (!c)
      return err('colour', `Colour "${text}" cannot be read; use a guide colour.`, false, sectionId)
    if (c.alpha === 0) return
    if (c.alpha !== 1)
      return err('colour', `Colour "${text}" is not opaque; guide colours only.`, false, sectionId)
    if (!allowed.has(c.hex))
      err('colour', `Colour ${text} (${c.hex}) is not in the guide.`, false, sectionId)
  }
  const checkUrl = (v: string, sectionId?: string) => {
    const p = urlProblem(v, false)
    if (p === 'javascript:')
      err('inline-script', 'javascript: URL in CSS is not allowed.', true, sectionId)
    else if (p)
      err('absolute-url', `CSS url("${v}") is ${p}; use a relative path.`, true, sectionId)
  }

  for (const { ast, sectionId } of parsed) {
    walk(ast, (node: CssNode) => {
      if (node.type === 'Atrule') {
        if (node.name.toLowerCase().endsWith('keyframes')) motion = true
        if (
          node.name === 'media' &&
          node.prelude &&
          /prefers-reduced-motion\s*:\s*reduce/i.test(generate(node.prelude))
        ) {
          reducedMotion = true
        }
        if (node.name === 'import' && node.prelude) {
          const m = /^(?:url\(\s*)?["']?([^"')]*)/.exec(generate(node.prelude))
          if (m) checkUrl(m[1] as string, sectionId)
        }
        return
      }
      if (node.type !== 'Declaration') return
      const prop = node.property.toLowerCase()
      const valueText = generate(node.value).trim()
      if (/^(-\w+-)?(animation|transition)(-|$)/.test(prop) && valueText !== 'none') motion = true
      if (prop === 'font-family') {
        const first =
          valueText
            .split(',')[0]
            ?.trim()
            .replace(/^["']|["']$/g, '') ?? ''
        const low = first.toLowerCase()
        if (first && !first.startsWith('var(') && !COLOUR_KEYWORDS.has(low) && !fonts.has(low)) {
          err(
            'font',
            GENERIC.has(low)
              ? `font-family starts with the generic "${first}"; start with a guide font.`
              : `Font "${first}" is not in the guide.`,
            false,
            sectionId,
          )
        }
      }
      walk(node.value, (v: CssNode) => {
        if (v.type === 'Url') {
          checkUrl(String(v.value), sectionId)
        } else if (v.type === 'Hash') {
          checkColour(parseHexColour(v.value), `#${v.value}`, sectionId)
        } else if (v.type === 'Function') {
          const name = v.name.toLowerCase()
          const text = generate(v)
          if (['rgb', 'rgba', 'hsl', 'hsla'].includes(name)) {
            if (text.includes('var('))
              err('colour', `Colour "${text}" cannot be verified.`, false, sectionId)
            else
              checkColour(
                parseFunctionColour(name.replace(/a$/, ''), text.slice(text.indexOf('(') + 1, -1)),
                text,
                sectionId,
              )
            return walk.skip
          }
          if (['hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix'].includes(name)) {
            err(
              'colour',
              `Colour function ${name}() is not allowed; use a guide colour.`,
              false,
              sectionId,
            )
            return walk.skip
          }
          if (name === 'var') {
            const ref = /var\(\s*(--[^,)\s]+)\s*(,)?/.exec(text)
            if (ref && !ref[2] && COLOUR_PROP.test(prop) && !customProps.has(ref[1] as string)) {
              err('colour', `var(${ref[1]}) is not declared in this CSS.`, false, sectionId)
            }
            return walk.skip
          }
        } else if (v.type === 'Identifier' && COLOUR_PROP.test(prop)) {
          const k = v.name.toLowerCase()
          if (COLOUR_KEYWORDS.has(k)) return
          const named = NAMED_COLOURS[k]
          if (named) checkColour({ hex: named, alpha: 1 }, v.name, sectionId)
        }
      })
    })
  }
  if (motion && !reducedMotion) {
    err(
      'reduced-motion',
      'Animation or transition without an @media (prefers-reduced-motion: reduce) block.',
      false,
    )
  }
  return { errors, warnings }
}
