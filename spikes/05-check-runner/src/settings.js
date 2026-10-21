// Off / Warn / Block per check (plan 16.5). Default: everything Block.
// The security floor is locked on Block: a lower setting is ignored and reported.

export const CHECKS = [
  'html',
  'links',
  'inline-code',
  'csp',
  'axe',
  'heavy-profile',
  'screenshots',
  'performance',
]

// 16.5 names HTML and link checks as floor too; inline code and CSP violations per rule 10.
export const FLOOR = new Set(['html', 'links', 'inline-code', 'csp'])

export const LEVELS = ['off', 'warn', 'block']

export function resolveSettings(settings = {}) {
  const wanted = settings.checks ?? {}
  const out = {}
  for (const id of CHECKS) {
    const configured = LEVELS.includes(wanted[id]) ? wanted[id] : 'block'
    if (FLOOR.has(id) && configured !== 'block') {
      out[id] = { configured, effective: 'block', note: "can't be lowered (security floor)" }
    } else {
      out[id] = { configured, effective: configured }
    }
  }
  return out
}
