// Two roles (plan §16.2). Admin-only capabilities are declared here, and every Admin route must
// pass through requireCapability, so a Creator can't reach one by accident (permission-cases.md).
import type { MiddlewareHandler } from 'hono'

export type Role = 'admin' | 'creator'

export const ADMIN_CAPABILITIES = [
  'publish',
  'deployment',
  'backups',
  'mail',
  'users',
  'models',
  'kill-switch',
  'governance',
] as const
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number]

export function requireCapability(
  capability: AdminCapability,
): MiddlewareHandler<{ Variables: { user: { role: Role } } }> {
  return async (c, next) => {
    const user = c.get('user')
    if (user?.role !== 'admin') return c.json({ code: 'forbidden', capability }, 403)
    await next()
  }
}
