// Validates a postMessage from the review shell. Runs in the browser (the app serves it
// transpiled as /message.js) and under bun test. The shell is untrusted: a message can only
// select a section the app already knows about, never approve anything.

export type MessageLike = { origin: string; source: unknown; data: unknown }
export type Expected = {
  previewOrigin: string | null
  /** The shell iframe's contentWindow. */
  shell: unknown
  /** The app's own section list for this revision. */
  sections: ReadonlySet<string>
}
export type MessageVerdict = { ok: true; id: string } | { ok: false; reason: string }

export function validateMessage(event: MessageLike, expected: Expected): MessageVerdict {
  if (!expected.previewOrigin || event.origin !== expected.previewOrigin)
    return { ok: false, reason: 'wrong-origin' }
  if (expected.shell == null || event.source !== expected.shell)
    return { ok: false, reason: 'wrong-source' }
  const data = event.data
  if (typeof data !== 'object' || data === null || Object.getPrototypeOf(data) !== Object.prototype)
    return { ok: false, reason: 'bad-shape' }
  const keys = Object.keys(data).sort()
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'type')
    return { ok: false, reason: 'bad-shape' }
  const { type, id } = data as Record<string, unknown>
  if (type !== 'section-click' || typeof id !== 'string') return { ok: false, reason: 'bad-shape' }
  if (!expected.sections.has(id)) return { ok: false, reason: 'unknown-section' }
  return { ok: true, id }
}
