// Derived colours (CLAUDE.md rule 11, decision #14): mixed in OKLab, clipped to sRGB, rounded to
// 8-bit lowercase hex. One module for the Brand editor (browser) and the validators (Bun):
// no Node imports. `mix(a, b, p)` equals CSS `color-mix(in oklab, a p%, b)`.

export type Rgb = [number, number, number] // 0..1, gamma-encoded sRGB
type Lab = [number, number, number]

const HEX6 = /^#([0-9a-f]{6})$/i

export function parseHex(hex: string): Rgb {
  const m = HEX6.exec(hex.trim())
  if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`)
  const n = Number.parseInt(m[1] as string, 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function rgbToOklab([r, g, b]: Rgb): Lab {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** Out-of-gamut results are possible; callers clip. */
export function oklabToRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

const clip = (c: number) => Math.min(1, Math.max(0, c))

export function rgbToHex([r, g, b]: Rgb): string {
  const h = (c: number) =>
    Math.round(clip(c) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** `amount` (0..1) of `a`, the rest `b`. Returns lowercase #rrggbb. */
export function mix(a: string, b: string, amount: number): string {
  if (!(amount >= 0 && amount <= 1))
    throw new Error(`Mix amount must be between 0 and 1: ${amount}`)
  const la = rgbToOklab(parseHex(a))
  const lb = rgbToOklab(parseHex(b))
  const out = la.map((v, i) => v * amount + (lb[i] as number) * (1 - amount)) as Lab
  return rgbToHex(oklabToRgb(out))
}

export type NamedColours = Record<string, string | { hex: string }>

const BUILT_IN: Record<string, string> = { white: '#ffffff', black: '#000000' }

export type Recipe = { amount: number; a: string; b: string }

/** "62% ice-blue + white" -> { amount: 0.62, a: 'ice-blue', b: 'white' }; null if malformed. */
export function parseRecipe(recipe: string): Recipe | null {
  const m = /^\s*(\d+(?:\.\d+)?)%\s*([a-z0-9][a-z0-9-]*)\s*\+\s*([a-z0-9][a-z0-9-]*)\s*$/i.exec(
    recipe,
  )
  if (!m) return null
  const amount = Number(m[1]) / 100
  if (amount < 0 || amount > 1) return null
  return { amount, a: m[2] as string, b: m[3] as string }
}

function lookup(name: string, colours: NamedColours): string | null {
  const key = name.toLowerCase()
  const own = Object.keys(colours).find((k) => k.toLowerCase() === key)
  if (own) {
    const v = colours[own]
    return typeof v === 'string' ? v : (v?.hex ?? null)
  }
  return BUILT_IN[key] ?? null
}

/** The hex a recipe gives, or null if it is malformed or names an unknown colour. */
export function deriveHex(recipe: string, colours: NamedColours): string | null {
  const r = parseRecipe(recipe)
  if (!r) return null
  const a = lookup(r.a, colours)
  const b = lookup(r.b, colours)
  if (!a || !b) return null
  return mix(a, b, r.amount)
}

const relLum = (hex: string) => {
  const [r, g, b] = parseHex(hex).map(toLinear) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relLum(a)
  const lb = relLum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
