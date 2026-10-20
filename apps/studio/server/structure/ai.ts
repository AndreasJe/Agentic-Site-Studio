// The AI's part of the structure (plan §10.2, §4.10; decision #44). The model only proposes:
// it returns data that code validates, and a person applies it (rules 1 and 3).
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Brief } from '../brief/brief.ts'
import { type Endpoint, llm } from '../llm/llm.ts'
import {
  isHidden,
  MENU_LIMITS,
  type MenuItem,
  type PageType,
  type Placement,
  type Structure,
} from './structure.ts'

const defs = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../../../../contracts/structure-proposal.schema.json'),
    'utf8',
  ),
).$defs as Record<'pages' | 'menu', Record<string, unknown>>

/** The reply parsed but is not usable (a menu that breaks the pattern, a page that isn't there). */
export class ProposalError extends Error {}

type Ctx = { endpoint: Endpoint; db: Database; project: string; user: string }
export type PageProposal = {
  title: string
  slug: string
  parent: string | null
  type: PageType
  placement: Placement
  reason: string
  status: 'proposed'
}
export type MenuProposal = { before: MenuItem[]; after: MenuItem[]; reasons: string[] }

const usage = (c: Ctx, action: string) => ({
  db: c.db,
  meta: {
    project: c.project,
    user: c.user,
    phase: 'structure',
    action,
    task_class: 'small structured',
    model_role: 'planner',
  },
})

const briefText = (b: Brief) =>
  b.blocks
    .filter((x) => x.state === 'filled' && x.text)
    .map((x) => {
      const ctas = (x.ctas ?? []).map((c) => `  call to action: "${c.label}" -> ${c.target}`)
      return [`## ${x.key}`, x.text, ...ctas].join('\n')
    })
    .join('\n\n')

export const hasBriefContent = (b: Brief) => briefText(b).length > 0

function treeText(s: Structure): string {
  const line = (p: Structure['pages'][number]) =>
    `- id ${p.id}: "${p.title}" /${p.slug} (parent ${p.parent ?? 'none'}, ${p.type}, ${p.placement}, ${p.status}, address ${p.root})`
  return s.pages.map(line).join('\n') || '(no pages yet)'
}

/** Parents must be an existing page id, or the slug of an earlier proposed page. */
function check(s: Structure, raw: Omit<PageProposal, 'status'>[]): PageProposal[] {
  const ids = new Set(s.pages.map((p) => p.id))
  const slugs = new Set<string>()
  return raw.map((p) => {
    if (p.parent !== null && !ids.has(p.parent) && !slugs.has(p.parent))
      throw new ProposalError(`"${p.title}" points to a parent that does not exist`)
    slugs.add(p.slug)
    return { ...p, status: 'proposed' as const }
  })
}

const PAGE_RULES =
  'Propose website pages as a tree. Use only what the brief says; never invent facts. ' +
  'A parent is the id of an existing page, the slug of an earlier proposed page, or null. ' +
  'Give each page a one-line reason that points to the brief. Landing pages are hidden.'

export async function draftStructure(c: Ctx, brief: Brief, s: Structure) {
  const r = await llm<{ pages: Omit<PageProposal, 'status'>[] }>({
    endpoint: c.endpoint,
    schema: defs.pages,
    schemaName: 'structure_draft',
    instructions: `${PAGE_RULES} Draft the first page tree from the audience, page jobs, ways in and calls to action. Do not repeat pages that exist.`,
    untrusted: `BRIEF\n${briefText(brief)}\n\nPAGES THAT EXIST\n${treeText(s)}`,
    usage: usage(c, 'draft_structure'),
  })
  return check(s, r.value.pages)
}

export async function suggestMissing(c: Ctx, brief: Brief, s: Structure) {
  const r = await llm<{ pages: Omit<PageProposal, 'status'>[] }>({
    endpoint: c.endpoint,
    schema: defs.pages,
    schemaName: 'structure_missing',
    instructions: `${PAGE_RULES} Check the brief against the pages that exist and propose only the pages that are missing, for example a page for a call to action. Return no pages when nothing is missing.`,
    untrusted: `BRIEF\n${briefText(brief)}\n\nPAGES THAT EXIST\n${treeText(s)}`,
    usage: usage(c, 'suggest_missing'),
  })
  return check(s, r.value.pages)
}

type Raw = { page: string; label: string; children?: Raw[] }

/** The same rules addToMenu enforces, checked up front so a bad proposal is refused as ai-failed. */
export function checkMenu(s: Structure, root: string, after: Raw[]): MenuItem[] {
  const limits = MENU_LIMITS[s.pattern].main
  const seen = new Set<string>()
  const walk = (items: Raw[], depth: number): MenuItem[] => {
    if (depth > limits.depth) throw new ProposalError(`The menu is deeper than ${limits.depth}`)
    if (items.length > limits.items)
      throw new ProposalError(`A menu level has more than ${limits.items} items`)
    return items.map((i) => {
      const p = s.pages.find((x) => x.id === i.page)
      if (!p) throw new ProposalError(`No such page: ${i.page}`)
      if (p.root !== root) throw new ProposalError(`${p.title} is on another address`)
      if (isHidden(s, p.id)) throw new ProposalError(`${p.title} is hidden and cannot go in a menu`)
      if (seen.has(p.id)) throw new ProposalError(`${p.title} is in the menu twice`)
      seen.add(p.id)
      const children = i.children?.length ? walk(i.children, depth + 1) : undefined
      return { page: p.id, label: i.label, ...(children ? { children } : {}) }
    })
  }
  return walk(after, 1)
}

export async function proposeMenu(
  c: Ctx,
  brief: Brief,
  s: Structure,
  root: string,
): Promise<MenuProposal> {
  const before = s.menus[root]?.main ?? []
  const limits = MENU_LIMITS[s.pattern].main
  const r = await llm<{ after: Raw[]; reasons: string[] }>({
    endpoint: c.endpoint,
    schema: defs.menu,
    schemaName: 'structure_menu',
    instructions:
      `Propose the main menu for the address ${root}. The pattern is ${s.pattern}: at most ${limits.items} items per level and ${limits.depth} level(s) deep. ` +
      'Use only pages on that address that are not hidden, each at most once. If the menu would outgrow the pattern, group pages. ' +
      'Give a short reason for each choice, taken from the brief.',
    untrusted: `BRIEF\n${briefText(brief)}\n\nPAGES\n${treeText(s)}\n\nCURRENT MAIN MENU\n${JSON.stringify(before)}`,
    usage: usage(c, 'propose_menu'),
  })
  return { before, after: checkMenu(s, root, r.value.after), reasons: r.value.reasons }
}
