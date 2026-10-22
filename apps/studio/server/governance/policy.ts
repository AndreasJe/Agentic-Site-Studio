// The two-person rule (plan §13.9, §16.3–§16.4; decisions #28; M7.4): how many different Admins
// must sign each kind of production action. Production enforces its own copy, signed into its key
// chain; the app keeps the same numbers so it asks for the right number of signatures.
import type { Policy } from '@site-studio/shared/release'
import type { StoreContext } from '../store/revisions.ts'
import { audit } from './audit.ts'

export type { Policy }
export type PolicyPart = keyof Policy

export const POLICY_PARTS: PolicyPart[] = ['releases', 'keys', 'domains']
const KEY = 'two_person_rule'

/** Plan §16.4 presets, narrowed to the rule (M7.4). Small team is the default. */
export const PRESETS: Record<'small-team' | 'standard' | 'strict', Policy> = {
  'small-team': { releases: 1, keys: 1, domains: 1 },
  // Two Admins for new keys and for domains and mail, so everyday releases don't wait (§13.9).
  standard: { releases: 1, keys: 2, domains: 2 },
  strict: { releases: 2, keys: 2, domains: 2 },
}
export type PresetName = keyof typeof PRESETS
export const DEFAULT_POLICY: Policy = PRESETS['small-team']

export const strictest = (p: Policy): 1 | 2 => Math.max(p.releases, p.keys, p.domains) as 1 | 2
export const samePolicy = (a: Policy, b: Policy) => POLICY_PARTS.every((k) => a[k] === b[k])

export function parsePolicy(v: unknown): Policy | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).some((k) => !POLICY_PARTS.includes(k as PolicyPart))) return null
  const out = { ...DEFAULT_POLICY }
  for (const k of POLICY_PARTS) {
    const n = o[k]
    if (n !== 1 && n !== 2) return null
    out[k] = n
  }
  return out
}

export function currentPolicy(ctx: Pick<StoreContext, 'db'>): Policy {
  const row = ctx.db.query('select value from settings where key = ?').get(KEY) as {
    value: string
  } | null
  if (!row) return { ...DEFAULT_POLICY }
  try {
    return parsePolicy(JSON.parse(row.value)) ?? { ...DEFAULT_POLICY }
  } catch {
    return { ...DEFAULT_POLICY }
  }
}

export function presetOf(p: Policy): PresetName | 'custom' {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (samePolicy(p, preset)) return name as PresetName
  }
  return 'custom'
}

/**
 * Only callers that already hold the signatures the current rule needs. Audited. Every other
 * request still waiting for signatures was counted under the old rule, so it has to be signed
 * again under the new one (`except`: the change being applied).
 */
export function setPolicy(
  ctx: Pick<StoreContext, 'db'>,
  to: Policy,
  who: string,
  why: string,
  except?: number,
) {
  const from = currentPolicy(ctx)
  ctx.db.transaction(() => {
    ctx.db
      .query(
        "update signing_requests set status = 'stale', outcome = 'rule-changed' where status in ('open', 'signed') and id <> ?",
      )
      .run(except ?? 0)
    ctx.db
      .query(
        'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
      )
      .run(KEY, JSON.stringify(to))
    audit(ctx, who, 'policy-changed', { from, to, why })
  })()
}

/**
 * How many different Admins must sign a change from `from` to `to` (plan §13.9): the current key
 * rule, and for every part that is lowered, that part's current number. Raising needs the key rule.
 * The same rule production applies in trust.ts.
 */
export function neededToChange(from: Policy, to: Policy): 1 | 2 {
  let needed: number = from.keys
  for (const k of POLICY_PARTS) if (to[k] < from[k]) needed = Math.max(needed, from[k])
  return needed as 1 | 2
}

export const isRaiseOnly = (from: Policy, to: Policy) => POLICY_PARTS.every((k) => to[k] >= from[k])
