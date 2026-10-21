// The AI's part of the design (plan §6.4-6.6; decision #45). The model only returns a take:
// data that code validates (rule 3) and that a person applies (rule 1). Nothing here writes an
// artboard except applyTake, and that goes through createArtboard and applyHtml like any edit.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Issue, validateDesign } from '@site-studio/shared/design-validate'
import type { Guide } from '@site-studio/shared/guide-validate'
import { parse, parseFragment } from 'parse5'
import { currentNumber, readGuide } from '../brand/guide.ts'
import { type Endpoint, LlmSchemaError, llm } from '../llm/llm.ts'
import { estimateTokens } from '../llm/usage.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, type StoreContext } from '../store/revisions.ts'
import {
  type ArtboardRow,
  applyHtml,
  assignSectionIds,
  createArtboard,
  DesignError,
  type Level,
  readArtboardFiles,
  sectionsFromHtml,
} from './design.ts'

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/design-take.schema.json'), 'utf8'),
)

export const AXES = {
  layout: 'how the section is arranged',
  density: 'the amount of content and whitespace',
  depth:
    'flat (everything shown directly) or layered (details behind tabs, accordions, hovers or popups)',
  navigation: 'the navigation pattern',
  media: 'text-led, balanced or visual-led',
  tone: 'the voice of the copy',
  'colour-rhythm': 'which guide colours carry the bands',
  motion: 'how alive it feels, from still to animated',
} as const
export type Axis = keyof typeof AXES

export type Proposal = { kind: 'colour' | 'component'; name: string; detail: string }
type Reply = { html: string; css: string; summary: string; proposals: Proposal[] }

export type AiCtx = {
  endpoint: Endpoint
  ctx: StoreContext
  project: string
  user: string
  /** The page's own words from the structure: title and mini-brief, where they exist. */
  page?: { title: string; miniBrief?: { goal: string; visitorAction: string } }
  signal?: AbortSignal
}
export type TakeInput = {
  artboard: ArtboardRow
  scope: 'page' | string
  prompt: string
  axis?: Axis
  steer?: string
  level: Level
}

const bad = (code: string, status: 400 | 404 | 409 = 400): never => {
  throw new DesignError(status, code)
}
const MAX_TEXT = 4000

// ---- locating and splicing sections ----

type Attr = { name: string; value: string }
type Node = {
  nodeName: string
  tagName?: string
  attrs?: Attr[]
  childNodes?: Node[]
  content?: { childNodes: Node[] }
  sourceCodeLocation?: { startOffset: number; endOffset: number } | null
}
const attrOf = (n: Node, name: string) => n.attrs?.find((a) => a.name === name)?.value

function walk(n: Node, fn: (n: Node) => void) {
  fn(n)
  for (const c of n.childNodes ?? []) walk(c, fn)
  for (const c of n.content?.childNodes ?? []) walk(c, fn)
}

/** The source range of the element carrying data-section="id", or null. */
function locate(html: string, id: string): { start: number; end: number } | null {
  let hit: Node | null = null
  walk(parse(html, { sourceCodeLocationInfo: true }) as unknown as Node, (n) => {
    if (!hit && n.tagName && attrOf(n, 'data-section') === id) hit = n
  })
  const loc = (hit as Node | null)?.sourceCodeLocation
  return loc ? { start: loc.startOffset, end: loc.endOffset } : null
}

class AssembleError extends Error {}

/**
 * The page with a section take spliced in: the element with the scope's data-section is replaced;
 * a section that carries a new, unused id keeps the place. Code's ids are never the model's job,
 * so a section without data-section gets the one it replaces.
 */
export function spliceSection(
  base: string,
  scope: string,
  sectionHtml: string,
): { html: string; sectionId: string } {
  let frag = sectionHtml.trim()
  const top = (
    parseFragment(frag, { sourceCodeLocationInfo: true }) as unknown as Node
  ).childNodes?.filter((n) => n.nodeName !== '#comment')
  const elements = (top ?? []).filter((n) => n.tagName)
  const stray = (top ?? []).some((n) => n.nodeName === '#text' && /\S/.test(textValue(n)))
  if (elements.length !== 1 || stray)
    throw new AssembleError('For a section, html must be exactly one element: the section.')
  const el = elements[0] as Node
  let id = attrOf(el, 'data-section')
  if (id === undefined) {
    const at = 1 + (el.tagName as string).length
    frag = `${frag.slice(0, at)} data-section="${scope}"${frag.slice(at)}`
    id = scope
  }
  const where = locate(base, scope)
  if (!where) throw new AssembleError(`The page has no section ${scope}.`)
  if (id !== scope) {
    const others = sectionsFromHtml(base).filter((s) => s.id !== scope)
    if (!/^s-[a-z0-9]{6}$/.test(id) || others.some((s) => s.id === id))
      throw new AssembleError(
        `The section's data-section "${id}" is not allowed. Keep "${scope}" or leave data-section off.`,
      )
  }
  return { html: base.slice(0, where.start) + frag + base.slice(where.end), sectionId: id }
}
const textValue = (n: Node) => (n as unknown as { value?: string }).value ?? ''

const hasStyleLink = (html: string): boolean => {
  let ok = false
  walk(parse(html) as unknown as Node, (n) => {
    if (
      n.tagName === 'link' &&
      attrOf(n, 'rel')?.toLowerCase() === 'stylesheet' &&
      attrOf(n, 'href') === 'style.css'
    )
      ok = true
  })
  return ok
}

// ---- the prompt ----

const guideOf = (ctx: StoreContext): Guide => {
  const g = readGuide(ctx.dataDir, currentNumber(ctx.db))
  if (!g) throw new DesignError(500, 'no-guide')
  return g
}

function guideText(g: Guide): string {
  const colours = Object.entries(g.colors).map(([n, c]) => `  ${n}: ${c.hex} (${c.role})`)
  const derived = g.derived.map((d) => `  ${d.hex}: ${d.recipe}, for ${d.use}`)
  return [
    `Fonts: ${g.fonts.join(', ')}. Dominant font: ${g.dominant}. A font-family must start with one of these.`,
    `Colours (use only these and the derived ones):\n${colours.join('\n')}`,
    `Derived colours:\n${derived.join('\n') || '  none'}`,
    `Motion tokens: ${JSON.stringify(g.motion)}`,
  ].join('\n')
}

const LEVEL_TEXT: Record<Level, string> = {
  follow:
    'Level: follow the site. Stay inside the guide and reuse the site\'s existing components and patterns. Add nothing new. "proposals" must be empty.',
  explore:
    'Level: explore. Stay inside the guide, but you may add new components. List every new component or colour you use in "proposals"; a person confirms them.',
  'think-new':
    'Level: think new. You may go outside the guide (fonts, colours, patterns) if it serves the idea. Every break is marked as a deviation for a person to settle, so list them in "proposals". The hard rules still hold.',
}

const HARD_RULES = `HARD RULES. Code refuses a reply that breaks any of them:
- No <script> with inline code, no inline event handlers (onclick and the like), no javascript: URLs. Scripts only as separate files with a relative src.
- Links, images and files use relative paths only: no http:, https:, // or leading /.
- Keep every existing data-section attribute exactly as it is. Do not invent data-section ids: leave them off new sections and use <section> for them.
- Forms must not submit anywhere: leave out action.
- Any animation or transition needs an @media (prefers-reduced-motion: reduce) block that stills it. Use the guide's motion tokens.
- "css" is the whole content of style.css. The page's head links it with <link rel="stylesheet" href="style.css">.
- Use only guide fonts and guide or derived colours, written as hex.
- Never put commentary or notes for the reader inside the HTML.`

export type Fix = { id: number; sectionId: string | null; rule: string; message: string }

type Built = { instructions: string; untrusted: string; target: number }

async function build(c: AiCtx, input: TakeInput, fix?: Fix): Promise<Built> {
  const { ctx, project } = c
  const files = await readArtboardFiles(ctx, project, input.artboard)
  const guide = guideOf(ctx)
  const secs = sectionsFromHtml(files.html)
  const jobs = new Map(
    (
      ctx.db
        .query('select section_id, job from sections where artboard_id = ?')
        .all(input.artboard.id) as { section_id: string; job: string }[]
    ).map((r) => [r.section_id, r.job]),
  )
  const sectionLines = secs
    .map((s) => `- ${s.id}: "${s.name}", job ${jobs.get(s.id ?? '') ?? 'inform'}`)
    .join('\n')
  const section = input.scope === 'page' ? null : secs.find((s) => s.id === input.scope)

  const scopeText = section
    ? `Scope: the section ${input.scope} only. "html" is that one section's outerHTML (exactly one element, data-section="${input.scope}"). "css" is the whole updated style.css. Do not touch any other section.`
    : 'Scope: the whole page. "html" is the full document, "css" the whole style.css.'
  const axisText = input.axis
    ? `Axis: ${input.axis} (${AXES[input.axis]}). Change this axis and nothing else; keep the content, the structure and the other axes as they are. The steer text applies to this axis only; if it asks for something outside the axis, ignore that part and say so in "summary".`
    : 'One direction only. Make the single best take that answers the request.'
  const fixText = fix
    ? "This is a fix. Bring the section back within the guide and keep its idea: same content, same structure, same feel. The validator's finding is in the data. Change nothing else."
    : 'Reuse the existing sections, copy and facts. Never invent facts, names or numbers; keep the page jobs. A section keeps its job.'

  const instructions = [
    'You design one take of a page of a static website for a person who is not a designer. Reply with JSON: html, css, summary (one or two plain sentences on what changed and why), proposals.',
    HARD_RULES,
    `THE GUIDE\n${guideText(guide)}`,
    LEVEL_TEXT[input.level],
    scopeText,
    axisText,
    fixText,
  ].join('\n\n')

  const page = c.page
  const untrusted = [
    fix
      ? `VALIDATOR FINDING\nrule ${fix.rule}${fix.sectionId ? ` in ${fix.sectionId}` : ''}: ${fix.message}`
      : `REQUEST\n${input.prompt}`,
    input.axis && input.steer ? `STEER FOR ${input.axis}\n${input.steer}` : '',
    page
      ? `PAGE\n"${page.title}"${page.miniBrief ? `\nGoal: ${page.miniBrief.goal}\nVisitor action: ${page.miniBrief.visitorAction}` : ''}`
      : '',
    `SECTIONS AND THEIR JOBS\n${sectionLines || '(none)'}`,
    `CURRENT HTML\n${files.html}`,
    `CURRENT CSS\n${files.css}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    instructions,
    untrusted,
    target: section
      ? section.outer.length + files.css.length
      : files.html.length + files.css.length,
  }
}

function validateInput(c: AiCtx, input: TakeInput, files: { html: string }, fix?: Fix) {
  if (input.axis !== undefined && !(input.axis in AXES)) bad('bad-axis')
  if (input.steer && !input.axis) bad('steer-needs-axis')
  if (input.axis && input.scope === 'page' && input.axis !== 'layout') bad('page-axis-layout-only')
  if (!['follow', 'explore', 'think-new'].includes(input.level)) bad('bad-level')
  if (input.prompt.length > MAX_TEXT || (input.steer ?? '').length > MAX_TEXT) bad('too-long')
  if (!fix && !input.axis && !input.prompt.trim()) bad('prompt-required')
  if (input.scope !== 'page' && !sectionsFromHtml(files.html).some((s) => s.id === input.scope))
    bad('no-such-section', 404)
  void c
}

// ---- estimate (decision #20: a low-high range, from the input size when there is no history) ----

export async function estimateTake(c: AiCtx, input: TakeInput) {
  const files = await readArtboardFiles(c.ctx, c.project, input.artboard)
  validateInput(c, { ...input, prompt: input.prompt || 'estimate' }, files)
  const b = await build(c, input)
  const inputTokens = estimateTokens(b.instructions) + estimateTokens(b.untrusted)
  const out = Math.ceil(b.target / 4)
  // Low: one clean reply about the size of what is there. High: bigger, and all three attempts.
  return {
    inputTokens,
    low: inputTokens + Math.ceil(out * 0.6) + 80,
    high: 3 * (inputTokens + Math.ceil(out * 1.6) + 400),
    estimated: true as const,
  }
}

// ---- generating ----

export type TakeRow = {
  id: number
  artboard_id: number
  scope: string
  axis: string
  level: Level
  html_hash: string
  css_hash: string
  created_by: string
  created_at: string
  applied: number
  summary: string
  proposals: string
  prompt: string
  steer: string
  section_id: string | null
  deviation_id: number | null
}

const key = (i: Pick<Issue, 'rule' | 'message' | 'sectionId'>) =>
  `${i.sectionId ?? ''}|${i.rule}|${i.message}`
const isFloor = (i: Issue) => i.floor || i.rule === 'css-parse'
const enc = (s: string) => new TextEncoder().encode(s)

export type TakeOutcome = { ok: true; take: TakeRow } | { ok: false; reasons: string[] }

export async function generateTake(c: AiCtx, input: TakeInput, fix?: Fix): Promise<TakeOutcome> {
  const { ctx, project } = c
  const files = await readArtboardFiles(ctx, project, input.artboard)
  validateInput(c, input, files, fix)
  const guide = guideOf(ctx)
  const built = await build(c, input, fix)
  // A fix may leave the page's other guide breaks alone; it must clear its own and add none.
  const before = new Set(
    validateDesign({ html: assignSectionIds(files.html), css: files.css }, guide).errors.map(key),
  )
  const fixKey = fix ? key({ ...fix, sectionId: fix.sectionId ?? undefined }) : null

  const check = (value: unknown): string | null => {
    const r = value as Reply
    let html: string
    try {
      if (input.scope === 'page') html = r.html
      else {
        html = spliceSection(files.html, input.scope, r.html).html
      }
    } catch (e) {
      if (e instanceof AssembleError) return e.message
      throw e
    }
    if (input.scope === 'page' && !hasStyleLink(html))
      return 'The head must contain <link rel="stylesheet" href="style.css">.'
    const result = validateDesign({ html: assignSectionIds(html), css: r.css }, guide)
    const failing = result.errors.filter((e) => {
      if (isFloor(e)) return true
      if (input.level === 'think-new') return false
      return fix ? key(e) === fixKey || !before.has(key(e)) : true
    })
    if (!failing.length) return null
    return `The validator refused this: ${failing
      .map((i) => `[${i.rule}${i.sectionId ? ` in ${i.sectionId}` : ''}] ${i.message}`)
      .join(' ')}`
  }

  let reply: Reply
  try {
    reply = (
      await llm<Reply>({
        endpoint: c.endpoint,
        schema,
        schemaName: 'design_take',
        instructions: built.instructions,
        untrusted: built.untrusted,
        usage: {
          db: ctx.db,
          meta: {
            project,
            user: c.user,
            phase: 'design',
            action: fix ? 'fix_deviation' : 'generate_take',
            task_class: 'design',
            model_role: 'designer',
          },
        },
        check,
        signal: c.signal,
      })
    ).value
  } catch (e) {
    if (e instanceof LlmSchemaError) return { ok: false, reasons: [e.errors] }
    throw e
  }

  // Stored as the whole page, so a take previews like any artboard; a section take is spliced
  // again onto the artboard as it is at apply time.
  const spliced = input.scope === 'page' ? null : spliceSection(files.html, input.scope, reply.html)
  const html = assignSectionIds(spliced ? spliced.html : reply.html)
  const dir = projectDir(ctx.dataDir, project)
  const htmlHash = await putBlob(dir, enc(html))
  const cssHash = await putBlob(dir, enc(reply.css))
  const row = ctx.db
    .query(
      `insert into takes (artboard_id, scope, axis, level, html_hash, css_hash, created_by, created_at,
         applied, summary, proposals, prompt, steer, section_id, deviation_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) returning *`,
    )
    .get(
      input.artboard.id,
      input.scope,
      input.axis ?? '',
      input.level,
      htmlHash,
      cssHash,
      c.user,
      new Date().toISOString(),
      reply.summary,
      JSON.stringify(reply.proposals),
      fix ? '' : input.prompt,
      input.steer ?? '',
      spliced?.sectionId ?? null,
      fix?.id ?? null,
    ) as TakeRow
  return { ok: true, take: row }
}

/** A Fix-it call (plan §6.6): back within the guide, keeping the idea. Level is follow. */
export function fixDeviation(
  c: AiCtx,
  artboard: ArtboardRow,
  d: { id: number; section_id: string | null; rule: string; message: string },
) {
  return generateTake(
    c,
    { artboard, scope: d.section_id ?? 'page', prompt: '', level: 'follow' },
    { id: d.id, sectionId: d.section_id, rule: d.rule, message: d.message },
  )
}

// ---- reading and applying ----

export function getTake(ctx: StoreContext, artboardId: number, takeId: number): TakeRow | null {
  return ctx.db
    .query('select * from takes where id = ? and artboard_id = ?')
    .get(takeId, artboardId) as TakeRow | null
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b)

async function takeFiles(ctx: StoreContext, project: string, t: TakeRow) {
  const dir = projectDir(ctx.dataDir, project)
  return { html: dec(await getBlob(dir, t.html_hash)), css: dec(await getBlob(dir, t.css_hash)) }
}

/** The take as the API shows it. Warnings and deviations come from the validator, not the model. */
export async function takeView(ctx: StoreContext, project: string, t: TakeRow) {
  const files = await takeFiles(ctx, project, t)
  const guide = guideOf(ctx)
  const result = validateDesign({ html: files.html, css: files.css }, guide)
  return {
    id: t.id,
    artboardId: t.artboard_id,
    scope: t.scope,
    axis: t.axis || null,
    level: t.level,
    html: files.html,
    sectionHtml:
      t.section_id === null
        ? null
        : (sectionsFromHtml(files.html).find((s) => s.id === t.section_id)?.outer ?? null),
    css: files.css,
    summary: t.summary,
    proposals: JSON.parse(t.proposals) as Proposal[],
    warnings: result.warnings,
    deviations: result.errors.filter((e) => !isFloor(e)),
    applied: !!t.applied,
    deviationId: t.deviation_id,
    createdBy: t.created_by,
    createdAt: t.created_at,
  }
}

/**
 * Applies a take. Think new always makes a new Alternative, even beside an approved Lead, and its
 * guide breaks become deviations. A whole-page take also makes a new Alternative (plan §6.2).
 * Follow and explore on one section go into the same artboard, where applyHtml refuses a locked
 * section. A Fix-it take repairs in place and settles its deviation.
 */
export async function applyTake(
  ctx: StoreContext,
  project: string,
  board: ArtboardRow,
  take: TakeRow,
  by: string,
) {
  if (take.applied) bad('take-applied', 409)
  const files = await takeFiles(ctx, project, take)
  let html = files.html
  if (take.scope !== 'page') {
    const where = take.section_id ? locate(files.html, take.section_id) : null
    if (!where || !take.section_id) bad('take-broken', 409)
    const frag = files.html.slice(
      (where as { start: number }).start,
      (where as { end: number }).end,
    )
    const current = await readArtboardFiles(ctx, project, board)
    try {
      html = spliceSection(current.html, take.scope, frag).html
    } catch (e) {
      if (e instanceof AssembleError) throw new DesignError(409, 'section-gone', e.message)
      throw e
    }
  }
  const repair = take.deviation_id !== null
  let artboard: ArtboardRow
  let issues: Issue[]
  let warnings: Issue[]
  if (repair || (take.level !== 'think-new' && take.scope !== 'page')) {
    // A fix clears its own finding; the page's other breaks stay as deviations.
    const r = await applyHtml(ctx, project, board.id, html, files.css, {
      level: repair ? 'think-new' : take.level,
    })
    ;({ artboard, issues, warnings } = r)
  } else {
    artboard = await createArtboard(ctx, {
      project,
      pageId: board.page_id,
      html,
      css: files.css,
      description: take.summary.slice(0, 200),
      role: 'alternative',
      level: take.level,
      by,
    })
    const r = validateDesign({ html, css: files.css }, guideOf(ctx))
    issues = take.level === 'think-new' ? r.errors.filter((e) => !isFloor(e)) : []
    warnings = r.warnings
  }
  // A Fix-it take settles its deviation only if the break is really gone after applying: the
  // guide or the page may have changed since the take was made (review of M4).
  const dev =
    take.deviation_id === null
      ? null
      : (ctx.db
          .query('select section_id, rule, message from deviations where id = ?')
          .get(take.deviation_id) as {
          section_id: string | null
          rule: string
          message: string
        } | null)
  const stillBroken =
    dev !== null &&
    issues.some(
      (i) =>
        i.rule === dev.rule &&
        i.message === dev.message &&
        (i.sectionId ?? null) === (dev.section_id ?? null),
    )
  ctx.db.transaction(() => {
    ctx.db.query('update takes set applied = 1 where id = ?').run(take.id)
    if (take.deviation_id !== null && !stillBroken)
      ctx.db
        .query(
          "update deviations set status = 'fixed' where id = ? and status in ('open', 'experiment', 'proposed')",
        )
        .run(take.deviation_id)
  })()
  return { artboard, issues, warnings }
}
