// What happens when a signing request has all its signatures, and when production's outbox says
// how it went. App-side effects (the rule, key status) count when the request is delivered (a key
// removal already once it is signed): its signatures already meet the current rule. Production's
// outbox is untrusted, so an `ok` result there only moves what is shown; it never lowers the rule
// or approves a key (#48).
import { audit } from '../governance/audit.ts'
import { markKeyRemoved, markKeysApproved } from '../governance/keys.ts'
import { currentPolicy, type Policy, samePolicy, setPolicy } from '../governance/policy.ts'
import { type MailDeps, mailAdmins } from '../mail/send.ts'
import type { MailMessage } from '../mail/templates.ts'
import type { StoreContext } from '../store/revisions.ts'
import { deliverCommand } from './commands.ts'
import { notify } from './inbox.ts'
import { deliverRelease, requestRef } from './release.ts'
import { type Fail, getSigning, type SigningRow, setStatus, type WebAuthnDeps } from './signing.ts'

type Effect =
  | { type: 'policy'; from: Policy; to: Policy }
  | { type: 'key-add'; keyId: string; adminId: string }
  | { type: 'key-remove'; keyId: string; adminId: string }
  | { type: 'release'; requestId: number }
  | { type?: undefined }

const effectOf = (row: SigningRow) => JSON.parse(row.effect) as Effect

/** Refusal codes production may write (trust.ts and apps/agent). Anything else shows as "other". */
export const KNOWN_CODES = new Set([
  'malformed',
  'bad-type',
  'challenge-mismatch',
  'origin-mismatch',
  'cross-origin',
  'rpid-mismatch',
  'user-not-present',
  'user-not-verified',
  'unsupported-alg',
  'bad-signature',
  'counter-regressed',
  'wrong-target',
  'replayed',
  'expired',
  'too-long-lived',
  'frozen',
  'no-trusted-keys',
  'already-paired',
  'fingerprint-not-confirmed',
  'hash-mismatch',
  'manifest-mismatch',
  'release-number-not-higher',
  'number-jump',
  'unknown-release',
  'unknown-key',
  'revoked-key',
  'needs-key-owner',
  'duplicate-signer',
  'not-enough-signers',
  'passkey-required',
  'bad-app-signature',
  'duplicate-key',
  'would-remove-all-keys',
  'too-few-admins',
  'unknown-command',
  'not-kept',
  'wrong-site',
  'bad-bundle',
  'package-hash-mismatch',
  'too-large',
  'unknown-file',
  'error',
])

/** Codes after which signing again (a new number, fresh assertions) is the way forward (#30). */
export const RE_SIGN_CODES = new Set([
  'counter-regressed',
  'replayed',
  'release-number-not-higher',
  'expired',
  'too-long-lived',
])

export const knownCode = (code: string | undefined) =>
  code && KNOWN_CODES.has(code) ? code : 'other'

// Mail settings per app (the app's address for page links), set when the routes are mounted.
const mailers = new WeakMap<object, MailDeps>()
export function useMail(ctx: Pick<StoreContext, 'db'>, deps: MailDeps) {
  mailers.set(ctx.db, deps)
}

/** Mails every Admin in the background; a mail failure never changes an outcome (mail_log has it). */
function mail(ctx: StoreContext, message: MailMessage) {
  const deps = mailers.get(ctx.db)
  if (deps) void mailAdmins(ctx, deps, message).catch(() => {})
}

/** A new Admin key is trusted: every Admin hears about it, in the app and by mail. */
function keyAdded(ctx: StoreContext, row: SigningRow, e: { keyId: string; adminId: string }) {
  notify(ctx, 'admin-key-added', `key:${e.keyId}`, `A new passkey for ${e.adminId} was approved`)
  mail(ctx, { kind: 'admin-key-added', admin: e.adminId, by: row.created_by })
}

/**
 * Applies what a complete signing request changes in the app: at once for an app-only one, on
 * delivery for a command (a key removal: once signed, before delivery). The signatures already
 * meet the current rule (checked when each was added), so a lowering or a key approval counts
 * from here; production's outbox result is shown, never acted on (#48: the outbox is untrusted).
 */
function applySigned(ctx: StoreContext, row: SigningRow, appOnly: boolean) {
  const e = effectOf(row)
  if (e.type === 'policy') {
    const now = currentPolicy(ctx)
    if (!samePolicy(now, e.from)) return false
    setPolicy(ctx, e.to, row.created_by, `signing ${row.id}`, row.id)
  } else if (e.type === 'key-remove') {
    if (markKeyRemoved(ctx, e.keyId))
      audit(ctx, row.created_by, 'key-removed', {
        keyId: e.keyId,
        adminId: e.adminId,
        signing: row.id,
      })
  } else if (e.type === 'key-add') {
    markKeysApproved(ctx, [e.keyId])
    audit(ctx, row.created_by, 'key-approved', {
      keyId: e.keyId,
      adminId: e.adminId,
      signing: row.id,
    })
    keyAdded(ctx, row, e)
  }
  return true
}

/** Production says it accepted something: shown (status, notifications), never a rule or key change. */
function applyAccepted(ctx: StoreContext, row: SigningRow) {
  const e = effectOf(row)
  if (e.type === 'release') {
    ctx.db
      .query(
        "update publication_requests set status = 'published' where id = ? and status = 'open'",
      )
      .run(e.requestId)
    if (row.target && row.number !== null) {
      notify(
        ctx,
        'release-accepted',
        requestRef(e.requestId),
        `Release ${row.number} is live on ${row.target}`,
      )
      mail(ctx, { kind: 'release-accepted', target: row.target, release: row.number })
    }
  }
}

/** After a signature: once the request is complete, deliver it (or apply it, app-only). */
export async function afterSignature(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  id: number,
  who: string,
): Promise<{ ok: true; delivered: boolean } | Fail> {
  const row = getSigning(ctx, id)
  if (!row) return { ok: false, status: 404, code: 'not-found' }
  if (row.status !== 'signed') return { ok: true, delivered: false }
  if (row.kind === 'app-only') {
    if (!applySigned(ctx, row, true)) {
      setStatus(ctx, row.id, 'stale', { outcome: 'rule-changed' })
      return { ok: false, status: 409, code: 'needs-re-signing' }
    }
    setStatus(ctx, row.id, 'done', { done: true })
    audit(ctx, who, `${row.purpose}-done`, { signing: row.id })
    return { ok: true, delivered: false }
  }
  if (row.kind === 'release') {
    const r = await deliverRelease(ctx, deps, row, who)
    return r.ok ? { ok: true, delivered: true } : r
  }
  if (
    effectOf(row).type === 'policy' &&
    !samePolicy(currentPolicy(ctx), (effectOf(row) as { from: Policy }).from)
  ) {
    setStatus(ctx, row.id, 'stale', { outcome: 'rule-changed' })
    return { ok: false, status: 409, code: 'needs-re-signing' }
  }
  // A removal counts in the app as soon as it is signed, so a failed upload never leaves the
  // removed key signing or counting here. Production drops it when the command arrives.
  const removal = effectOf(row).type === 'key-remove'
  if (removal) applySigned(ctx, row, false)
  const r = await deliverCommand(ctx, deps, row, who)
  if (!r.ok) return r
  if (!removal) applySigned(ctx, getSigning(ctx, id) as SigningRow, false)
  return { ok: true, delivered: true }
}

/** results/<name> from production's outbox, for something this app sent. */
export function onResult(
  ctx: StoreContext,
  target: string,
  name: string,
  ok: boolean,
  code?: string,
) {
  const release = /^release-([1-9][0-9]{0,15})\.json$/.exec(name)
  const command = /^cmd-([1-9][0-9]{0,15})\.json$/.exec(name)
  const kind = release ? 'release' : command ? 'command' : null
  const n = Number((release ?? command)?.[1])
  if (!kind || !Number.isSafeInteger(n)) return
  // Only the first answer to something this app sent counts. A later result under the same name
  // is a re-upload into the inbox that the app did not make (a replay, say): it never changes
  // what happened, but the Admins are told about a refusal.
  const row = ctx.db
    .query(
      "select * from signing_requests where target = ? and kind = ? and number = ? and status = 'sent' order by id desc limit 1",
    )
    .get(target, kind, n) as SigningRow | null
  if (!row) {
    if (!ok)
      notify(
        ctx,
        'outbox-refusal',
        `${target}:${name}`,
        `Production refused ${name}, which this app did not send (${knownCode(code)})`,
      )
    return
  }
  const status = ok ? 'accepted' : 'refused'
  const outcome = ok ? 'accepted' : knownCode(code)
  setStatus(ctx, row.id, status, { outcome, done: true })
  audit(ctx, 'production', `${row.purpose}-${status}`, { target, number: n, code: outcome })
  if (ok) {
    applyAccepted(ctx, row)
    return
  }
  // A key that production never had is already gone there: nothing to fix.
  if (row.purpose === 'key-remove' && outcome === 'unknown-key') return
  const title =
    kind === 'release'
      ? `Production refused release ${n} (${outcome})`
      : `Production refused ${row.purpose} command ${n} (${outcome})`
  const ref =
    kind === 'release'
      ? requestRef((effectOf(row) as { requestId: number }).requestId)
      : `${target}:cmd-${n}`
  notify(ctx, kind === 'release' ? 'release-refused' : 'command-refused', ref, title)
  if (kind === 'release') mail(ctx, { kind: 'release-refused', target, release: n, code: outcome })
}

/** smoke/<n>.json: kept with the release it belongs to. */
export function onSmoke(
  ctx: StoreContext,
  target: string,
  release: number,
  smoke: { passed: boolean; switchedBack: boolean; outcome: string; activeAfter: number | null },
) {
  const row = ctx.db
    .query(
      "select * from signing_requests where target = ? and kind = 'release' and number = ? order by id desc limit 1",
    )
    .get(target, release) as SigningRow | null
  if (!row) return
  ctx.db
    .query('update signing_requests set smoke = ? where id = ?')
    .run(JSON.stringify(smoke), row.id)
  audit(ctx, 'production', 'smoke-test', { target, release, ...smoke })
}
