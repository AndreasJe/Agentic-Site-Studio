// The brief as a document (plan §4; contracts/brief.schema.json; decision #42). Pure functions:
// every result is normalised and validated, so a filled field always has text and a source.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/brief.schema.json'), 'utf8'),
)
const validate = addFormats(new Ajv2020({ strict: false })).compile(schema)

export const BLOCK_KEYS: string[] = schema.properties.blocks.items.properties.key.enum
export type Approval = 'off' | 'optional' | 'required'
export type Source = {
  kind: 'user' | 'existing_brief' | 'document'
  by?: string
  ref?: string
  at?: string
}
export type Cta = {
  label: string
  target: string
  visitorGets?: string
  priority: 'primary' | 'secondary'
}
export type Block = {
  key: string
  state: 'filled' | 'not_set'
  text?: string
  source?: Source
  aiSorted?: boolean
  ctas?: Cta[]
}
export type Brief = {
  id: string
  title: string
  author: string
  scope: string
  status: 'draft' | 'optional_review' | 'approved'
  templateVersion: number
  blocks: Block[]
}

export class BriefError extends Error {}

export function emptyBrief(h: { id: string; title: string; author: string }): Brief {
  return {
    ...h,
    scope: '',
    status: 'draft',
    templateVersion: 1,
    blocks: BLOCK_KEYS.map((key) => ({ key, state: 'not_set' as const })),
  }
}

function cleanBlock(b: Block): Block {
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  // "Don't invent" (plan §4.5): no text or no source → "Not set yet."
  if (b.state !== 'filled' || !text || !b.source?.kind) return { key: b.key, state: 'not_set' }
  return {
    key: b.key,
    state: 'filled',
    text,
    source: b.source,
    ...(b.aiSorted ? { aiSorted: true } : {}),
    ...(b.ctas?.length ? { ctas: b.ctas } : {}),
  }
}

/** Every block present, in template order, cleaned; then the whole thing checked against the contract. */
export function normalizeBrief(raw: unknown): Brief {
  const b = raw as Brief
  const byKey = new Map((b.blocks ?? []).map((x) => [x.key, x]))
  const out: Brief = {
    id: b.id,
    title: b.title,
    author: b.author,
    scope: b.scope ?? '',
    status: b.status ?? 'draft',
    templateVersion: b.templateVersion ?? 1,
    blocks: BLOCK_KEYS.map((key) => cleanBlock(byKey.get(key) ?? { key, state: 'not_set' })),
  }
  if (!validate(out))
    throw new BriefError(`brief refused: ${JSON.stringify(validate.errors?.[0] ?? {})}`)
  return out
}

function checkCtas(ctas: Cta[]) {
  if (ctas.filter((c) => c.priority === 'primary').length > 1) {
    throw new BriefError('Only one primary call to action is allowed.')
  }
  for (const c of ctas) {
    // A target is a page ID or an https URL, or left empty for now (decision #42).
    if (c.target && !/^https:\/\//.test(c.target) && !/^[a-z0-9-]+$/.test(c.target)) {
      throw new BriefError(`The target "${c.target}" must be a page or an https link.`)
    }
  }
}

export function setBlock(
  brief: Brief,
  key: string,
  edit: { text: string; source: Source; ctas?: Cta[]; aiSorted?: boolean },
): Brief {
  if (!BLOCK_KEYS.includes(key)) throw new BriefError(`unknown block ${key}`)
  if (edit.ctas) checkCtas(edit.ctas)
  const blocks = brief.blocks.map((b) =>
    b.key === key ? { key, state: 'filled' as const, ...edit } : b,
  )
  // Any edit after approval puts the brief back to draft (decision #42).
  return normalizeBrief({ ...brief, status: 'draft', blocks })
}

export function clearBlock(brief: Brief, key: string): Brief {
  if (!BLOCK_KEYS.includes(key)) throw new BriefError(`unknown block ${key}`)
  return normalizeBrief({
    ...brief,
    status: 'draft',
    blocks: brief.blocks.map((b) => (b.key === key ? { key, state: 'not_set' } : b)),
  })
}

/** Derived, never stored (plan §4.1). */
export const openQuestions = (brief: Brief) =>
  brief.blocks.filter((b) => b.state === 'not_set').map((b) => b.key)

/** Open questions never block approval, even when it is Required (plan §4.6). */
export function approve(brief: Brief, setting: Approval): Brief {
  if (setting === 'off') throw new BriefError('Brief approval is off for this install.')
  return normalizeBrief({ ...brief, status: 'approved' })
}

export type ChangeEntry = { at: string; key: string; change: 'filled' | 'edited' | 'cleared' }

/** Derived from successive versions of the brief (plan §4.1). */
export function changeLog(versions: { at: string; brief: Brief }[]): ChangeEntry[] {
  const out: ChangeEntry[] = []
  for (let i = 1; i < versions.length; i++) {
    const prev = new Map(versions[i - 1]?.brief.blocks.map((b) => [b.key, b]))
    for (const b of versions[i]?.brief.blocks ?? []) {
      const p = prev.get(b.key)
      const at = versions[i]?.at ?? ''
      if (p?.state !== 'filled' && b.state === 'filled')
        out.push({ at, key: b.key, change: 'filled' })
      else if (p?.state === 'filled' && b.state === 'not_set')
        out.push({ at, key: b.key, change: 'cleared' })
      else if (
        p?.state === 'filled' &&
        b.state === 'filled' &&
        (p.text !== b.text || JSON.stringify(p.ctas) !== JSON.stringify(b.ctas))
      ) {
        out.push({ at, key: b.key, change: 'edited' })
      }
    }
  }
  return out
}
