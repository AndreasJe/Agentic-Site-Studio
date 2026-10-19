// The brief's AI actions (plan §4.3, §4.4, §4.10). The model only proposes; people apply.
// Pasted notes and documents go in as quoted data (plan §21.2); the model has no tools (rule 1).
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'
import { extractText, getDocumentProxy } from 'unpdf'
import { type Endpoint, llm } from '../llm/llm.ts'

const sortSchema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../contracts/brief-sort.schema.json'), 'utf8'),
)
const followUpsSchema = {
  type: 'object',
  required: ['questions'],
  additionalProperties: false,
  properties: {
    questions: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 5 },
  },
}
const tightenSchema = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1 } },
}

export type Sorted = {
  blocks: { key: string; text: string; source: { kind: 'user'; ref?: string }; aiSorted: true }[]
  leftOut: string[]
}

type Ctx = { endpoint: Endpoint; db: Database; project: string; user: string }

const usage = (c: Ctx, action: string, task_class: string) => ({
  db: c.db,
  meta: {
    project: c.project,
    user: c.user,
    phase: 'brief',
    action,
    task_class,
    model_role: 'planner',
  },
})

export async function sortNotes(c: Ctx, notes: string, action = 'sort_notes') {
  const r = await llm<Sorted>({
    endpoint: c.endpoint,
    schema: sortSchema,
    schemaName: 'brief_sort',
    instructions:
      'Sort the material into brief blocks. Use only what the material says; never invent facts. ' +
      'Leave a block out when the material says nothing about it. Put sentences that fit no block in leftOut.',
    untrusted: notes,
    usage: usage(c, action, 'small structured'),
  })
  return r.value
}

export async function followUps(c: Ctx, key: string, text: string) {
  const r = await llm<{ questions: string[] }>({
    endpoint: c.endpoint,
    schema: followUpsSchema,
    schemaName: 'brief_follow_ups',
    instructions: `Ask up to five short follow-up questions that would make the "${key}" block of a website brief more precise.`,
    untrusted: text,
    usage: usage(c, 'follow_ups', 'writing'),
  })
  return r.value.questions
}

export async function tighten(c: Ctx, key: string, text: string) {
  const r = await llm<{ text: string }>({
    endpoint: c.endpoint,
    schema: tightenSchema,
    schemaName: 'brief_tighten',
    instructions: `Rewrite the "${key}" block of a website brief more tightly. Keep every fact; add none.`,
    untrusted: text,
    usage: usage(c, 'tighten', 'writing'),
  })
  return r.value.text
}

export const MATERIAL_MAX_BYTES = 10 * 1024 * 1024
const TYPES: Record<string, 'text' | 'pdf'> = {
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/pdf': 'pdf',
}

export class MaterialError extends Error {
  constructor(
    readonly status: 413 | 415 | 422,
    message: string,
  ) {
    super(message)
  }
}

/** Text out of an upload, plus the bytes to store (PDF metadata removed, decision #42). */
export async function readMaterial(file: File): Promise<{ text: string; stored: Uint8Array }> {
  if (file.size > MATERIAL_MAX_BYTES) throw new MaterialError(413, 'Files can be up to 10 MB.')
  const ext = file.name.toLowerCase().split('.').pop()
  const kind =
    TYPES[file.type] ?? (ext === 'md' || ext === 'txt' ? 'text' : ext === 'pdf' ? 'pdf' : undefined)
  if (!kind) throw new MaterialError(415, 'Use text, Markdown or PDF.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (kind === 'text') return { text: new TextDecoder().decode(bytes), stored: bytes }
  let stored: Uint8Array
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    // Drop the document info dictionary and the XMP stream.
    doc.context.trailerInfo.Info = undefined
    doc.catalog.delete(PDFName.of('Metadata'))
    stored = await doc.save({ updateFieldAppearances: false })
  } catch {
    throw new MaterialError(422, 'That PDF could not be read.')
  }
  const pdf = await getDocumentProxy(new Uint8Array(stored))
  const { text } = await extractText(pdf, { mergePages: true })
  return { text: String(text), stored }
}
