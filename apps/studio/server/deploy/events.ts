// What the deployment side does when the outbox poller reports something new (m7-interfaces.md).
// Production's outbox is untrusted: only known fields are read, and nothing from it is shown
// beyond a number and a boolean.
import { mailAdmins } from '../mail/send.ts'
import { type CertDeps, handleCsr } from './certs.ts'
import { defaultNotify, type OutboxEvent } from './hooks.ts'

export async function onOutboxEvent(deps: CertDeps, e: OutboxEvent): Promise<void> {
  const notify = deps.notify ?? defaultNotify
  if (e.kind === 'csr') {
    await handleCsr(deps, e)
    return
  }
  if (e.kind === 'smoke' && (!e.ok || e.switchedBack)) {
    // A failed smoke test: production switched back by itself (or, with nothing to go back to,
    // went offline). Either way every Admin hears about it, in the app and by mail.
    const release = Number.isSafeInteger(e.release) ? e.release : 0
    notify(
      deps.ctx,
      'smoke-failed',
      `${e.target}:${release}`,
      e.switchedBack
        ? `Release ${release} failed its smoke test and ${e.target} switched back`
        : `Release ${release} failed its smoke test and ${e.target} is offline`,
    )
    if (deps.mail) {
      await mailAdmins(deps.ctx, deps.mail, {
        kind: 'smoke-switched-back',
        target: e.target,
        release,
        switchedBack: e.switchedBack === true,
      })
    }
  }
}

/**
 * Wires the handler to the poller: `registerDeployHooks(onOutbox, deps)`, where `onOutbox` is
 * the subscriber function of `server/deploy/outbox.ts`.
 */
export function registerDeployHooks(
  onOutbox: (fn: (e: OutboxEvent) => void | Promise<void>) => void,
  deps: CertDeps,
): void {
  onOutbox((e) => onOutboxEvent(deps, e))
}
