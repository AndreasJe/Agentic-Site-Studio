// Project settings (plan §16.6), read where they are enforced: structure changes, release signing
// and the check job. Stricter than the install, never looser. The Admin screen writes them in
// server/app/setup.ts; this module only reads, so the check and release code can import it.
import type { Policy } from '@site-studio/shared/release'
import type { StoreContext } from '../store/revisions.ts'
import { currentPolicy } from './policy.ts'

export type ProjectSettings = {
  structureNeedsAdmin: boolean
  // Stricter than the install, never looser (§16.6). Absent means "the install's rule".
  twoPerson: Partial<Record<'releases' | 'keys' | 'domains', 1 | 2>>
  checks: Record<string, 'warn' | 'block'>
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  structureNeedsAdmin: false,
  twoPerson: {},
  checks: {},
}

export const projectSettingsKey = (project: string) => `project.${project}.settings`

export function readProjectSettings(
  ctx: Pick<StoreContext, 'db'>,
  project: string,
): ProjectSettings {
  const r = ctx.db
    .query('select value from settings where key = ?')
    .get(projectSettingsKey(project)) as { value: string } | null
  try {
    return { ...DEFAULT_PROJECT_SETTINGS, ...(r ? JSON.parse(r.value) : {}) }
  } catch {
    return { ...DEFAULT_PROJECT_SETTINGS }
  }
}

/** The install's two-person rule, raised by this project's own rule where it is stricter. */
export function effectivePolicy(ctx: Pick<StoreContext, 'db'>, project: string): Policy {
  const install = currentPolicy(ctx)
  const own = readProjectSettings(ctx, project).twoPerson
  return {
    releases: Math.max(install.releases, own.releases ?? 1) as 1 | 2,
    keys: Math.max(install.keys, own.keys ?? 1) as 1 | 2,
    domains: Math.max(install.domains, own.domains ?? 1) as 1 | 2,
  }
}

const RANK = { off: 0, warn: 1, block: 2 } as const

/** The stricter of the install's level and the project's level, per check. */
export function stricterLevels<L extends string>(
  install: Record<string, L>,
  own: Record<string, string>,
): Record<string, L> {
  const out: Record<string, L> = { ...install }
  for (const [id, lvl] of Object.entries(own)) {
    const base = (install[id] ?? 'block') as keyof typeof RANK
    if ((RANK[lvl as keyof typeof RANK] ?? 0) > (RANK[base] ?? 0)) out[id] = lvl as L
  }
  return out
}
