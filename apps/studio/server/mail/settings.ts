// SMTP settings (plan §13.7). Host, port, security, user and sender live in the settings table;
// the password is encrypted (AES-256-GCM, key file in DATA_DIR/keys) and never returned.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreContext } from '../store/revisions.ts'

export type MailSecurity = 'starttls' | 'tls' | 'none'
export type MailSettings = {
  host: string
  port: number
  security: MailSecurity
  user: string
  from: string
  fromName: string
}
/** What the API returns: never the password, only whether one is set. */
export type MailSettingsPublic = MailSettings & { passwordSet: boolean }

export class MailSettingsError extends Error {}

const KEY = 'mail.smtp'
const PASSWORD_KEY = 'mail.password'
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9a-fA-F:.]+\]$/
const ADDRESS = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

export const isEmailAddress = (v: unknown): v is string => typeof v === 'string' && ADDRESS.test(v)

function boxKey(dataDir: string): Buffer {
  const dir = join(dataDir, 'keys')
  const file = join(dir, 'secret-box.key')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(file, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    try {
      chmodSync(file, 0o600)
    } catch {}
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
}

export function seal(dataDir: string, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', boxKey(dataDir), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [
    'v1',
    iv.toString('base64'),
    ct.toString('base64'),
    c.getAuthTag().toString('base64'),
  ].join(':')
}

export function unseal(dataDir: string, sealed: string): string {
  const [v, iv, ct, tag] = sealed.split(':')
  if (v !== 'v1' || !iv || !ct || !tag) throw new MailSettingsError('stored password is unreadable')
  const d = createDecipheriv('aes-256-gcm', boxKey(dataDir), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

function setting(ctx: StoreContext, key: string): string | null {
  const row = ctx.db.query('select value from settings where key = ?').get(key) as {
    value: string
  } | null
  return row?.value ?? null
}

function put(ctx: StoreContext, key: string, value: string) {
  ctx.db
    .query(
      'insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
    )
    .run(key, value)
}

export function getMailSettings(ctx: StoreContext): MailSettingsPublic | null {
  const raw = setting(ctx, KEY)
  if (!raw) return null
  const s = JSON.parse(raw) as MailSettings
  return { ...s, passwordSet: setting(ctx, PASSWORD_KEY) !== null }
}

/** With the password, for sending only. */
export function getMailCredentials(
  ctx: StoreContext,
): (MailSettings & { password: string }) | null {
  const s = getMailSettings(ctx)
  if (!s) return null
  const { passwordSet, ...rest } = s
  const sealed = setting(ctx, PASSWORD_KEY)
  return { ...rest, password: sealed ? unseal(ctx.dataDir, sealed) : '' }
}

/**
 * `password`: undefined keeps the stored one, null removes it, a string replaces it.
 * Returns the public view.
 */
export function saveMailSettings(
  ctx: StoreContext,
  input: Record<string, unknown>,
): MailSettingsPublic {
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (!HOST.test(host)) throw new MailSettingsError('Enter the mail server address.')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new MailSettingsError('The port is a number from 1 to 65535.')
  const security = input.security
  if (security !== 'starttls' && security !== 'tls' && security !== 'none')
    throw new MailSettingsError('Encryption is STARTTLS, TLS or none.')
  const user = typeof input.user === 'string' ? input.user.trim() : ''
  if (user.length > 200 || /[\r\n]/.test(user))
    throw new MailSettingsError('The user name is not valid.')
  const from = typeof input.from === 'string' ? input.from.trim() : ''
  if (!isEmailAddress(from)) throw new MailSettingsError('Enter the sender address.')
  const fromName = typeof input.fromName === 'string' ? input.fromName.trim() : ''
  if (fromName.length > 100 || /[\r\n<>"]/.test(fromName))
    throw new MailSettingsError('The sender name is not valid.')
  const password = input.password
  if (password !== undefined && password !== null && typeof password !== 'string')
    throw new MailSettingsError('The password must be text.')
  if (typeof password === 'string' && (password.length > 500 || /[\r\n]/.test(password)))
    throw new MailSettingsError('The password is not valid.')

  ctx.db.transaction(() => {
    put(
      ctx,
      KEY,
      JSON.stringify({ host, port, security, user, from, fromName } satisfies MailSettings),
    )
    if (password === null) ctx.db.query('delete from settings where key = ?').run(PASSWORD_KEY)
    else if (typeof password === 'string' && password !== '')
      put(ctx, PASSWORD_KEY, seal(ctx.dataDir, password))
  })()
  return getMailSettings(ctx) as MailSettingsPublic
}
