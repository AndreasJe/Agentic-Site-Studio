// The review package (plan §7; M5.1): the files that would ship for one saved revision, built once
// from its structure.json and design.json. A page's Lead gives index.html and style.css at the
// page's path. Stored write-once as packages/<rev>.json (path -> blob hash); the hash covers the
// sorted entries so the same revision always gives the same hash.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImmutableError, writeNew } from '../store/atomic.ts'
import { getBlob } from '../store/blobs.ts'
import { projectDir, readRevision, type StoreContext } from '../store/revisions.ts'
import { emptyStructure, type Structure, validateStructure } from '../structure/structure.ts'

export type ReviewPackage = { rev: string; hash: string; files: Record<string, string> }

/** The artboard fields of design.json that the review reads. */
export type DesignSection = {
  id: string
  name: string
  job: string
  checklist: Record<string, boolean>
  approved: { at: string; by: string | null } | null
}
export type DesignArtboard = {
  id: number
  page: string
  letter: string
  role: string
  kind?: string
  html: string
  css: string
  sections: DesignSection[]
}

const dec = new TextDecoder()
const packagePath = (ctx: StoreContext, project: string, rev: string) =>
  join(projectDir(ctx.dataDir, project), 'packages', `${rev}.json`)

/** A path inside the package: relative, no `..`, no empty parts, no backslashes or NUL. */
export function isPackagePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    // A backslash or a control character (NUL, newline, …); a digit is fine (review of M5).
    ![...path].some((ch) => ch === '\\' || ch.charCodeAt(0) < 32) &&
    path.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  )
}

/**
 * SHA-256 hex over the sorted manifest of [path, blob hash] pairs, as JSON. Unlike spike 3's
 * `path\0bytes\0` framing this can't be ambiguous (review of M5). Every blob is read, and
 * getBlob checks its bytes against its hash, so the hash still stands for the exact bytes.
 */
export async function packageHash(dir: string, files: Record<string, string>): Promise<string> {
  const entries: [string, string][] = []
  for (const path of Object.keys(files).sort()) {
    await getBlob(dir, files[path] as string)
    entries.push([path, files[path] as string])
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** The revision's structure, or the empty one (one home page), as the design routes do. */
export async function revisionStructure(
  ctx: StoreContext,
  project: string,
  files: Record<string, string>,
): Promise<Structure> {
  const hash = files['structure.json']
  if (!hash) return emptyStructure('example.com')
  const text = dec.decode(await getBlob(projectDir(ctx.dataDir, project), hash))
  return validateStructure(JSON.parse(text))
}

/** The artboards of the revision's design.json; none when the revision has no design. */
export async function revisionDesign(
  ctx: StoreContext,
  project: string,
  files: Record<string, string>,
): Promise<DesignArtboard[]> {
  const hash = files['design.json']
  if (!hash) return []
  const doc = JSON.parse(dec.decode(await getBlob(projectDir(ctx.dataDir, project), hash))) as {
    artboards: DesignArtboard[]
  }
  return doc.artboards
}

/**
 * The folder of a page inside the package: '' for the first address's home, the slug path
 * otherwise. Pages on a further address sit under a folder named after that address.
 */
export function pageDir(s: Structure, id: string): string {
  const page = s.pages.find((p) => p.id === id)
  if (!page) throw new Error(`No such page: ${id}`)
  const parts: string[] = []
  for (
    let p: typeof page | undefined = page;
    p;
    p = p.parent ? s.pages.find((x) => x.id === p?.parent) : undefined
  )
    if (p.slug) parts.unshift(p.slug)
  if (page.root !== s.roots[0]?.address) parts.unshift(page.root)
  return parts.join('/')
}

export const leadOf = (boards: DesignArtboard[], page: string): DesignArtboard | undefined =>
  boards.find((a) => a.page === page && a.role === 'lead')

export function getPackage(ctx: StoreContext, project: string, rev: string): ReviewPackage | null {
  const file = packagePath(ctx, project, rev)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ReviewPackage) : null
}

/** Builds the package from the saved revision once; later calls return the stored one. */
export async function buildPackage(
  ctx: StoreContext,
  project: string,
  rev: string,
): Promise<ReviewPackage> {
  const stored = getPackage(ctx, project, rev)
  if (stored) return stored
  const doc = readRevision(ctx.dataDir, project, rev)
  if (!doc) throw new Error(`no revision ${rev}`)
  const structure = await revisionStructure(ctx, project, doc.files)
  const boards = await revisionDesign(ctx, project, doc.files)
  const files: Record<string, string> = {}
  for (const page of structure.pages) {
    const lead = leadOf(boards, page.id)
    if (!lead) continue // approval reports pages without a Lead
    const dir = pageDir(structure, page.id)
    const html = dir ? `${dir}/index.html` : 'index.html'
    const css = dir ? `${dir}/style.css` : 'style.css'
    for (const p of [html, css]) {
      if (!isPackagePath(p) || p in files) throw new Error(`the address ${p} is not usable`)
    }
    files[html] = lead.html
    files[css] = lead.css
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
  const pkg: ReviewPackage = {
    rev,
    hash: await packageHash(projectDir(ctx.dataDir, project), sorted),
    files: sorted,
  }
  try {
    writeNew(
      packagePath(ctx, project, rev),
      new TextEncoder().encode(`${JSON.stringify(pkg, null, 2)}\n`),
    )
  } catch (err) {
    if (!(err instanceof ImmutableError)) throw err
    return getPackage(ctx, project, rev) as ReviewPackage // built meanwhile by another request
  }
  return pkg
}
