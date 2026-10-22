// Stored review images (decision #50). The worker keeps a baseline, current and diff PNG per
// page and breakpoint next to the result (results/<run>.images/). The app reads them once per
// run: every name is checked against the result's own list and the fixed name form, every file
// against a size cap and the PNG signature, then each goes into the project's blob store and an
// index (<project>/shots/<run>.json) says which blob is which name. The preview site serves them
// from that index through a signed link of its own kind (preview/shots-link.ts). The AI has no
// part in any of it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { SHOT_NAME, signShotsToken } from '../preview/shots-link.ts'
import { writeReplace } from '../store/atomic.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'
import type { RunRow } from './checks.ts'

export const MAX_SHOT_BYTES = 2 * 1024 * 1024
export const MAX_SHOT_PAGES = 60
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const KINDS = ['baseline', 'current', 'diff'] as const

export type ShotPage = {
  page: string
  width: number
  baseline: string
  current: string
  diff?: string
}
export type ShotsIndex = { run: string; pages: ShotPage[]; blobs: Record<string, string> }

export const isPng = (b: Uint8Array) => b.length >= 33 && PNG_SIGNATURE.every((v, i) => b[i] === v)

/** The same mapping the review uses for a finding's file: "about/index.html" is "about". */
export const pagePath = (file: string) =>
  file
    .replace(/^\/+/, '')
    .replace(/(^|\/)index\.html$/, '')
    .replace(/\/+$/, '')

const indexFile = (ctx: StoreContext, project: string, run: string) =>
  join(projectDir(ctx.dataDir, project), 'shots', `${run}.json`)

/** The visual check's `images` list, kept only where every name has the fixed form and kind. */
export function listedImages(result: unknown): ShotPage[] {
  const checks = (result as { checks?: unknown } | null)?.checks
  const visual = Array.isArray(checks)
    ? (checks as { id?: unknown; images?: unknown }[]).find((c) => c.id === 'visual')
    : undefined
  if (!Array.isArray(visual?.images)) return []
  const out: ShotPage[] = []
  for (const e of visual.images.slice(0, MAX_SHOT_PAGES) as Record<string, unknown>[]) {
    if (!e || typeof e.page !== 'string' || e.page.length > 200) continue
    if (!Number.isInteger(e.width) || (e.width as number) < 100 || (e.width as number) > 5000)
      continue
    const names: Partial<Record<(typeof KINDS)[number], string>> = {}
    let ok = true
    for (const k of KINDS) {
      const n = e[k]
      if (n === undefined && k === 'diff') continue
      if (typeof n !== 'string' || !SHOT_NAME.test(n) || !n.endsWith(`-${k}.png`)) ok = false
      else names[k] = n
    }
    if (ok && names.baseline && names.current)
      out.push({
        page: e.page,
        width: e.width as number,
        baseline: names.baseline,
        current: names.current,
        ...(names.diff ? { diff: names.diff } : {}),
      })
  }
  return out
}

/** Reads, validates and stores a run's images once. Returns the index, or null when it has none. */
export async function storeShots(ctx: StoreContext, run: RunRow): Promise<ShotsIndex | null> {
  const file = indexFile(ctx, run.project_id, run.id)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ShotsIndex
  if (run.status !== 'done' || !run.result_json) return null
  const listed = listedImages(JSON.parse(run.result_json))
  if (!listed.length) return null
  const dir = resolve(ctx.dataDir, 'checks', 'results', `${run.id}.images`)
  const blobs: Record<string, string> = {}
  const pages: ShotPage[] = []
  const project = projectDir(ctx.dataDir, run.project_id)
  for (const p of listed) {
    const names = [p.baseline, p.current, ...(p.diff ? [p.diff] : [])]
    const staged: Record<string, string> = {}
    let ok = true
    for (const n of names) {
      const path = resolve(dir, n)
      if (
        !path.startsWith(dir + sep) ||
        !existsSync(path) ||
        statSync(path).size > MAX_SHOT_BYTES
      ) {
        ok = false
        break
      }
      const bytes = new Uint8Array(readFileSync(path))
      if (!isPng(bytes)) {
        ok = false
        break
      }
      staged[n] = await putBlob(project, bytes)
    }
    // A page with a missing or false image is dropped whole: never half a comparison.
    if (!ok) continue
    Object.assign(blobs, staged)
    pages.push(p)
  }
  if (!pages.length) return null
  const index: ShotsIndex = { run: run.id, pages, blobs }
  writeReplace(file, new TextEncoder().encode(JSON.stringify(index)))
  return index
}

export type ShotsView = {
  page: string
  path: string
  width: number
  baseline: string
  current: string
  diff: string | null
}[]

/** The review's list: absolute preview URLs under one signed token for the run. */
export async function shotsFor(
  ctx: StoreContext,
  preview: { secret: string; url: URL } | undefined,
  run: RunRow | null,
): Promise<ShotsView> {
  if (!preview || !run) return []
  const index = await storeShots(ctx, run)
  if (!index) return []
  const token = signShotsToken(preview.secret, { project: run.project_id, run: run.id })
  const url = (n: string) => new URL(`/shots/${token}/${n}`, preview.url).href
  return index.pages.map((p) => ({
    page: p.page,
    path: pagePath(p.page),
    width: p.width,
    baseline: url(p.baseline),
    current: url(p.current),
    diff: p.diff ? url(p.diff) : null,
  }))
}

/** What the preview serves: the blob for a name the index lists, checked on read. */
export async function readShot(
  dataDir: string,
  project: string,
  run: string,
  name: string,
): Promise<Uint8Array | null> {
  if (!SHOT_NAME.test(name)) return null
  const file = join(projectDir(dataDir, project), 'shots', `${run}.json`)
  if (!existsSync(file)) return null
  const index = JSON.parse(readFileSync(file, 'utf8')) as ShotsIndex
  if (index.run !== run || !Object.hasOwn(index.blobs, name)) return null
  const bytes = await getBlob(projectDir(dataDir, project), index.blobs[name] as string).catch(
    () => null,
  )
  return bytes && isPng(bytes) ? bytes : null
}
