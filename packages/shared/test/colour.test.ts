import { describe, expect, test } from 'bun:test'
import golden from '../../../contracts/fixtures/derived-colours.golden.json'
import { contrastRatio, deriveHex, mix, parseRecipe } from '../src/colour.ts'
import { validateGuide } from '../src/guide-validate.ts'
import { TEST_GUIDE } from './guide-helpers.ts'

describe('colour module (decision #14)', () => {
  for (const v of golden.reference_vectors) {
    test(`mix: ${v.recipe}`, () => expect(mix(v.a, v.b, v.amount)).toBe(v.oklab_hex))
  }
  test('from_existing_guide entries match', () => {
    const colours = { 'ice-blue': '#d2e9e3' }
    for (const e of golden.from_existing_guide) {
      expect(deriveHex(e.recipe, colours)).toBe(e.oklab_hex)
      expect(e.guide_hex).toBe(e.oklab_hex)
    }
  })
  test('mix endpoints are exact', () => {
    expect(mix('#2b675b', '#ffffff', 1)).toBe('#2b675b')
    expect(mix('#2b675b', '#ffffff', 0)).toBe('#ffffff')
  })
  test('parseRecipe and deriveHex', () => {
    expect(parseRecipe('62% ice-blue + white')).toEqual({ amount: 0.62, a: 'ice-blue', b: 'white' })
    expect(parseRecipe('nonsense')).toBeNull()
    expect(deriveHex('70% dark-green + black', { 'dark-green': { hex: '#2b675b' } })).toBe(
      '#163d35',
    )
    expect(deriveHex('50% nope + white', {})).toBeNull()
  })
  test('contrastRatio (WCAG)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('guide validator', () => {
  test('accepts a guide whose derived colours match', () => {
    const r = validateGuide(TEST_GUIDE)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })
  test('rejects a mismatch and lists it', () => {
    const g = {
      ...TEST_GUIDE,
      derived: [{ hex: '#d5e1de', recipe: '20% dark-green + white', use: 'hover' }],
    }
    const r = validateGuide(g)
    expect(r.ok).toBe(false)
    expect(r.mismatches).toEqual([
      {
        index: 0,
        recipe: '20% dark-green + white',
        use: 'hover',
        stored: '#d5e1de',
        computed: '#d3dfdc',
        pinned: false,
      },
    ])
  })
  test('pinned mismatch is allowed but still listed', () => {
    const g = {
      ...TEST_GUIDE,
      derived: [{ hex: '#d5e1de', recipe: '20% dark-green + white', use: 'hover', pinned: true }],
    }
    const r = validateGuide(g)
    expect(r.ok).toBe(true)
    expect(r.mismatches[0]?.pinned).toBe(true)
  })
  test('rejects schema violations', () => {
    expect(validateGuide({ version: 1 }).ok).toBe(false)
  })
  test('unknown colour in a recipe is an error', () => {
    const g = { ...TEST_GUIDE, derived: [{ hex: '#ffffff', recipe: '50% nope + white', use: 'x' }] }
    expect(validateGuide(g).ok).toBe(false)
  })
})
