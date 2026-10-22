// Notifications and mail settings (M7.7; plan §13.7), Admin only. The password is write-only:
// it is stored encrypted and no response ever carries it.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { audit } from '../governance/audit.ts'
import { type MailDeps, sendMail } from '../mail/send.ts'
import {
  getMailSettings,
  isEmailAddress,
  MailSettingsError,
  saveMailSettings,
} from '../mail/settings.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

type Body = Record<string, unknown>

export function mailRoutes(app: Hono<AppEnv>, ctx: StoreContext, deps: MailDeps) {
  const adminOnly = (c: Context<AppEnv>): Response | null =>
    c.get('user').role === 'admin' ? null : (c.json({ code: 'forbidden' }, 403) as Response)
  const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Body

  app.use(
    '/api/mail/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  app.get('/api/mail/settings', (c) => adminOnly(c) ?? c.json({ settings: getMailSettings(ctx) }))

  app.put('/api/mail/settings', async (c) => {
    const no = adminOnly(c)
    if (no) return no
    try {
      const settings = saveMailSettings(ctx, await body(c))
      audit(ctx, c.get('user').handle, 'mail-settings.changed', {
        host: settings.host,
        port: settings.port,
        from: settings.from,
      })
      return c.json({ settings })
    } catch (e) {
      if (e instanceof MailSettingsError)
        return c.json({ code: 'bad-settings', message: e.message }, 400)
      throw e
    }
  })

  // "Send test email": to the signed-in Admin's own address, saying nothing else.
  app.post('/api/mail/test', async (c) => {
    const no = adminOnly(c)
    if (no) return no
    const me = ctx.db.query('select email from users where id = ?').get(c.get('user').id) as {
      email: string | null
    } | null
    if (!me?.email)
      return c.json({ code: 'no-address', message: 'Add your own email address first.' }, 409)
    const r = await sendMail(ctx, deps, me.email, 'test', {
      subject: 'Test email',
      text: 'This is a test email from the app. Nothing needs doing.',
    })
    if (!r.ok)
      return c.json({ code: r.reason, message: r.error }, r.reason === 'not-configured' ? 409 : 502)
    return c.json({ ok: true })
  })

  // Addresses: who gets mail. Admin sets them for everyone; each address is an audit entry.
  app.get(
    '/api/mail/addresses',
    (c) =>
      adminOnly(c) ??
      c.json({
        people: ctx.db.query('select handle, name, role, email from users order by id').all(),
      }),
  )

  app.put('/api/mail/addresses/:handle', async (c) => {
    const no = adminOnly(c)
    if (no) return no
    const { email } = await body(c)
    if (email !== null && !isEmailAddress(email))
      return c.json({ code: 'bad-address', message: 'That is not an email address.' }, 400)
    const r = ctx.db
      .query('update users set email = ? where handle = ?')
      .run(email as string | null, c.req.param('handle') ?? '')
    if (r.changes !== 1) return c.json({ code: 'not-found' }, 404)
    audit(ctx, c.get('user').handle, 'mail-address.changed', { handle: c.req.param('handle') })
    return c.json({ ok: true })
  })

  // A person sets their own address (Creators too); the same rules, the same audit entry.
  app.put('/api/mail/me/address', async (c) => {
    const { email } = await body(c)
    if (email !== null && !isEmailAddress(email))
      return c.json({ code: 'bad-address', message: 'That is not an email address.' }, 400)
    ctx.db
      .query('update users set email = ? where id = ?')
      .run(email as string | null, c.get('user').id)
    audit(ctx, c.get('user').handle, 'mail-address.changed', { handle: c.get('user').handle })
    return c.json({ ok: true })
  })

  // The audit trail of every email sent (plan §13.7).
  app.get(
    '/api/mail/log',
    (c) =>
      adminOnly(c) ??
      c.json({
        log: ctx.db
          .query('select at, recipient, kind, ok, error from mail_log order by id desc limit 200')
          .all(),
      }),
  )
}
