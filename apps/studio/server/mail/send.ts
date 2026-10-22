// Sending (plan §13.7): nodemailer over SMTP with the saved settings. Email is optional: without
// settings nothing is sent and callers carry on (the in-app inbox is the floor). Every attempt is
// in mail_log, the audit trail.
import { createTransport } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { notify } from '../release/inbox.ts'
import type { StoreContext } from '../store/revisions.ts'
import { getAccessToken, type TokenDeps, TokenError } from './oauth.ts'
import { getMailCredentials } from './settings.ts'
import { type Lang, type MailMessage, renderMail } from './templates.ts'

export type MailResult =
  | { ok: true; to: string }
  | { ok: false; to: string; reason: 'not-configured' | 'no-address' | 'failed'; error?: string }

export type MailDeps = {
  appOrigin: string
  timeoutMs?: number
  /** Microsoft 365: the token endpoint, and (tests only) a different SMTP server in its place. */
  m365?: TokenDeps & {
    smtp?: { host: string; port: number; security: 'starttls' | 'tls' | 'none' }
  }
}

function log(ctx: StoreContext, to: string, kind: string, ok: boolean, error?: string) {
  ctx.db
    .query('insert into mail_log (at, recipient, kind, ok, error) values (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), to, kind, ok ? 1 : 0, error?.slice(0, 300) ?? null)
}

/** One plain message to one address. Never throws. */
export async function sendMail(
  ctx: StoreContext,
  deps: MailDeps,
  to: string,
  kind: string,
  content: { subject: string; text: string; html?: string },
): Promise<MailResult> {
  const s = getMailCredentials(ctx)
  if (!s) return { ok: false, to, reason: 'not-configured' }
  const timeout = deps.timeoutMs ?? 10_000
  let route = { host: s.host, port: s.port, security: s.security }
  let auth: SMTPTransport.Options['auth'] = s.user ? { user: s.user, pass: s.password } : undefined
  try {
    if (s.transport === 'm365') {
      const accessToken = await getAccessToken(
        { tenantId: s.tenantId ?? '', clientId: s.clientId ?? '', clientSecret: s.clientSecret },
        { timeoutMs: timeout, ...deps.m365 },
      )
      auth = { type: 'OAuth2', user: s.user, accessToken }
      route = deps.m365?.smtp ?? route
    }
  } catch (e) {
    const error = e instanceof TokenError ? e.message : 'Could not get a Microsoft 365 token.'
    log(ctx, to, kind, false, error)
    return { ok: false, to, reason: 'failed', error }
  }
  const transport = createTransport({
    host: route.host,
    port: route.port,
    secure: route.security === 'tls',
    requireTLS: route.security === 'starttls',
    ignoreTLS: route.security === 'none',
    auth,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  })
  try {
    await transport.sendMail({
      from: s.fromName ? { name: s.fromName, address: s.from } : s.from,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    })
    log(ctx, to, kind, true)
    return { ok: true, to }
  } catch (e) {
    const error = (e as Error).message
    log(ctx, to, kind, false, error)
    return { ok: false, to, reason: 'failed', error }
  } finally {
    transport.close()
  }
}

export type Person = { handle: string; email: string | null; language: Lang }

export function adminsOf(ctx: StoreContext): Person[] {
  return ctx.db
    .query("select handle, email, language from users where role = 'admin' order by id")
    .all() as Person[]
}

export function personOf(ctx: StoreContext, handle: string): Person | null {
  return (
    (ctx.db.query('select handle, email, language from users where handle = ?').get(handle) as
      | Person
      | undefined) ?? null
  )
}

/** A template to one person, in their language. */
export async function mailPerson(
  ctx: StoreContext,
  deps: MailDeps,
  person: Person,
  message: MailMessage,
): Promise<MailResult> {
  if (!person.email) return { ok: false, to: person.handle, reason: 'no-address' }
  const r = renderMail(message, person.language, deps.appOrigin)
  return sendMail(ctx, deps, person.email, message.kind, r)
}

/** A template to every Admin that has an address. */
export async function mailAdmins(
  ctx: StoreContext,
  deps: MailDeps,
  message: MailMessage,
): Promise<MailResult[]> {
  const out: MailResult[] = []
  for (const a of adminsOf(ctx)) out.push(await mailPerson(ctx, deps, a, message))
  return out
}

/**
 * A request was sent back: the Creator who made it gets an inbox item and, if they have an
 * address, an email with the Admin's note and a link to Staging. Never throws.
 */
export async function mailSentBack(
  ctx: StoreContext,
  deps: MailDeps,
  requestId: number,
): Promise<MailResult | null> {
  try {
    const r = ctx.db
      .query(
        `select r.project_id as project, r.closed_note as note, u.handle, u.email, u.language,
                a.name as admin
           from publication_requests r join users u on u.id = r.user_id
           left join users a on a.handle = r.closed_by
          where r.id = ? and r.status = 'sent-back'`,
      )
      .get(requestId) as {
      project: string
      note: string | null
      handle: string
      email: string | null
      language: Lang
      admin: string | null
    } | null
    if (!r) return null
    // The inbox has no recipient column yet: the ref carries the Creator's handle.
    notify(ctx, 'sent-back', `to:${r.handle}:request:${requestId}`, `Sent back: ${r.project}`)
    return await mailPerson(ctx, deps, r, {
      kind: 'sent-back',
      project: r.project,
      by: r.admin ?? '',
      note: r.note ?? undefined,
    })
  } catch {
    return null
  }
}
