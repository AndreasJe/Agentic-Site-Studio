// What the deployment side shares with the release side (docs/pending/m7-interfaces.md): the
// outbox events and the "Waiting for you" notification.
import { notify as inboxNotify } from '../release/inbox.ts'
import type { StoreContext } from '../store/revisions.ts'

export type { OutboxEvent } from './outbox.ts'

export type Notify = (ctx: StoreContext, kind: string, ref: string, title: string) => void

/** `notify()` of the release side. It never throws into the caller: mail must still go out. */
export const defaultNotify: Notify = (ctx, kind, ref, title) => {
  try {
    inboxNotify(ctx, kind, ref, title)
  } catch {
    // a bad kind or ref is a bug to see in tests, not a reason to lose the mail
  }
}
