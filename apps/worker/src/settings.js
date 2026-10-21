// Off / Warn / Block per check (plan 16.5). Default: everything Block.
// The security floor is locked on Block: a lower setting is ignored and reported.

export const FLOOR_CHECKS = [
  'html',
  'links',
  'csp',
  'inline-code',
  'validators',
  'svg',
  'pinned',
  'secrets',
]
export const ADVISORY_CHECKS = [
  'axe',
  'heavy-profile',
  'csp-console',
  'visual',
  'navigation',
  'seo',
  'performance',
]
export const SMOKE_CHECKS = ['smoke']

export const FLOOR = new Set(FLOOR_CHECKS)
export const LEVELS = ['off', 'warn', 'block']
export const LOWERED = "can't be lowered"

/** { floor, level, lowered } for one check; a missing or unknown setting means block. */
export function resolveLevel(id, settings = {}) {
  const configured = LEVELS.includes(settings?.[id]) ? settings[id] : 'block'
  const floor = FLOOR.has(id)
  if (floor && configured !== 'block') return { floor, level: 'block', lowered: LOWERED }
  return { floor, level: configured, lowered: null }
}
