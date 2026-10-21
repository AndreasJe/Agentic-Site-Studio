// Brand and rules guide versions (plan §5.3-5.4, decision #45). Install-wide and write-once:
// DATA_DIR/brand/guide-v<n>.json, written with writeNew and never changed. The number comes from
// the files on disk. Everything here is synchronous, so inside one process a save cannot
// interleave with another (the lock); writeNew's hard link refuses a second process the same way.
import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Guide } from '@site-studio/shared/guide-validate'
import { ImmutableError, writeNew } from '../store/atomic.ts'

export const brandDir = (dataDir: string) => join(dataDir, 'brand')

/** QualiWare's starting guide (plan §5.1): colours from the golden file, the PT family. */
export const SEED_GUIDE: Guide = {
  version: 1,
  fonts: ['PT Sans', 'PT Sans Narrow', 'PT Serif', 'PT Mono'],
  dominant: 'PT Sans',
  colors: {
    'dark-green': { hex: '#2b675b', role: 'primary' },
    'dark-blue': { hex: '#2e4163', role: 'secondary' },
    'ice-blue': { hex: '#d2e9e3', role: 'secondary' },
    white: { hex: '#ffffff', role: 'base' },
  },
  derived: [{ hex: '#e3f1ee', recipe: '62% ice-blue + white', use: 'borders' }],
  // Neutral values until the design guide gives the real ones: milliseconds and pixels.
  motion: {
    durations: { ui: 200, fade: 300 },
    easing: { standard: 'ease-out' },
    distances: { rise: 8 },
  },
}

export type VersionRow = {
  n: number
  by: string
  at: string
  summary: string
  from: number | null
}

type Ctx = { db: Database; dataDir: string }

const fileOf = (dataDir: string, n: number) => join(brandDir(dataDir), `guide-v${n}.json`)
const enc = (g: unknown) => new TextEncoder().encode(`${JSON.stringify(g, null, 2)}\n`)

/** The numbers present on disk, ascending. */
function numbersOnDisk(dataDir: string): number[] {
  const dir = brandDir(dataDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((f) => /^guide-v(\d+)\.json$/.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b)
}

export function readGuide(dataDir: string, n: number): Guide | null {
  const f = fileOf(dataDir, n)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Guide) : null
}

const SELECT = `select v.n, coalesce(u.handle, 'system') as by, v.at, v.summary, v.based_on as "from"
  from guide_versions v left join users u on u.id = v.by_user`

export const listVersions = (db: Database) =>
  db.query(`${SELECT} order by v.n desc`).all() as VersionRow[]

export const getVersion = (db: Database, n: number) =>
  db.query(`${SELECT} where v.n = ?`).get(n) as VersionRow | null

export const currentNumber = (db: Database): number =>
  (db.query('select max(n) as n from guide_versions').get() as { n: number | null }).n ?? 0

/** First start: write v1 from the fixture. If the files are already there, only record them. */
export function seedGuide({ db, dataDir }: Ctx) {
  if (currentNumber(db) > 0) return
  let have = numbersOnDisk(dataDir)
  if (have.length === 0) {
    writeNew(fileOf(dataDir, 1), enc({ ...SEED_GUIDE, version: 1 }))
    have = [1]
  }
  for (const n of have) {
    db.query(
      'insert or ignore into guide_versions (n, by_user, at, summary, based_on) values (?, null, ?, ?, ?)',
    ).run(
      n,
      new Date().toISOString(),
      n === 1 ? 'Imported the QualiWare guide' : 'Recovered from the files',
      n > 1 ? n - 1 : null,
    )
  }
}

/** Write the next version. `guide.version` is set to the new number. Returns the row. */
export function writeVersion(
  { db, dataDir }: Ctx,
  guide: Guide,
  userId: number,
  summary: string,
  basedOn: number,
): VersionRow {
  const n = Math.max(0, ...numbersOnDisk(dataDir)) + 1
  try {
    writeNew(fileOf(dataDir, n), enc({ ...guide, version: n }))
  } catch (err) {
    if (err instanceof ImmutableError) throw new Error('guide-version-exists')
    throw err
  }
  db.query(
    'insert into guide_versions (n, by_user, at, summary, based_on) values (?, ?, ?, ?, ?)',
  ).run(n, userId, new Date().toISOString(), summary, basedOn)
  return getVersion(db, n) as VersionRow
}

// ---- the change overview ----

type Colour = { hex: string; role: string }
type Derived = { hex: string; recipe: string; use: string; pinned?: boolean }

export type Overview = {
  empty: boolean
  fonts: { added: string[]; removed: string[]; dominant: { from: string; to: string } | null }
  colours: {
    added: { name: string; hex: string; role: string }[]
    removed: { name: string; hex: string; role: string }[]
    changed: { name: string; from: Colour; to: Colour }[]
  }
  derived: {
    added: Derived[]
    removed: Derived[]
    changed: { recipe: string; use: string; from: Derived; to: Derived }[]
  }
  motion: {
    added: { key: string; value: unknown }[]
    removed: { key: string; value: unknown }[]
    changed: { key: string; from: unknown; to: unknown }[]
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) out[prefix] = value
  return out
}

export function diffGuides(a: Guide, b: Guide): Overview {
  const fonts = {
    added: b.fonts.filter((f) => !a.fonts.includes(f)),
    removed: a.fonts.filter((f) => !b.fonts.includes(f)),
    dominant: a.dominant === b.dominant ? null : { from: a.dominant, to: b.dominant },
  }
  const colours: Overview['colours'] = { added: [], removed: [], changed: [] }
  for (const [name, c] of Object.entries(b.colors)) {
    const old = a.colors[name]
    if (!old) colours.added.push({ name, hex: c.hex, role: c.role })
    else if (old.hex !== c.hex || old.role !== c.role)
      colours.changed.push({ name, from: old, to: c })
  }
  for (const [name, c] of Object.entries(a.colors))
    if (!b.colors[name]) colours.removed.push({ name, hex: c.hex, role: c.role })

  const key = (d: Derived) => `${d.recipe}|${d.use}`
  const was = new Map(a.derived.map((d) => [key(d), d]))
  const now = new Map(b.derived.map((d) => [key(d), d]))
  const derived: Overview['derived'] = { added: [], removed: [], changed: [] }
  for (const [k, d] of now) {
    const old = was.get(k)
    if (!old) derived.added.push(d)
    else if (!same(old, d)) derived.changed.push({ recipe: d.recipe, use: d.use, from: old, to: d })
  }
  for (const [k, d] of was) if (!now.has(k)) derived.removed.push(d)

  const fa = flatten(a.motion)
  const fb = flatten(b.motion)
  const motion: Overview['motion'] = { added: [], removed: [], changed: [] }
  for (const [k, v] of Object.entries(fb)) {
    if (!(k in fa)) motion.added.push({ key: k, value: v })
    else if (!same(fa[k], v)) motion.changed.push({ key: k, from: fa[k], to: v })
  }
  for (const [k, v] of Object.entries(fa)) if (!(k in fb)) motion.removed.push({ key: k, value: v })

  const empty =
    !fonts.added.length &&
    !fonts.removed.length &&
    !fonts.dominant &&
    Object.values(colours).every((l) => l.length === 0) &&
    Object.values(derived).every((l) => l.length === 0) &&
    Object.values(motion).every((l) => l.length === 0)
  return { empty, fonts, colours, derived, motion }
}

/** One line for the version list, in English (it is data, written once). */
export function summarise(o: Overview): string {
  const count = (l: { added: unknown[]; removed: unknown[]; changed?: unknown[] }) =>
    l.added.length + l.removed.length + (l.changed?.length ?? 0)
  const parts: string[] = []
  const fonts = o.fonts.added.length + o.fonts.removed.length + (o.fonts.dominant ? 1 : 0)
  if (fonts) parts.push(`${fonts} font ${fonts === 1 ? 'change' : 'changes'}`)
  for (const [label, l] of [
    ['colour', o.colours],
    ['derived colour', o.derived],
    ['motion', o.motion],
  ] as const) {
    const n = count(l)
    if (n) parts.push(`${n} ${label} ${n === 1 ? 'change' : 'changes'}`)
  }
  return parts.join(', ') || 'No changes'
}
