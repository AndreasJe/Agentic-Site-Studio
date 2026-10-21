// The review package (plan §7, §9; M5.1, M6.1): the built site files of one saved revision. The build
// (../build/) makes it once; this file keeps the helpers it and the review routes share, and the
// names the callers use. Stored write-once as packages/<rev>.json (docs/m6-interfaces.md).

import { archiveHash, buildSite, readPackage } from '../build/index.ts'
import { getBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'
import { emptyStructure, type Structure, validateStructure } from '../structure/structure.ts'

/** hash: SHA-256 of the archive; archive: its blob hash (sha256:<hash>); files: path -> blob. */
export type ReviewPackage = {
  rev: string
  hash: string
  archive: string
  files: Record<string, string>
}

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
 * The package hash, recomputed from the stored archive bytes: getBlob checks the blob against its
 * hash while reading, so the result stands for the exact bytes (M6.1).
 */
export const packageHash = (dir: string, pkg: ReviewPackage): Promise<string> =>
  archiveHash(dir, pkg)

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

export const getPackage = readPackage

/** Builds the package from the saved revision once; later calls return the stored one. */
export const buildPackage = (
  ctx: StoreContext,
  project: string,
  rev: string,
): Promise<ReviewPackage> => buildSite(ctx, project, rev)
