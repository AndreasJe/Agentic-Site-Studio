// Build once (plan §9, §9.1; M6.1): the saved revision becomes one package of site files, packed
// into one deterministic archive. Package hash = SHA-256 of the archive bytes (docs/m6-interfaces.md).
// Preview, staging and production serve these bytes; nothing is rebuilt or changed later.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@site-studio/shared/bytes'
import { validateDesign } from '@site-studio/shared/design-validate'
import type { Guide } from '@site-studio/shared/guide-validate'
import { hex, writeArchive } from '@site-studio/shared/release'
import { transform } from 'esbuild'
import { minify } from 'html-minifier-terser'
import { brandDir, currentNumber, readGuide, SEED_GUIDE } from '../brand/guide.ts'
import {
  isPackagePath,
  leadOf,
  pageDir,
  type ReviewPackage,
  revisionDesign,
  revisionStructure,
} from '../review/package.ts'
import { ImmutableError, writeNew } from '../store/atomic.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, readRevision, type StoreContext } from '../store/revisions.ts'
import { compose, menuHtml, relinkCss } from './compose.ts'

export type BuildIssue = { page: string; rule: string; message: string }

/** `build-floor-error`: a composed page broke a floor rule, so nothing is built. */
export class BuildError extends Error {
  constructor(
    readonly code: 'build-floor-error' | 'build-bad-address',
    readonly issues: BuildIssue[],
  ) {
    super(`${code}: ${issues.map((i) => `${i.page}: ${i.rule}`).join('; ')}`)
    this.name = 'BuildError'
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const packagePath = (ctx: StoreContext, project: string, rev: string) =>
  join(projectDir(ctx.dataDir, project), 'packages', `${rev}.json`)

const HTML_OPTIONS = {
  // Conservative: whitespace and comments only. No attribute is removed or unquoted, so
  // data-section stays, and inline styles and scripts are left exactly as written.
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true,
  removeAttributeQuotes: false,
  removeRedundantAttributes: false,
  removeEmptyAttributes: false,
  removeOptionalTags: false,
  minifyCSS: false,
  minifyJS: false,
  sortAttributes: false,
  sortClassName: false,
}

async function partialsOf(ctx: StoreContext): Promise<{ header?: string; footer?: string }> {
  const out: { header?: string; footer?: string } = {}
  for (const name of ['header', 'footer'] as const) {
    const row = ctx.db
      .query('select hash from brand_partials where name = ? order by n desc limit 1')
      .get(name) as { hash: string } | null
    if (row) out[name] = dec.decode(await getBlob(brandDir(ctx.dataDir), row.hash))
  }
  return out
}

function guideOf(ctx: StoreContext): Guide {
  const n = currentNumber(ctx.db)
  return (n > 0 ? readGuide(ctx.dataDir, n) : null) ?? SEED_GUIDE
}

const sha8 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 8)
const siteUrl = (address: string, dir: string) => `https://${address}/${dir ? `${dir}/` : ''}`
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function readPackage(ctx: StoreContext, project: string, rev: string): ReviewPackage | null {
  const file = packagePath(ctx, project, rev)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ReviewPackage) : null
}

/** The package hash recomputed from the stored archive bytes (getBlob checks them as it reads). */
export async function archiveHash(dir: string, pkg: ReviewPackage): Promise<string> {
  const bytes = await getBlob(dir, pkg.archive)
  return hex(await sha256(new Uint8Array(bytes)))
}

/** Builds the package from the saved revision once; later calls return the stored one. */
export async function buildSite(
  ctx: StoreContext,
  project: string,
  rev: string,
): Promise<ReviewPackage> {
  const stored = readPackage(ctx, project, rev)
  if (stored) return stored
  const doc = readRevision(ctx.dataDir, project, rev)
  if (!doc) throw new Error(`no revision ${rev}`)
  const dir = projectDir(ctx.dataDir, project)
  const structure = await revisionStructure(ctx, project, doc.files)
  const boards = await revisionDesign(ctx, project, doc.files)
  const partials = await partialsOf(ctx)
  const guide = guideOf(ctx)

  // Pages that have a Lead (approval reports the rest), in structure order, with their folder.
  const built = structure.pages.flatMap((page) => {
    const lead = leadOf(boards, page.id)
    return lead ? [{ page, lead, folder: pageDir(structure, page.id) }] : []
  })
  const folderOf = new Map(built.map((b) => [b.page.id, b.folder]))

  const out = new Map<string, Uint8Array>()
  const issues: BuildIssue[] = []
  for (const { page, lead, folder } of built) {
    const at = (name: string) => (folder ? `${folder}/${name}` : name)
    const htmlPath = at('index.html')
    if (!isPackagePath(htmlPath) || out.has(htmlPath))
      throw new BuildError('build-bad-address', [
        { page: page.id, rule: 'address', message: `the address ${htmlPath} is not usable` },
      ])
    const menu = menuHtml(structure.menus[page.root]?.main ?? [], folder, (id) =>
      folderOf.has(id) ? (folderOf.get(id) as string) : null,
    )
    // design.json holds blob hashes for each artboard's html and css.
    const leadHtml = dec.decode(await getBlob(dir, lead.html))
    const leadCss = dec.decode(await getBlob(dir, lead.css))
    const composed = compose(leadHtml, partials, menu)
    const result = validateDesign({ html: composed, css: leadCss }, guide)
    for (const e of result.errors.filter((x) => x.floor))
      issues.push({ page: page.id, rule: e.rule, message: e.message })

    const css = (await transform(leadCss, { loader: 'css', minify: true })).code
    const cssBytes = enc.encode(css)
    const cssName = `style.${sha8(cssBytes)}.css`
    const html = await minify(relinkCss(composed, 'style.css', cssName), HTML_OPTIONS)
    out.set(htmlPath, enc.encode(html))
    out.set(at(cssName), cssBytes)
  }
  if (issues.length) throw new BuildError('build-floor-error', issues)

  // sitemap.xml and robots.txt, with the project's address (example.com until M7).
  const address = structure.roots[0]?.address ?? 'example.com'
  const urls = built.map((b) => siteUrl(address, b.folder)).sort()
  out.set(
    'sitemap.xml',
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
        .map((u) => `<url><loc>${xml(u)}</loc></url>\n`)
        .join('')}</urlset>\n`,
    ),
  )
  out.set(
    'robots.txt',
    enc.encode(`User-agent: *\nAllow: /\nSitemap: https://${address}/sitemap.xml\n`),
  )

  const entries = [...out.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({ path, bytes }))
  const archive = await putBlob(dir, writeArchive(entries))
  const files: Record<string, string> = {}
  for (const e of entries) files[e.path] = await putBlob(dir, e.bytes)
  const pkg: ReviewPackage = { rev, hash: archive.slice('sha256:'.length), archive, files }
  try {
    writeNew(packagePath(ctx, project, rev), enc.encode(`${JSON.stringify(pkg, null, 2)}\n`))
  } catch (err) {
    if (!(err instanceof ImmutableError)) throw err
    return readPackage(ctx, project, rev) as ReviewPackage // built meanwhile by another request
  }
  return pkg
}
