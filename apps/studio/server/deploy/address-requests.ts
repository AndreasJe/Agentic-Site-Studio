// "Send request now" (decision 22 Oct #7): an address request sent from the new-page screen at
// once, stored outside the Creator's private draft so the Admin sees it before any revision is
// saved. A request saved with a revision still works; the two are merged by name in address.ts.
// The name rules are the M3 rules (checkAddressName), checked again at approval.
import { notify } from '../release/inbox.ts'
import type { StoreContext } from '../store/revisions.ts'
import { checkAddressName, StructureError } from '../structure/structure.ts'

export type SentRequest = {
  project_id: string
  name: string
  page_id: string
  page_title: string | null
  note: string
  by: string
  at: string
}

export class SendRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message)
  }
}

const NOTE_MAX = 1000

export function sentRequests(ctx: Pick<StoreContext, 'db'>, project?: string): SentRequest[] {
  return (
    project
      ? ctx.db.query('select * from address_requests where project_id = ?').all(project)
      : ctx.db.query('select * from address_requests').all()
  ) as SentRequest[]
}

/** Records the request. The caller has checked that the user can see the project and the page. */
export function sendAddressRequest(
  ctx: Pick<StoreContext, 'db'>,
  o: {
    project: string
    name: string
    pageId: string
    pageTitle: string | null
    note: string
    by: string
    at?: string
  },
): SentRequest {
  const note = o.note.trim()
  if (note.length > NOTE_MAX) throw new SendRequestError('note-too-long', 'The note is too long.')
  try {
    checkAddressName(o.name)
  } catch (e) {
    if (e instanceof StructureError) throw new SendRequestError('bad-name', e.message)
    throw e
  }
  const decided = ctx.db
    .query("select status from address_decisions where name = ? and status = 'approved'")
    .get(o.name) as { status: string } | null
  if (decided)
    throw new SendRequestError('name-taken', `The name "${o.name}" is already taken.`, 409)
  const row: SentRequest = {
    project_id: o.project,
    name: o.name,
    page_id: o.pageId,
    page_title: o.pageTitle,
    note,
    by: o.by,
    at: o.at ?? new Date().toISOString(),
  }
  try {
    ctx.db
      .query(
        'insert into address_requests (project_id, name, page_id, page_title, note, by, at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.project_id, row.name, row.page_id, row.page_title, row.note, row.by, row.at)
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message))
      throw new SendRequestError('already-sent', `"${o.name}" has already been sent.`, 409)
    throw e
  }
  notify(ctx, 'address-request', `${o.project}/${o.name}`, `Address request: ${o.name}`)
  return row
}
