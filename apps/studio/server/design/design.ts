// Design data model (plan §6.2-6.6; decision #45). Artboards, sections with their checklist,
// deviations and the takes log live in SQLite; HTML and CSS are immutable blobs. Pure helpers plus
// the DB. The AI never writes here: its HTML comes in through applyHtml, which validates it.
import type { Database } from 'bun:sqlite'
import { type DesignResult, type Issue, validateDesign } from '@site-studio/shared/design-validate'
import { parse, serializeOuter } from 'parse5'
import { currentNumber, readGuide } from '../brand/guide.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'

export type Role = 'lead' | 'alternative' | 'reference' | 'state'
export type Level = 'follow' | 'explore' | 'think-new'
export type Outcome = 'fixed' | 'experiment' | 'proposed'
export const CHECK_ITEMS = [
  'copy',
  'media',
  'interactions',
  'mobile',
  'motion',
  'translated',
  'tested',
] as const
export type CheckItem = (typeof CHECK_ITEMS)[number]

export class DesignError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly code: string,
    message = code,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'DesignError'
  }
}

export type ArtboardRow = {
  id: number
  project_id: string
  page_id: string
  letter: string
  role: Role
  kind: 'state' | 'mobile' | null
  description: string
  parent_id: number | null
  html_hash: string
  css_hash: string
  created_by: string
  created_at: string
}

type SectionRow = {
  artboard_id: number
  section_id: string
  name: string
  job: 'inform' | 'prove' | 'convert'
  position: number
  copy: number
  media: number
  interactions: number
  mobile: number
  motion: number
  translated: number
  tested: number
  approved_at: string | null
  approved_by: string | null
}

// ---- section ids ----

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** `s-` plus 6 lowercase alphanumerics, from crypto (rejection sampling, no modulo bias). */
export function newSectionId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    let id = 's-'
    while (id.length < 8) {
      for (const b of crypto.getRandomValues(new Uint8Array(8))) {
        if (b < 252 && id.length < 8) id += ALPHABET[b % 36]
      }
    }
    if (!taken.has(id)) return id
  }
}

/** The next artboard letter: a … z, then aa, ab … (like spreadsheet columns). */
export function nextLetter(letter: string): string {
  const chars = [...letter]
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'z') {
      chars[i] = String.fromCharCode((chars[i] as string).charCodeAt(0) + 1)
      return chars.join('')
    }
    chars[i] = 'a'
  }
  return `a${chars.join('')}`
}

// ---- reading sections out of HTML ----

type Attr = { name: string; value: string }
type Node = {
  nodeName: string
  tagName?: string
  attrs?: Attr[]
  value?: string
  childNodes?: Node[]
  content?: { childNodes: Node[] }
  sourceCodeLocation?: { startOffset: number; startTag?: { endOffset: number } } | null
}

export type FoundSection = {
  /** The data-section value, or null when the element has none. */
  id: string | null
  name: string
  outer: string
  tag: string
  /** Where the element's start tag begins in the source. */
  start: number
}

const attrOf = (n: Node, name: string) => n.attrs?.find((a) => a.name === name)?.value

function textOf(n: Node): string {
  if (n.nodeName === '#text') return n.value ?? ''
  return (n.childNodes ?? []).map(textOf).join('')
}

function walkNodes(n: Node, fn: (n: Node) => void) {
  fn(n)
  for (const c of n.childNodes ?? []) walkNodes(c, fn)
  for (const c of n.content?.childNodes ?? []) walkNodes(c, fn)
}

const parseDoc = (html: string) =>
  parse(html, { scriptingEnabled: false, sourceCodeLocationInfo: true }) as unknown as Node

/** Sections in document order: every `data-section` element and every `<section>` without one. */
export function sectionsFromHtml(html: string): FoundSection[] {
  const out: FoundSection[] = []
  let count = 0
  walkNodes(parseDoc(html), (n) => {
    if (!n.tagName) return
    const id = attrOf(n, 'data-section') ?? null
    if (id === null && n.tagName !== 'section') return
    count++
    const heading = (() => {
      let found = ''
      walkNodes(n, (h) => {
        if (!found && /^h[1-6]$/.test(h.tagName ?? ''))
          found = textOf(h).trim().replace(/\s+/g, ' ')
      })
      return found
    })()
    out.push({
      id,
      name: (heading || attrOf(n, 'aria-label') || `Section ${count}`).slice(0, 80),
      outer: serializeOuter(n as never),
      tag: n.tagName,
      start: n.sourceCodeLocation?.startOffset ?? 0,
    })
  })
  return out
}

/** Gives every `<section>` without an id one from code, by editing only the start tags. */
export function assignSectionIds(html: string): string {
  const found = sectionsFromHtml(html)
  const taken = new Set(found.flatMap((s) => (s.id ? [s.id] : [])))
  let out = html
  for (const s of found.filter((f) => f.id === null).reverse()) {
    const at = s.start + 1 + s.tag.length
    const id = newSectionId(taken)
    taken.add(id)
    out = `${out.slice(0, at)} data-section="${id}"${out.slice(at)}`
  }
  return out
}

/** Interaction questions in a section: forms without a destination, links to `#` or nowhere. */
export function openQuestions(html: string, sectionId: string, result?: DesignResult): number {
  const forms = (result?.warnings ?? []).filter(
    (w) => w.rule === 'form-open-question' && w.sectionId === sectionId,
  ).length
  let links = 0
  const sec = findNode(parseDoc(html), sectionId)
  if (sec)
    walkNodes(sec, (n) => {
      if (n.tagName !== 'a') return
      const href = attrOf(n, 'href')
      if (href === undefined || href.trim() === '' || href.trim() === '#') links++
    })
  return forms + links
}

function findNode(root: Node, sectionId: string): Node | null {
  let hit: Node | null = null
  walkNodes(root, (n) => {
    if (!hit && n.tagName && attrOf(n, 'data-section') === sectionId) hit = n
  })
  return hit
}

// ---- storing ----

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

/** The stored HTML and CSS text of an artboard. This is what the preview serves. */
export async function readArtboardFiles(
  ctx: StoreContext,
  project: string,
  artboard: Pick<ArtboardRow, 'html_hash' | 'css_hash'>,
): Promise<{ html: string; css: string }> {
  const dir = projectDir(ctx.dataDir, project)
  return {
    html: dec(await getBlob(dir, artboard.html_hash)),
    css: dec(await getBlob(dir, artboard.css_hash)),
  }
}

export function getArtboard(db: Database, project: string, id: number): ArtboardRow | null {
  return db
    .query('select * from artboards where id = ? and project_id = ?')
    .get(id, project) as ArtboardRow | null
}

const needArtboard = (db: Database, project: string, id: number) =>
  getArtboard(db, project, id) ?? bad(404, 'not-found')

function bad(status: DesignError['status'], code: string, extra?: Record<string, unknown>): never {
  throw new DesignError(status, code, code, extra)
}

const LEVELS: Level[] = ['follow', 'explore', 'think-new']
const needLevel = (level: unknown): Level =>
  LEVELS.includes(level as Level) ? (level as Level) : bad(400, 'bad-level')

type Prepared = {
  html: string
  css: string
  sections: FoundSection[]
  result: DesignResult
  /** Guide breaks kept as deviations (think-new only). */
  deviations: Issue[]
}

/** Validate against the current guide; refuse what the level refuses (decision #45). */
function prepare(
  ctx: StoreContext,
  rawHtml: string,
  css: string,
  level: Level,
  old?: { sections: Map<string, string>; approved: Set<string> },
): Prepared {
  const guide = readGuide(ctx.dataDir, currentNumber(ctx.db))
  if (!guide) bad(500, 'no-guide')
  const html = assignSectionIds(rawHtml)
  const result = validateDesign({ html, css }, guide as NonNullable<typeof guide>)
  const floor = result.errors.filter((e) => e.floor || e.rule === 'css-parse')
  // Security-floor errors refuse at every level, and so does CSS that cannot be read.
  if (floor.length) bad(422, 'invalid-design', { issues: floor })
  const guideErrors = result.errors.filter((e) => !floor.includes(e))
  if (guideErrors.length && level !== 'think-new')
    bad(422, 'invalid-design', { issues: guideErrors })
  const sections = sectionsFromHtml(html)
  if (old) {
    const now = new Map(sections.map((s) => [s.id as string, s.outer]))
    const locked = [...old.approved].filter((id) => now.get(id) !== old.sections.get(id))
    if (locked.length) bad(409, 'section-locked', { sections: locked })
  }
  return { html, css, sections, result, deviations: guideErrors }
}

function syncDeviations(db: Database, artboard: number, found: Issue[], at: string) {
  const key = (s: string | null | undefined, rule: string, message: string) =>
    `${s ?? ''}|${rule}|${message}`
  const wanted = new Map(found.map((i) => [key(i.sectionId, i.rule, i.message), i]))
  const have = db
    .query('select id, section_id, rule, message, status from deviations where artboard_id = ?')
    .all(artboard) as {
    id: number
    section_id: string | null
    rule: string
    message: string
    status: string
  }[]
  for (const d of have) {
    const k = key(d.section_id, d.rule, d.message)
    if (d.status === 'open' && !wanted.has(k)) {
      // Only a successful re-apply that no longer breaks the rule settles a deviation as fixed.
      db.query("update deviations set status = 'fixed' where id = ?").run(d.id)
    }
    if (d.status !== 'fixed') wanted.delete(k)
  }
  for (const i of wanted.values()) {
    db.query(
      'insert into deviations (artboard_id, section_id, rule, message, status, created_at) values (?, ?, ?, ?, ?, ?)',
    ).run(artboard, i.sectionId ?? null, i.rule, i.message, 'open', at)
  }
}

function syncSections(
  db: Database,
  artboard: number,
  sections: FoundSection[],
  before: Map<string, string>,
) {
  const keep = new Set<string>()
  sections.forEach((s, position) => {
    const id = s.id as string
    keep.add(id)
    const exists = db
      .query('select 1 from sections where artboard_id = ? and section_id = ?')
      .get(artboard, id)
    if (!exists) {
      db.query(
        'insert into sections (artboard_id, section_id, name, position) values (?, ?, ?, ?)',
      ).run(artboard, id, s.name, position)
      return
    }
    // TODO: decide which other checklist items a change turns off (Motion, Mobile, Translated,
    // Tested); for now copy and media are turned off when the section's content changes.
    const changed = before.get(id) !== s.outer
    db.query(
      `update sections set position = ?, name = ?${changed ? ', copy = 0, media = 0' : ''}
       where artboard_id = ? and section_id = ?`,
    ).run(position, s.name, artboard, id)
  })
  for (const r of db
    .query('select section_id from sections where artboard_id = ?')
    .all(artboard) as { section_id: string }[]) {
    if (!keep.has(r.section_id))
      db.query('delete from sections where artboard_id = ? and section_id = ?').run(
        artboard,
        r.section_id,
      )
  }
}

// ---- artboards ----

export type NewArtboard = {
  project: string
  pageId: string
  html: string
  css: string
  description?: string
  role?: Role
  kind?: 'state' | 'mobile'
  parentId?: number
  level?: Level
  by: string
}

export async function createArtboard(ctx: StoreContext, input: NewArtboard): Promise<ArtboardRow> {
  const { db } = ctx
  const level = needLevel(input.level ?? 'follow')
  const asked = input.role
  if (asked && !['lead', 'alternative', 'reference', 'state'].includes(asked)) bad(400, 'bad-role')
  if (asked === 'state') {
    if (input.kind !== 'state' && input.kind !== 'mobile') bad(400, 'kind-required')
    const parent = input.parentId ? getArtboard(db, input.project, input.parentId) : null
    if (!parent || parent.page_id !== input.pageId || parent.role === 'state')
      bad(400, 'bad-parent')
  }
  const p = prepare(ctx, input.html, input.css, level)
  const dir = projectDir(ctx.dataDir, input.project)
  const htmlHash = await putBlob(dir, enc(p.html))
  const cssHash = await putBlob(dir, enc(p.css))
  const at = new Date().toISOString()
  return db.transaction(() => {
    const proj = db.query('select next_artboard from projects where id = ?').get(input.project) as {
      next_artboard: string
    } | null
    if (!proj) bad(404, 'not-found')
    const hasLead = !!db
      .query("select 1 from artboards where project_id = ? and page_id = ? and role = 'lead'")
      .get(input.project, input.pageId)
    let role: Role
    if (asked === 'state') role = 'state'
    else if (asked === 'lead' && hasLead) return bad(409, 'lead-exists')
    // The first artboard on a page is the Lead; Think new always makes an Alternative unless
    // there is nothing else and nothing to settle (decision #45).
    else if (!hasLead && !(level === 'think-new' && p.deviations.length > 0)) role = 'lead'
    else role = asked === 'reference' ? 'reference' : 'alternative'
    if (role === 'lead' && p.deviations.length) return bad(409, 'unsettled-deviations')
    const letter = (proj as { next_artboard: string }).next_artboard
    db.query('update projects set next_artboard = ? where id = ?').run(
      nextLetter(letter),
      input.project,
    )
    const row = db
      .query(
        `insert into artboards (project_id, page_id, letter, role, kind, description, parent_id,
           html_hash, css_hash, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning *`,
      )
      .get(
        input.project,
        input.pageId,
        letter.toUpperCase(),
        role,
        role === 'state' ? (input.kind as string) : null,
        input.description ?? '',
        role === 'state' ? (input.parentId as number) : null,
        htmlHash,
        cssHash,
        input.by,
        at,
      ) as ArtboardRow
    syncSections(db, row.id, p.sections, new Map())
    syncDeviations(db, row.id, p.deviations, at)
    return row
  })()
}

export async function applyHtml(
  ctx: StoreContext,
  project: string,
  artboardId: number,
  html: string,
  css: string,
  opts: { level: unknown },
): Promise<{ artboard: ArtboardRow; issues: Issue[]; warnings: Issue[] }> {
  const { db } = ctx
  const level = needLevel(opts.level)
  const board = needArtboard(db, project, artboardId)
  const old = await readArtboardFiles(ctx, project, board)
  const before = new Map(sectionsFromHtml(old.html).map((s) => [s.id as string, s.outer]))
  const approved = new Set(
    (
      db
        .query('select section_id from sections where artboard_id = ? and approved_at is not null')
        .all(board.id) as { section_id: string }[]
    ).map((r) => r.section_id),
  )
  const p = prepare(ctx, html, css, level, { sections: before, approved })
  // A Lead cannot take on guide breaks: it would break "no unsettled deviations on a Lead".
  if (board.role === 'lead' && p.deviations.length) bad(409, 'unsettled-deviations')
  const dir = projectDir(ctx.dataDir, project)
  const htmlHash = await putBlob(dir, enc(p.html))
  const cssHash = await putBlob(dir, enc(p.css))
  const at = new Date().toISOString()
  db.transaction(() => {
    db.query('update artboards set html_hash = ?, css_hash = ? where id = ?').run(
      htmlHash,
      cssHash,
      board.id,
    )
    syncSections(db, board.id, p.sections, before)
    syncDeviations(db, board.id, p.deviations, at)
  })()
  return {
    artboard: needArtboard(db, project, artboardId),
    issues: p.deviations,
    warnings: p.result.warnings,
  }
}

/** The change-of-Lead question is answered in the same action: what the old Lead becomes. */
export function setRole(
  ctx: StoreContext,
  project: string,
  artboardId: number,
  role: unknown,
  oldLeadBecomes?: unknown,
): ArtboardRow {
  const { db } = ctx
  return db.transaction(() => {
    const board = needArtboard(db, project, artboardId)
    if (board.role === 'state') return bad(409, 'state-role')
    if (role !== 'lead' && role !== 'alternative' && role !== 'reference')
      return bad(400, 'bad-role')
    if (board.role === role) return board
    if (role !== 'lead') {
      db.query('update artboards set role = ? where id = ?').run(role, board.id)
      return needArtboard(db, project, artboardId)
    }
    const open = db
      .query(
        "select count(*) as n from deviations where artboard_id = ? and status in ('open', 'experiment')",
      )
      .get(board.id) as { n: number }
    if (open.n > 0) return bad(409, 'unsettled-deviations', { count: open.n })
    const lead = db
      .query(
        "select id, letter from artboards where project_id = ? and page_id = ? and role = 'lead'",
      )
      .get(project, board.page_id) as { id: number; letter: string } | null
    if (lead) {
      if (oldLeadBecomes !== 'alternative' && oldLeadBecomes !== 'reference')
        return bad(400, 'old-lead-role-required', { lead: lead.letter })
      db.query('update artboards set role = ? where id = ?').run(oldLeadBecomes, lead.id)
    }
    db.query("update artboards set role = 'lead' where id = ?").run(board.id)
    return needArtboard(db, project, artboardId)
  })()
}

// ---- checklist ----

export const languagesOn = (db: Database): boolean =>
  (db.query("select value from settings where key = 'languages'").get() as { value: string } | null)
    ?.value === 'on'

export type Checklist = Record<CheckItem, boolean>

export function checklistOf(db: Database, s: SectionRow): Checklist {
  const off = !languagesOn(db)
  return {
    copy: !!s.copy,
    media: !!s.media,
    interactions: !!s.interactions,
    mobile: !!s.mobile,
    motion: !!s.motion,
    // "Not needed" while languages are off counts as on.
    translated: !!s.translated || off,
    tested: !!s.tested,
  }
}

const needSection = (db: Database, artboard: number, section: string) =>
  (db
    .query('select * from sections where artboard_id = ? and section_id = ?')
    .get(artboard, section) as SectionRow | null) ?? bad(404, 'not-found')

export async function setCheck(
  ctx: StoreContext,
  project: string,
  artboardId: number,
  sectionId: string,
  item: string,
  on: unknown,
): Promise<SectionRow> {
  const { db } = ctx
  const board = needArtboard(db, project, artboardId)
  const section = needSection(db, board.id, sectionId)
  if (!CHECK_ITEMS.includes(item as CheckItem)) bad(404, 'not-found')
  if (typeof on !== 'boolean') bad(400, 'on-required')
  if (section.approved_at) bad(409, 'section-locked')
  if (on && item === 'interactions') {
    const { html, css } = await readArtboardFiles(ctx, project, board)
    const guide = readGuide(ctx.dataDir, currentNumber(db))
    const result = validateDesign({ html, css }, guide as NonNullable<typeof guide>)
    const n = openQuestions(html, sectionId, result)
    if (n > 0) bad(409, 'open-questions', { count: n })
  }
  if (on && item === 'mobile') {
    const mobile = db
      .query(
        "select 1 from artboards where project_id = ? and page_id = ? and role = 'state' and kind = 'mobile'",
      )
      .get(project, board.page_id)
    if (!mobile) bad(409, 'no-mobile-variant')
  }
  db.query(`update sections set ${item} = ? where artboard_id = ? and section_id = ?`).run(
    on ? 1 : 0,
    board.id,
    sectionId,
  )
  return needSection(db, board.id, sectionId)
}

export function approveSection(
  ctx: StoreContext,
  project: string,
  artboardId: number,
  sectionId: string,
  by: string,
): SectionRow {
  const { db } = ctx
  const board = needArtboard(db, project, artboardId)
  const section = needSection(db, board.id, sectionId)
  if (section.approved_at) return section
  const missing = CHECK_ITEMS.filter((i) => !checklistOf(db, section)[i])
  if (missing.length) bad(409, 'checklist-incomplete', { missing })
  db.query(
    'update sections set approved_at = ?, approved_by = ? where artboard_id = ? and section_id = ?',
  ).run(new Date().toISOString(), by, board.id, sectionId)
  return needSection(db, board.id, sectionId)
}

/** Unlocking is deliberate. The checklist items the next change touches turn off in applyHtml. */
export function unlockSection(
  ctx: StoreContext,
  project: string,
  artboardId: number,
  sectionId: string,
): SectionRow {
  const { db } = ctx
  const board = needArtboard(db, project, artboardId)
  const section = needSection(db, board.id, sectionId)
  if (!section.approved_at) bad(409, 'not-approved')
  db.query(
    'update sections set approved_at = null, approved_by = null where artboard_id = ? and section_id = ?',
  ).run(board.id, sectionId)
  return needSection(db, board.id, sectionId)
}

// ---- deviations ----

/** 'fixed' is set only by a successful re-apply (applyHtml), never by hand. */
export function deviationOutcome(
  ctx: StoreContext,
  project: string,
  id: number,
  outcome: unknown,
): { id: number; status: string } {
  const { db } = ctx
  if (outcome === 'fixed') bad(409, 'fixed-by-reapply')
  if (outcome !== 'experiment' && outcome !== 'proposed') bad(400, 'bad-outcome')
  const d = db
    .query(
      `select d.id, d.status from deviations d join artboards a on a.id = d.artboard_id
       where d.id = ? and a.project_id = ?`,
    )
    .get(id, project) as { id: number; status: string } | null
  if (!d) bad(404, 'not-found')
  if ((d as { status: string }).status !== 'open') bad(409, 'not-open')
  db.query('update deviations set status = ? where id = ?').run(outcome, id)
  return { id, status: outcome }
}

// ---- views ----

export function sectionView(db: Database, s: SectionRow) {
  const checklist = checklistOf(db, s)
  const done = CHECK_ITEMS.filter((i) => checklist[i]).length
  return {
    id: s.section_id,
    name: s.name,
    job: s.job,
    position: s.position,
    checklist,
    translatedNotNeeded: !languagesOn(db),
    progress: s.approved_at ? 'approved' : `${done}/7`,
    done,
    approved: s.approved_at ? { at: s.approved_at, by: s.approved_by } : null,
  }
}

export function sectionsOf(db: Database, artboard: number) {
  return (
    db
      .query('select * from sections where artboard_id = ? order by position')
      .all(artboard) as SectionRow[]
  ).map((s) => sectionView(db, s))
}

export function deviationsOf(db: Database, artboard: number) {
  return db
    .query(
      'select id, section_id as sectionId, rule, message, status, created_at as createdAt from deviations where artboard_id = ? order by id',
    )
    .all(artboard)
}

const artboardView = (r: ArtboardRow) => ({
  id: r.id,
  pageId: r.page_id,
  letter: r.letter,
  role: r.role,
  kind: r.kind,
  parentId: r.parent_id,
  description: r.description,
  htmlHash: r.html_hash,
  cssHash: r.css_hash,
  createdBy: r.created_by,
  createdAt: r.created_at,
})

export const artboardsOfPage = (db: Database, project: string, page: string) =>
  db
    .query('select * from artboards where project_id = ? and page_id = ? order by id')
    .all(project, page) as ArtboardRow[]

export function artboardSummary(db: Database, r: ArtboardRow) {
  const sections = sectionsOf(db, r.id)
  const open = db
    .query(
      "select count(*) as n from deviations where artboard_id = ? and status in ('open', 'experiment')",
    )
    .get(r.id) as { n: number }
  return {
    ...artboardView(r),
    sections: sections.map((s) => ({ id: s.id, name: s.name, progress: s.progress })),
    sectionsApproved: sections.filter((s) => s.approved).length,
    sectionsTotal: sections.length,
    unsettledDeviations: open.n,
  }
}

export async function artboardDetail(ctx: StoreContext, project: string, r: ArtboardRow) {
  return {
    ...artboardView(r),
    ...(await readArtboardFiles(ctx, project, r)),
    sections: sectionsOf(ctx.db, r.id),
    deviations: deviationsOf(ctx.db, r.id),
  }
}

/** The other members who have a draft on the project (plan §6; decision #41). */
export function presence(ctx: StoreContext, project: string, userId: number) {
  return ctx.db
    .query(
      `select u.handle, u.name, d.updated_at as updatedAt from drafts d join users u on u.id = d.user_id
       where d.project_id = ? and d.user_id <> ? order by u.handle`,
    )
    .all(project, userId) as { handle: string; name: string; updatedAt: string }[]
}

// ---- revision snapshot ----

/** design.json for a revision: every artboard with its role, hashes and sections. Null if none. */
export function designSnapshot(ctx: StoreContext, project: string) {
  const { db } = ctx
  const boards = db
    .query('select * from artboards where project_id = ? order by id')
    .all(project) as ArtboardRow[]
  if (!boards.length) return null
  return {
    artboards: boards.map((r) => ({
      id: r.id,
      page: r.page_id,
      letter: r.letter,
      role: r.role,
      ...(r.kind ? { kind: r.kind, parent: r.parent_id } : {}),
      html: r.html_hash,
      css: r.css_hash,
      sections: sectionsOf(db, r.id).map((s) => ({
        id: s.id,
        name: s.name,
        job: s.job,
        checklist: s.checklist,
        approved: s.approved,
      })),
    })),
  }
}

/** Adds design.json (a blob) to the files of a revision about to be saved. */
export async function withDesignFile(
  ctx: StoreContext,
  project: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const snap = designSnapshot(ctx, project)
  if (!snap) return files
  const hash = await putBlob(
    projectDir(ctx.dataDir, project),
    enc(`${JSON.stringify(snap, null, 2)}\n`),
  )
  return { ...files, 'design.json': hash }
}
