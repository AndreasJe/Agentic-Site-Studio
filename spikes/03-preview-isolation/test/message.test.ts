// The app's validator for postMessages from the review shell.
import { expect, test } from 'bun:test'
import { type Expected, validateMessage } from '../src/message.ts'

const PREVIEW = 'http://127.0.0.1:3001'
const shell = {}
const expected: Expected = { previewOrigin: PREVIEW, shell, sections: new Set(['hero', 'faq']) }
const msg = (data: unknown, origin = PREVIEW, source: unknown = shell) =>
  validateMessage({ origin, source, data }, expected)

test('a section click from the shell with a known id is accepted', () => {
  expect(msg({ type: 'section-click', id: 'hero' })).toEqual({ ok: true, id: 'hero' })
})

test('the wrong origin is refused, including the app itself and null', () => {
  for (const origin of ['http://localhost:3000', 'null', 'http://127.0.0.1:3002', ''])
    expect(msg({ type: 'section-click', id: 'hero' }, origin)).toEqual({
      ok: false,
      reason: 'wrong-origin',
    })
  expect(
    validateMessage(
      { origin: PREVIEW, source: shell, data: { type: 'section-click', id: 'hero' } },
      { ...expected, previewOrigin: null },
    ),
  ).toEqual({ ok: false, reason: 'wrong-origin' })
})

test('a source other than the shell window is refused (the package, another window)', () => {
  expect(msg({ type: 'section-click', id: 'hero' }, PREVIEW, {})).toEqual({
    ok: false,
    reason: 'wrong-source',
  })
  expect(msg({ type: 'section-click', id: 'hero' }, PREVIEW, null)).toEqual({
    ok: false,
    reason: 'wrong-source',
  })
  expect(
    validateMessage(
      { origin: PREVIEW, source: null, data: { type: 'section-click', id: 'hero' } },
      { ...expected, shell: null },
    ),
  ).toEqual({ ok: false, reason: 'wrong-source' })
})

test('any other shape is refused', () => {
  for (const data of [
    { type: 'approve', id: 'hero' },
    { type: 'section-click' },
    { type: 'section-click', id: 1 },
    { type: 'section-click', id: 'hero', approved: true },
    { id: 'hero' },
    ['section-click', 'hero'],
    'section-click:hero',
    null,
    undefined,
    Object.assign(Object.create(null), { type: 'section-click', id: 'hero' }),
  ])
    expect(msg(data)).toEqual({ ok: false, reason: 'bad-shape' })
})

test("an id that isn't in the app's own section list is refused", () => {
  for (const id of ['footer', '', 'HERO', '__proto__', 'hero '])
    expect(msg({ type: 'section-click', id })).toEqual({ ok: false, reason: 'unknown-section' })
})
