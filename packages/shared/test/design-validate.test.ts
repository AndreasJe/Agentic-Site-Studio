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

// Bypasses found in the M4 security review; each must be refused.
describe('review of M4: parser and URL bypasses', () => {
  const floorRules = (html: string, css = '') =>
    validateDesign({ html, css }, TEST_GUIDE)
      .errors.filter((e) => e.floor)
      .map((e) => e.rule)
  const cases: [string, string, string][] = [
    [
      'noscript hides markup',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
      'forbidden-element',
    ],
    [
      'noscript mismatch still sees the handler',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
      'event-handler',
    ],
    ['srcdoc', '<iframe srcdoc="<b>x</b>"></iframe>', 'forbidden-element'],
    ['object data', '<object data="x.svg"></object>', 'forbidden-element'],
    [
      'meta refresh',
      '<meta http-equiv="refresh" content="0;url=https://e.x">',
      'forbidden-element',
    ],
    ['base', '<base href="https://e.x/">', 'forbidden-element'],
    ['backslash host', '<img src="\\\\evil.host/x">', 'absolute-url'],
    ['ftp', '<img src="ftp://e.x/a.png">', 'absolute-url'],
    ['ws on a link', '<a href="ws://e.x">x</a>', 'absolute-url'],
    ['data script', '<script src="data:text/javascript,alert(1)"></script>', 'inline-script'],
    ['formaction', '<form><button formaction="x">Go</button></form>', 'form-destination'],
    ['formmethod post', '<form><button formmethod="post">Go</button></form>', 'form-destination'],
    ['ping', '<a href="#" ping="https://e.x/p">x</a>', 'absolute-url'],
    ['background attr', '<table background="https://e.x/a.png"></table>', 'absolute-url'],
    [
      'svg set to javascript',
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>',
      'inline-script',
    ],
  ]
  for (const [name, html, rule] of cases) {
    test(name, () => expect(floorRules(html)).toContain(rule))
  }
  test('CSS: @IMPORT, image-set strings and escaped url( are checked', () => {
    expect(floorRules('<p>x</p>', '@IMPORT "x.css";')).toContain('absolute-url')
    expect(
      floorRules('<p>x</p>', 'a{background-image:image-set("https://e.x/a.png" 1x)}'),
    ).toContain('absolute-url')
    expect(floorRules('<p>x</p>', 'a{background:u\\72l(https://e.x/a.png)}')).toContain(
      'absolute-url',
    )
  })
  test('relative, fragment, mailto and data: images still pass', () => {
    expect(
      floorRules(
        '<a href="about.html">a</a><a href="#top">b</a><a href="mailto:x@y.z">c</a><a href="https://e.x">d</a><img src="data:image/png;base64,AA" alt="">',
      ),
    ).toEqual([])
  })
  test('guide: font shorthand, font var and colour attributes are checked', () => {
    const errs = (html: string, css = '') =>
      validateDesign({ html, css }, TEST_GUIDE).errors.map((e) => e.rule)
    expect(errs('<p>x</p>', 'p{font:12px Comic Sans MS}')).toContain('font')
    expect(errs('<p>x</p>', 'p{font:bold 12px/1.4 "PT Sans", sans-serif}')).toEqual([])
    expect(errs('<p>x</p>', ':root{--f:Comic Sans MS}p{font-family:var(--f)}')).toContain('font')
    expect(errs('<svg><rect fill="red"/></svg>')).toContain('colour')
    expect(errs('<svg><rect fill="#2b675b"/></svg>')).toEqual([])
  })
})
