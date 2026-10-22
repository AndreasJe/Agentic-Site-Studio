// Changing the two-person rule (plan §13.9, §16.3; M7 Done-when "Lowering the two-person rule
// needs the current rule"). The change is a trust-keys command with only `policy`, signed by as
// many different Admins as the CURRENT rule asks; production checks the same. Before pairing it
// is an app-only change with a step-up challenge, under the same count.
import type { SessionUser } from '../auth/sessions.ts'
import { createPasskeyCommand } from '../release/commands.ts'
import {
  type Fail,
  requestOptions,
  type SigningRow,
  type WebAuthnDeps,
} from '../release/signing.ts'
import type { StoreContext } from '../store/revisions.ts'
import { audit } from './audit.ts'
import { createAppOnlySigning, governanceTarget } from './keys.ts'
import { currentPolicy, neededToChange, type Policy, samePolicy } from './policy.ts'

export const POLICY_REF = 'policy'

export async function startPolicyChange(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  user: SessionUser,
  to: Policy,
) {
  const from = currentPolicy(ctx)
  if (samePolicy(from, to)) return { ok: false, status: 409, code: 'no-change' } as Fail
  // One change at a time: an older open one is replaced, so nobody signs an out-of-date rule.
  ctx.db
    .query(
      "update signing_requests set status = 'cancelled', outcome = 'replaced' where ref = ? and status in ('open', 'signed')",
    )
    .run(POLICY_REF)
  const where = governanceTarget(ctx)
  if ('ok' in where) return where
  const needed = neededToChange(from, to)
  const effect = { type: 'policy', from, to }
  const row: SigningRow = where.target
    ? await createPasskeyCommand(ctx, deps, {
        target: where.target,
        command: 'trust-keys',
        args: { policy: to },
        purpose: 'policy',
        ref: POLICY_REF,
        needed,
        effect,
        who: user.handle,
      })
    : await createAppOnlySigning(ctx, deps, {
        purpose: 'policy',
        ref: POLICY_REF,
        needed,
        effect,
        who: user.handle,
      })
  audit(ctx, user.handle, 'policy-change-started', { from, to, needed, target: where.target })
  return { ok: true as const, row, options: requestOptions(ctx, deps, row, user) }
}
