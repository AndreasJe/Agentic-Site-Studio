// Sending (plan §13.7): nodemailer over SMTP with the saved settings. Email is optional: without
// settings nothing is sent and callers carry on (the in-app inbox is the floor). Every attempt is
// in mail_log, the audit trail.
import { createTransport } from 'nodemailer'
import type { StoreContext } from '../store/revisions.ts'
import { getMailCredentials } from './settings.ts'
import { type Lang, type MailMessage, renderMail } from './templates.ts'

export type MailResult =
  | { ok: true; to: string }
  | { ok: false; to: string; reason: 'not-configured' | 'no-address' | 'failed'; error?: string }

export type MailDeps = { appOrigin: string; timeoutMs?: number }

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
  const transport = createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
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
