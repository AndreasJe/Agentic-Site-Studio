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
// Every attribute that takes a URL (review of M4: formaction, data, ping, background, …).
const URL_ATTRS = [
  'href',
  'src',
  'srcset',
  'imagesrcset',
  'action',
  'formaction',
  'poster',
  'data',
  'ping',
  'background',
  'cite',
  'longdesc',
  'manifest',
]
// Elements that hide content from this parser or embed another document (review of M4).
const FORBIDDEN_TAGS = new Set([
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'portal',
  'fencedframe',
])
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'http-equiv'])
const DANGEROUS_SCHEME = /^(javascript|vbscript):|^data:text\/html/
// Colours set as HTML or SVG attributes rather than CSS.
const COLOUR_ATTRS = new Set([
  'fill',
  'stroke',
  'color',
  'bgcolor',
  'stop-color',
  'flood-color',
  'lighting-color',
])
const FONT_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'caption',
  'icon',
  'menu',
  'message-box',
  'small-caption',
  'status-bar',
])
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
  /^(color|background(-color|-image)?|border(-[a-z]+)*|outline(-color)?|fill|stroke|stop-color|flood-color|lighting-color|box-shadow|text-shadow|text-decoration(-color)?|text-emphasis(-color)?|caret-color|accent-color|scrollbar-color|column-rule(-color)?|-webkit-text-fill-color|-webkit-text-stroke(-color)?|--.+)$/

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

/** As a browser reads a URL: no whitespace or control characters, backslash as slash. */
const normalUrl = (raw: string) =>
  [...raw.trim().toLowerCase()]
    .filter((c) => c.charCodeAt(0) > 32)
    .join('')
    .replaceAll('\\', '/')

type UrlUse = 'link' | 'image' | 'other'

/**
 * null if the URL is fine, otherwise why it is refused. An allowlist (decisions #39, #40):
 * relative paths and fragments; https, mailto and tel on links; data: for images only.
 */
function urlProblem(raw: string, use: UrlUse): string | null {
  const low = normalUrl(raw)
  if (low === '') return null
  if (DANGEROUS_SCHEME.test(low)) return 'javascript:'
  if (low.startsWith('//')) return 'protocol-relative'
  if (low.startsWith('/')) return 'root-relative'
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(low)?.[1]
  if (!scheme) return null
  if (use === 'link' && (scheme === 'https' || scheme === 'mailto' || scheme === 'tel')) return null
  if (use === 'image' && low.startsWith('data:image/')) return null
  return scheme === 'http' || scheme === 'https' ? 'absolute' : `a ${scheme}: URL`
}

/** CSS identifiers may be escaped (u\\72l); compare names as the browser decodes them. */
const cssName = (n: string) =>
  n
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/\\(.)/g, '$1')
    .toLowerCase()

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
  // Parsed as a browser with scripting on parses it, so both see the same tree (review of M4).
  const doc = parseHtml(input.html) as unknown as Node
  const seen = new Map<string, number>()
  const colourAttrs: { value: string; sectionId?: string }[] = []

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
      if (FORBIDDEN_TAGS.has(tag)) {
        err('forbidden-element', `<${tag}> is not allowed in a design.`, true, sectionId)
      }
      if (tag === 'script' && /^data:/.test(normalUrl(attr('src') ?? ''))) {
        err('inline-script', 'A data: script is an inline script.', true, sectionId)
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
        if (FORBIDDEN_ATTRS.has(name)) {
          err('forbidden-element', `The ${name} attribute is not allowed.`, true, sectionId)
        }
        // Any attribute can carry a script URL (SVG <set to=…>, <animate values=…>).
        if (DANGEROUS_SCHEME.test(normalUrl(a.value))) {
          err('inline-script', `A script URL in ${a.name} is not allowed.`, true, sectionId)
        } else if (URL_ATTRS.includes(name)) {
          const values = name.endsWith('srcset')
            ? a.value.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '')
            : [a.value]
          const use: UrlUse =
            name === 'href' && (tag === 'a' || tag === 'area')
              ? 'link'
              : ['img', 'source', 'video', 'image'].includes(tag) &&
                  ['src', 'srcset', 'poster', 'href'].includes(name)
                ? 'image'
                : 'other'
          for (const v of values) {
            const p = urlProblem(v, use)
            if (p === 'javascript:')
              err('inline-script', `javascript: URL in ${name} is not allowed.`, true, sectionId)
            else if (p)
              err('absolute-url', `${name}="${v}" is ${p}; use a relative path.`, true, sectionId)
          }
        }
        if (name === 'style') sources.push({ css: a.value, kind: 'attr', sectionId })
        if (COLOUR_ATTRS.has(name)) colourAttrs.push({ value: a.value, sectionId })
        if (name === 'formaction' || (name === 'formmethod' && a.value.toLowerCase() === 'post')) {
          err('form-destination', `${a.name} is not allowed; forms never post.`, true, sectionId)
        }
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
  const customProps = new Map<string, string>()
  for (const s of sources) {
    try {
      const ast = parseCss(s.css, { context: s.kind === 'attr' ? 'declarationList' : 'stylesheet' })
      parsed.push({ ast, sectionId: s.sectionId })
      walk(ast, (n: CssNode) => {
        if (n.type === 'Declaration' && n.property.startsWith('--'))
          customProps.set(n.property, generate(n.value).trim())
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
    const p = urlProblem(v, 'image')
    if (p === 'javascript:')
      err('inline-script', 'javascript: URL in CSS is not allowed.', true, sectionId)
    else if (p)
      err('absolute-url', `CSS url("${v}") is ${p}; use a relative path.`, true, sectionId)
  }

  for (const { ast, sectionId } of parsed) {
    walk(ast, (node: CssNode) => {
      if (node.type === 'Atrule') {
        const at = cssName(node.name)
        if (at.endsWith('keyframes')) motion = true
        if (
          at === 'media' &&
          node.prelude &&
          /prefers-reduced-motion\s*:\s*reduce/i.test(generate(node.prelude))
        ) {
          reducedMotion = true
        }
        // One stylesheet per artboard: nothing is imported (review of M4).
        if (at === 'import') err('absolute-url', '@import is not allowed.', true, sectionId)
        return
      }
      if (node.type !== 'Declaration') return
      const prop = node.property.toLowerCase()
      const valueText = generate(node.value).trim()
      if (/^(-\w+-)?(animation|transition)(-|$)/.test(prop) && valueText !== 'none') motion = true
      if (prop === 'font' && !FONT_KEYWORDS.has(valueText.toLowerCase())) {
        // The shorthand ends with the family list; its first family must be a guide font.
        const fams = valueText.match(/(["'][^"']+["']|[a-z][a-z -]*)\s*(,.*)?$/i)?.[1] ?? ''
        const first = fams
          .replace(/^["']|["']$/g, '')
          .trim()
          .toLowerCase()
        if (!fonts.has(first))
          err(
            'font',
            `font shorthand "${valueText}" must name a guide font first.`,
            false,
            sectionId,
          )
      }
      if (prop === 'font-family') {
        const ref = /^var\(\s*(--[^,)\s]+)\s*\)$/.exec(valueText)?.[1]
        if (ref && !customProps.has(ref))
          err('font', `font-family ${valueText} is not declared in this CSS.`, false, sectionId)
        const first =
          (ref ? (customProps.get(ref) ?? '') : valueText)
            .split(',')[0]
            ?.trim()
            .replace(/^["']|["']$/g, '') ?? ''
        const low = first.toLowerCase()
        if (first && !COLOUR_KEYWORDS.has(low) && !fonts.has(low)) {
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
        if (v.type === 'Raw') {
          // Text the parser couldn't read. An escape here can hide a url( (review of M4).
          if (v.value.includes('\\'))
            err('absolute-url', 'CSS escapes outside strings are not allowed.', true, sectionId)
          for (const m of v.value.matchAll(/url\(\s*["']?([^"')]*)/gi))
            checkUrl(m[1] ?? '', sectionId)
        } else if (v.type === 'Url') {
          checkUrl(String(v.value), sectionId)
        } else if (v.type === 'Hash') {
          checkColour(parseHexColour(v.value), `#${v.value}`, sectionId)
        } else if (v.type === 'Function') {
          const name = cssName(v.name)
          if (
            name === 'url' ||
            name === 'src' ||
            name.endsWith('image-set') ||
            name === 'cross-fade'
          ) {
            // Escaped url( and image-set("…") carry URLs as strings (review of M4).
            walk(v, (inner: CssNode) => {
              if (inner.type === 'String') checkUrl(inner.value, sectionId)
            })
          }
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
  for (const a of colourAttrs) {
    const v = a.value.trim().toLowerCase()
    if (v === '' || v === 'none' || COLOUR_KEYWORDS.has(v) || v.startsWith('url(')) continue
    const named = NAMED_COLOURS[v]
    const c = v.startsWith('#')
      ? parseHexColour(v.slice(1))
      : named
        ? { hex: named, alpha: 1 }
        : /^(rgb|hsl)a?\(.*\)$/.test(v)
          ? parseFunctionColour(
              v.startsWith('rgb') ? 'rgb' : 'hsl',
              v.slice(v.indexOf('(') + 1, -1),
            )
          : null
    checkColour(c, a.value, a.sectionId)
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
