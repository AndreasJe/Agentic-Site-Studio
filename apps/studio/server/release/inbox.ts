// "Waiting for you" (plan §13.3 step 5, §13.7; AdminInbox): one list of things for the Admins.
// An item is open until someone marks it done; the same open item is never added twice.
import type { StoreContext } from '../store/revisions.ts'

export type InboxItem = {
  id: number
  kind: string
  ref: string
  title: string
  created_at: string
  done_at: string | null
}

const KIND = /^[a-z][a-z0-9-]{0,39}$/
const REF = /^[A-Za-z0-9:._/-]{1,200}$/

/** Adds an open item, unless the same kind and ref is already open. The title is plain text. */
export function notify(ctx: Pick<StoreContext, 'db'>, kind: string, ref: string, title: string) {
  if (!KIND.test(kind) || !REF.test(ref)) throw new Error('notify: bad kind or ref')
  ctx.db
    .query('insert or ignore into inbox_items (kind, ref, title, created_at) values (?, ?, ?, ?)')
    .run(kind, ref, title.slice(0, 300), new Date().toISOString())
}

export const openItems = (ctx: Pick<StoreContext, 'db'>): InboxItem[] =>
  ctx.db
    .query('select * from inbox_items where done_at is null order by id desc limit 500')
    .all() as InboxItem[]

export function markDone(ctx: Pick<StoreContext, 'db'>, id: number): boolean {
  return (
    ctx.db
      .query('update inbox_items set done_at = ? where id = ? and done_at is null')
      .run(new Date().toISOString(), id).changes === 1
  )
}

/** Closes the open item for this kind and ref, if there is one (the thing was dealt with). */
export function resolve(ctx: Pick<StoreContext, 'db'>, kind: string, ref: string) {
  ctx.db
    .query('update inbox_items set done_at = ? where kind = ? and ref = ? and done_at is null')
    .run(new Date().toISOString(), kind, ref)
}
