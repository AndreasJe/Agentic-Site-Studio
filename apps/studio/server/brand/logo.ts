// The logo studio's rules (plan §5.5): a logo is a clean vector, so its parts can be recoloured.
// Only drawing elements are accepted; anything that could run, fetch or restyle from outside is
// refused. The upload is shown on the app's origin, so this is also a security check.
import type { Guide } from '@site-studio/shared/guide-validate'
import { checkSvg, MediaError, sniff } from '../media/media.ts'

const ALLOWED = new Set([
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
const DRAWN = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline'])
const MAX_BYTES = 512 * 1024

export type Part = { index: number; tag: string; fill: string; via: 'attr' | 'style' }

type Found = Part & { start: number; end: number }

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

const unsafe = (why: string) => new MediaError('unsafe-svg', 422, why)

function normaliseFill(v: string): string {
  const s = v.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s)
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : s
}

/** Walk the tags; refuse what is not clean vector; list the parts that carry a fill. */
function scan(text: string): Found[] {
  const found: Found[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (text.slice(last, at).includes('<')) throw unsafe('malformed markup')
    last = at + m[0].length
    if (m[0].startsWith('<![CDATA[')) throw unsafe('CDATA')
    const tag = m[2]?.toLowerCase()
    if (!tag) continue // comment or xml declaration
    if (!ALLOWED.has(tag)) throw unsafe(`element ${tag}`)
    if (m[1]) continue // closing tag
    const attrs: Record<string, string> = {}
    for (const a of (m[3] ?? '').matchAll(ATTR)) {
      const name = (a[1] ?? '').toLowerCase()
      const value = a[2] ?? a[3] ?? ''
      if (name.startsWith('on')) throw unsafe('event handler')
      if (/javascript:|data:|expression\s*\(/i.test(value)) throw unsafe('script or data url')
      attrs[name] = value
    }
    if (!DRAWN.has(tag)) continue
    let fill = attrs.fill
    let via: Part['via'] = 'attr'
    if (fill === undefined) {
      const s = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(attrs.style ?? '')
      if (s) {
        fill = s[1]
        via = 'style'
      }
    }
    if (fill === undefined) continue
    const f = normaliseFill(fill)
    if (f === 'none' || f.startsWith('url(') || f === 'inherit' || f === 'currentcolor') continue
    found.push({ index: found.length, tag, fill: f, via, start: at, end: last })
  }
  if (text.slice(last).includes('<')) throw unsafe('malformed markup')
  return found
}

/** Decide whether bytes are an acceptable logo; return the SVG text and its recolourable parts. */
export function checkLogo(bytes: Uint8Array): { text: string; parts: Part[] } {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new MediaError('too-large', 413)
  if (sniff(bytes) !== 'image/svg+xml') throw new MediaError('bad-type', 415)
  checkSvg(bytes)
  const text = new TextDecoder().decode(bytes)
  const parts = scan(text).map(({ index, tag, fill, via }) => ({ index, tag, fill, via }))
  return { text, parts }
}

export type Recipe = Record<string, string>

/** The hex for a guide colour name or a derived colour's recipe text, or null if not in the guide. */
export function colourHex(guide: Guide, name: string): string | null {
  if (Object.hasOwn(guide.colors, name)) return (guide.colors[name] as { hex: string }).hex
  return guide.derived.find((d) => d.recipe === name)?.hex ?? null
}

/** The SVG with the recipe's colours applied, part by part. The original is never changed. */
export function applyRecipe(text: string, recipe: Recipe, guide: Guide): string {
  const found = scan(text)
  let out = text
  for (const part of [...found].reverse()) {
    const name = recipe[String(part.index)]
    const hex = name ? colourHex(guide, name) : null
    if (!hex) continue
    const tag = out.slice(part.start, part.end)
    const next =
      part.via === 'attr'
        ? tag.replace(/(\sfill\s*=\s*)(?:"[^"]*"|'[^']*')/i, `$1"${hex}"`)
        : tag.replace(/(fill\s*:\s*)[^;"']+/i, `$1${hex}`)
    out = out.slice(0, part.start) + next + out.slice(part.end)
  }
  return out
}
