// Inbox commands (decisions #1, #24–#26, #29, #33, #35; contracts/command.schema.json). Every
// command takes the next number from the one counter per target and expires within 24 hours.
// freeze (and cert, csr) are signed by the app's key alone; unfreeze, activate, trust-keys and
// remove-key need Admin passkeys over `commandChallenge(cmd)`.
import { commandChallenge } from '@site-studio/shared/release'
import { audit } from '../governance/audit.ts'
import type { StoreContext } from '../store/revisions.ts'
import { TransportError } from '../transport/types.ts'
import { signAppCommand } from './keys.ts'
import {
  createSigning,
  type Fail,
  highestSent,
  markOlderStale,
  passkeySignatures,
  type SigningRow,
  setStatus,
  type WebAuthnDeps,
} from './signing.ts'
import { nextSequence, transportOf } from './targets.ts'

/** Decisions #29 and #35: at most 24 hours; a minute less, for the clocks. */
export const COMMAND_LIFETIME_MS = 24 * 3600_000 - 60_000

export type CommandName =
  | 'freeze'
  | 'unfreeze'
  | 'activate'
  | 'trust-keys'
  | 'remove-key'
  | 'cert'
  | 'csr'
export const APP_SIGNED: CommandName[] = ['freeze', 'cert', 'csr']
export const PASSKEY_SIGNED: CommandName[] = ['unfreeze', 'activate', 'trust-keys', 'remove-key']

const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString()

/** The unsigned command: the exact object the challenge is computed over. */
export function buildCommand(
  ctx: StoreContext,
  deps: Pick<WebAuthnDeps, 'now'>,
  target: string,
  command: CommandName,
  args?: Record<string, unknown>,
) {
  const sequence = nextSequence(ctx, target)
  return {
    command,
    target,
    sequence,
    expires: iso(deps.now() + COMMAND_LIFETIME_MS),
    ...(args ? { args } : {}),
  }
}

export const commandFileName = (sequence: number) => `cmd-${sequence}.json`

/**
 * A command production accepts on the app's signature alone. Sent at once; any older command
 * still waiting for signatures has to be signed again (#26).
 */
export async function sendAppCommand(
  ctx: StoreContext,
  deps: Pick<WebAuthnDeps, 'now'>,
  target: string,
  command: 'freeze' | 'cert' | 'csr',
  who: string,
  args?: Record<string, unknown>,
): Promise<{ ok: true; sequence: number; id: number } | Fail> {
  const t = transportOf(ctx, target)
  if (!t) return { ok: false, status: 409, code: 'not-paired' }
  const unsigned = buildCommand(ctx, deps, target, command, args)
  const signed = await signAppCommand(ctx.dataDir, unsigned)
  const row = createSigning(ctx, {
    kind: 'command',
    purpose: command,
    target,
    ref: `target:${target}`,
    body: unsigned,
    challenge: await commandChallenge(unsigned),
    needed: 0,
    number: unsigned.sequence,
    createdBy: who,
    expiresAt: Date.parse(unsigned.expires),
    status: 'signed',
  })
  try {
    await t.putInbox(
      commandFileName(unsigned.sequence),
      new TextEncoder().encode(JSON.stringify(signed)),
    )
  } catch (e) {
    setStatus(ctx, row.id, 'refused', { outcome: 'transport-failed', done: true })
    return {
      ok: false,
      status: 502,
      code: e instanceof TransportError ? `transport-${e.code}` : 'transport-failed',
    }
  }
  setStatus(ctx, row.id, 'sent', { sent: true })
  markOlderStale(ctx, target, 'command', unsigned.sequence)
  audit(ctx, who, `command-${command}`, { target, sequence: unsigned.sequence, signedBy: 'app' })
  return { ok: true, sequence: unsigned.sequence, id: row.id }
}

/** A command that waits for `needed` Admins' passkeys (and the owner's, for an own key, #28). */
export async function createPasskeyCommand(
  ctx: StoreContext,
  deps: Pick<WebAuthnDeps, 'now'>,
  input: {
    target: string
    command: 'unfreeze' | 'activate' | 'trust-keys' | 'remove-key'
    args?: Record<string, unknown>
    purpose: string
    ref: string
    needed: number
    owner?: string | null
    effect?: Record<string, unknown>
    who: string
  },
): Promise<SigningRow> {
  const unsigned = buildCommand(ctx, deps, input.target, input.command, input.args)
  return createSigning(ctx, {
    kind: 'command',
    purpose: input.purpose,
    target: input.target,
    ref: input.ref,
    body: unsigned,
    challenge: await commandChallenge(unsigned),
    needed: input.needed,
    owner: input.owner ?? null,
    number: unsigned.sequence,
    effect: input.effect,
    createdBy: input.who,
    expiresAt: Date.parse(unsigned.expires),
  })
}

/** Writes a fully signed passkey command to the inbox. */
export async function deliverCommand(
  ctx: StoreContext,
  deps: Pick<WebAuthnDeps, 'now'>,
  row: SigningRow,
  who: string,
): Promise<{ ok: true } | Fail> {
  if (row.kind !== 'command' || !row.target || row.number === null)
    return { ok: false, status: 409, code: 'not-a-command' }
  if (row.status !== 'signed') return { ok: false, status: 409, code: 'not-signed' }
  if (row.expires_at <= deps.now()) {
    setStatus(ctx, row.id, 'stale', { outcome: 'expired' })
    return { ok: false, status: 409, code: 'needs-re-signing' }
  }
  if (row.number <= highestSent(ctx, row.target, 'command')) {
    setStatus(ctx, row.id, 'stale', { outcome: 'overtaken' })
    return { ok: false, status: 409, code: 'needs-re-signing' }
  }
  const t = transportOf(ctx, row.target)
  if (!t) return { ok: false, status: 409, code: 'not-paired' }
  const signed = {
    ...(JSON.parse(row.body) as Record<string, unknown>),
    signatures: passkeySignatures(ctx, row.id).map((s) => ({ by: 'admin-passkey', ...s })),
  }
  try {
    await t.putInbox(commandFileName(row.number), new TextEncoder().encode(JSON.stringify(signed)))
  } catch (e) {
    return {
      ok: false,
      status: 502,
      code: e instanceof TransportError ? `transport-${e.code}` : 'transport-failed',
    }
  }
  setStatus(ctx, row.id, 'sent', { sent: true })
  markOlderStale(ctx, row.target, 'command', row.number)
  audit(ctx, who, `command-${row.purpose}`, {
    target: row.target,
    sequence: row.number,
    signedBy: passkeySignatures(ctx, row.id).length,
  })
  return { ok: true }
}
