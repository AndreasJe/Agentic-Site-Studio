// Admin decisions on address requests (plan §10.4; M3 made the requests). A request lives in the
// Creator's structure.json; saved revisions never change, so the Admin's answer is kept beside
// them in `address_decisions`. The name rules are the M3 rules, checked again at approval, and an
// approved name is reserved across all sites (a name is one subdomain of the live domain).
import type { SessionUser } from '../auth/sessions.ts'
import { audit } from '../governance/audit.ts'
import { resolve as resolveInbox } from '../release/inbox.ts'
import { getBlob } from '../store/blobs.ts'
import { currentRevision, projectDir, readRevision, type StoreContext } from '../store/revisions.ts'
import { checkAddressName, type Structure, StructureError } from '../structure/structure.ts'

export class AddressError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

export type AddressRequestView = {
  /** `<project>/<name>`, what the Admin screen opens. */
  id: string
  project: string
  name: string
  pageId: string
  pageTitle: string | null
  note: string
  by: string
  at: string
  revision: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
  decisionNote: string | null
  decidedAt: string | null
}

type Decision = {
  project_id: string
  name: string
  status: 'approved' | 'rejected'
  note: string
  decided_by: string
  at: string
}

const NOTE_MAX = 1000

async function structureOf(
  ctx: StoreContext,
  project: string,
): Promise<{ s: Structure; rev: string } | null> {
  const rev = currentRevision(ctx.dataDir, project)
  const doc = rev ? readRevision(ctx.dataDir, project, rev) : null
  const hash = doc?.files['structure.json']
  if (!rev || !hash) return null
  try {
    const text = new TextDecoder().decode(await getBlob(projectDir(ctx.dataDir, project), hash))
    return { s: JSON.parse(text) as Structure, rev }
  } catch {
    return null
  }
}

/**
 * Requests from the newest saved revision of each project, with the Admin's answer if there is
 * one. A Creator's private draft is never read: a request is visible once it is in a revision.
 */
export async function listAddressRequests(
  ctx: StoreContext,
  filter: { project?: string; status?: AddressRequestView['status'] } = {},
): Promise<AddressRequestView[]> {
  const projects = (
    filter.project
      ? ctx.db.query('select id from projects where id = ?').all(filter.project)
      : ctx.db.query('select id from projects order by id').all()
  ) as { id: string }[]
  const decisions = new Map<string, Decision>()
  for (const d of ctx.db.query('select * from address_decisions').all() as Decision[])
    decisions.set(`${d.project_id}/${d.name}`, d)
  const out: AddressRequestView[] = []
  for (const { id: project } of projects) {
    const found = await structureOf(ctx, project)
    if (!found) continue
    for (const r of found.s.addressRequests ?? []) {
      if (r.status === 'declined') continue
      const d = decisions.get(`${project}/${r.name}`)
      const view: AddressRequestView = {
        id: `${project}/${r.name}`,
        project,
        name: r.name,
        pageId: r.pageId,
        pageTitle: found.s.pages.find((p) => p.id === r.pageId)?.title ?? null,
        note: r.note,
        by: r.by,
        at: r.at,
        revision: found.rev,
        status: d ? d.status : 'pending',
        decidedBy: d?.decided_by ?? null,
        decisionNote: d?.note ?? null,
        decidedAt: d?.at ?? null,
      }
      if (!filter.status || view.status === filter.status) out.push(view)
    }
  }
  return out
}

/** Approve or reject one request, with a note. Rejecting needs a note; the Creator sees both. */
export async function decideAddress(
  ctx: StoreContext,
  admin: SessionUser,
  project: string,
  name: string,
  decision: 'approve' | 'reject',
  noteInput: unknown,
): Promise<AddressRequestView> {
  const note = typeof noteInput === 'string' ? noteInput.trim() : ''
  if (note.length > NOTE_MAX) throw new AddressError('note-too-long', 'The note is too long.')
  if (decision === 'reject' && !note)
    throw new AddressError('note-required', 'Say why the request is turned down.')

  const req = (await listAddressRequests(ctx, { project })).find((r) => r.name === name)
  if (!req) throw new AddressError('not-found', 'No such address request.', 404)
  if (req.status !== 'pending')
    throw new AddressError('already-decided', 'This request has already been answered.', 409)

  if (decision === 'approve') {
    try {
      // Approval repeats the rules the request was made under.
      checkAddressName(name)
    } catch (e) {
      if (e instanceof StructureError) throw new AddressError('bad-name', e.message)
      throw e
    }
    const taken = ctx.db
      .query("select project_id from address_decisions where name = ? and status = 'approved'")
      .get(name)
    if (taken) throw new AddressError('name-taken', `The name "${name}" is already taken.`, 409)
    const found = await structureOf(ctx, project)
    if (found?.s.roots.some((r) => r.address.split('.')[0] === name))
      throw new AddressError('name-taken', `The name "${name}" is already taken.`, 409)
  }

  try {
    ctx.db
      .query(
        'insert into address_decisions (project_id, name, status, note, decided_by, at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(
        project,
        name,
        decision === 'approve' ? 'approved' : 'rejected',
        note,
        admin.handle,
        new Date().toISOString(),
      )
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message))
      throw new AddressError('name-taken', `The name "${name}" is already taken.`, 409)
    throw e
  }
  audit(ctx, admin.handle, `address-request.${decision === 'approve' ? 'approved' : 'rejected'}`, {
    project,
    name,
  })
  try {
    resolveInbox(ctx, 'address-request', `${project}/${name}`)
  } catch {}
  return (await listAddressRequests(ctx, { project })).find(
    (r) => r.name === name,
  ) as AddressRequestView
}

/** Names reserved for the Deployment tab: approved, and live with the next release. */
export function approvedAddresses(ctx: StoreContext) {
  return (
    ctx.db
      .query(
        "select project_id, name, decided_by, at from address_decisions where status = 'approved' order by name",
      )
      .all() as { project_id: string; name: string; decided_by: string; at: string }[]
  ).map((r) => ({ project: r.project_id, name: r.name, approvedBy: r.decided_by, at: r.at }))
}
