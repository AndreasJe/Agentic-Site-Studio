import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateDesign } from '../src/design-validate.ts'
import { TEST_GUIDE } from './guide-helpers.ts'

const dir = join(import.meta.dir, 'fixtures', 'design')
const run = (name: string) => {
  const cssFile = join(dir, `${name}.css`)
  return validateDesign(
    {
      html: readFileSync(join(dir, `${name}.html`), 'utf8'),
      css: existsSync(cssFile) ? readFileSync(cssFile, 'utf8') : '',
    },
    TEST_GUIDE,
  )
}

describe('validateDesign', () => {
  test('a clean page passes with no issues', () => {
    expect(run('clean')).toEqual({ errors: [], warnings: [] })
  })

  // fixture, rule, floor
  const failing: [string, string, boolean][] = [
    ['inline-script', 'inline-script', true],
    ['javascript-url', 'inline-script', true],
    ['event-handler', 'event-handler', true],
    ['duplicate-section', 'duplicate-section', true],
    ['section-id-format', 'section-id-format', true],
    ['absolute-url', 'absolute-url', true],
    ['root-relative', 'absolute-url', true],
    ['absolute-url-css', 'absolute-url', true],
    ['network-api', 'network-api', true],
    ['form-destination', 'form-destination', true],
    ['annotation', 'annotation', true],
    ['font', 'font', false],
    ['colour', 'colour', false],
    ['reduced-motion', 'reduced-motion', false],
  ]
  for (const [fixture, rule, floor] of failing) {
    test(`${fixture} gives ${rule} (floor: ${floor})`, () => {
      const hit = run(fixture).errors.filter((e) => e.rule === rule)
      expect(hit.length).toBeGreaterThan(0)
      expect(hit.every((e) => e.floor === floor)).toBe(true)
    })
  }

  test('form without a destination is a warning, not an error', () => {
    const r = run('form-open-question')
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.rule)).toEqual(['form-open-question'])
    expect(r.warnings[0]?.sectionId).toBe('s-abc123')
  })
  test('duplicate section names the section', () => {
    expect(run('duplicate-section').errors[0]?.sectionId).toBe('s-abc123')
  })
  test('colour and font errors report each offender', () => {
    expect(run('colour').errors.filter((e) => e.rule === 'colour').length).toBe(3)
    expect(run('font').errors).toHaveLength(1)
  })
  test('colour normalisation: hex3/8, rgb, hsl, names, var, keywords', () => {
    const errs = (css: string) => validateDesign({ html: '<p>x</p>', css }, TEST_GUIDE).errors
    expect(errs('a{color:#fff;background:#ffffffff;border-color:#0000}')).toEqual([])
    expect(errs('a{color:rgb(43 103 91 / 1);background:hsl(0 0% 100%)}')).toEqual([])
    // Black is outside this guide, so it is refused (§5.3: guide or derived only).
    expect(errs('a{color:#000}')).toHaveLength(1)
    expect(errs('a{color:white;background:transparent;border-color:currentColor}')).toEqual([])
    expect(errs('a{color:var(--missing)}').length).toBe(1)
    expect(errs('a{color:#ffffff80}').length).toBe(1)
    expect(errs('a{color:rgb(255 0 0)}').length).toBe(1)
  })
  test('https is allowed only on a[href]', () => {
    const r = validateDesign(
      { html: '<link rel="stylesheet" href="https://x.com/a.css">', css: '' },
      TEST_GUIDE,
    )
    expect(r.errors.map((e) => e.rule)).toContain('absolute-url')
  })
})
