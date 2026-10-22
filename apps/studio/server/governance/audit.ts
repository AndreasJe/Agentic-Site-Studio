// The audit log (plan §16.4 security floor; permission-cases.md "The audit log is always on and the
// app can't delete from it"). Append-only: the database refuses updates and deletes by trigger.
import type { StoreContext } from '../store/revisions.ts'

export type AuditEntry = { id: number; at: string; who: string; action: string; detail: unknown }

export function audit(
  ctx: Pick<StoreContext, 'db'>,
  who: string,
  action: string,
  detail: Record<string, unknown> = {},
): void {
  ctx.db
    .query('insert into audit_log (at, who, action, detail) values (?, ?, ?, ?)')
    .run(new Date().toISOString(), who, action, JSON.stringify(detail))
}

export function recentAudit(ctx: Pick<StoreContext, 'db'>, limit = 200): AuditEntry[] {
  const rows = ctx.db
    .query('select id, at, who, action, detail from audit_log order by id desc limit ?')
    .all(Math.max(1, Math.min(1000, limit))) as {
    id: number
    at: string
    who: string
    action: string
    detail: string
  }[]
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown }))
}
