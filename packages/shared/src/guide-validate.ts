// Validates guide.json against contracts/guide.schema.json and recomputes every derived colour
// with the shared colour module (rule 11). A mismatch is an error unless `pinned: true`.
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../../../contracts/guide.schema.json'
import { deriveHex } from './colour.ts'

export type Guide = {
  version: number
  fonts: string[]
  dominant: string
  colors: Record<string, { hex: string; role: string }>
  derived: { hex: string; recipe: string; use: string; pinned?: boolean }[]
  motion: Record<string, unknown>
}

export type DerivedMismatch = {
  index: number
  recipe: string
  use: string
  stored: string
  computed: string | null
  pinned: boolean
}

export type GuideCheck = {
  ok: boolean
  errors: string[]
  /** Every derived colour whose stored hex differs from the recipe (pinned ones included, for the sign-off list). */
  mismatches: DerivedMismatch[]
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
const check = ajv.compile(schema)

export function validateGuide(input: unknown): GuideCheck {
  if (!check(input)) {
    const errors = (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)
    return { ok: false, errors, mismatches: [] }
  }
  const guide = input as Guide
  const errors: string[] = []
  const mismatches: DerivedMismatch[] = []
  if (!guide.fonts.includes(guide.dominant))
    errors.push(`dominant font "${guide.dominant}" is not in fonts`)
  guide.derived.forEach((d, index) => {
    const computed = deriveHex(d.recipe, guide.colors)
    const pinned = d.pinned === true
    if (computed === d.hex.toLowerCase()) return
    mismatches.push({ index, recipe: d.recipe, use: d.use, stored: d.hex, computed, pinned })
    if (computed === null)
      errors.push(
        `derived[${index}] "${d.recipe}" cannot be computed (unknown colour or malformed recipe)`,
      )
    else if (!pinned)
      errors.push(`derived[${index}] "${d.recipe}" is ${d.hex} but OKLab gives ${computed}`)
  })
  return { ok: errors.length === 0, errors, mismatches }
}
