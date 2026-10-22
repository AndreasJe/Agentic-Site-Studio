// Production targets as the release side sees them. Pairing (server/deploy/pairing.ts) owns the
// deploy_targets rows, their transport and the one command counter per target (#26); this file
// adds the release counter in the same row, so a re-paired host starts after both (#34).
import { allocateSequence, getTarget, listTargets, transportFor } from '../deploy/pairing.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { Transport } from '../transport/types.ts'

/** The one target the release flow sends to until several are configured (plan §13.4). */
export const PRODUCTION = 'production'

export const targetExists = (ctx: StoreContext, target: string) => getTarget(ctx, target) !== null

/** Paired (or sent the pairing file): a transport the app writes the inbox with. */
export const transportOf = (ctx: StoreContext, target: string): Transport | null =>
  transportFor(ctx, target)

export const pairedTargets = (ctx: StoreContext): string[] =>
  listTargets(ctx)
    .map((t) => t.target)
    .filter((t) => transportFor(ctx, t) !== null)

export const nextSequence = (ctx: StoreContext, target: string): number =>
  allocateSequence(ctx, target)

/** The next release number for a target: higher than any before, never reused (#6, #23). */
export function nextReleaseNumber(ctx: StoreContext, target: string): number {
  const row = ctx.db
    .query(
      'update deploy_targets set last_release = last_release + 1 where target = ? returning last_release',
    )
    .get(target) as { last_release: number } | null
  if (!row) throw new Error(`No target called ${target}`)
  return row.last_release
}
