// Server-side sessions in SQLite (decision #41: 12 hours in all, 2 hours idle) and the Origin +
// CSRF guard every state-changing request passes (CLAUDE.md rule 4; from spike 3's guard.ts).
import type { Database } from 'bun:sqlite'
import { timingSafeEqual } from 'node:crypto'
import { toBase64Url } from '@site-studio/shared/bytes'
import type { Role } from './roles.ts'

export const SESSION_COOKIE = '__Host-sid'
export const SESSION_MAX_MS = 12 * 3600_000
export const SESSION_IDLE_MS = 2 * 3600_000

export type SessionUser = {
  id: number
  handle: string
  name: string
  role: Role
  language: 'en' | 'da'
}

/** Sessions are stored by hash, so a copy of the database holds no live session IDs. */
const keyOf = (sid: string) => new Bun.CryptoHasher('sha256').update(sid).digest('hex')

const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

export function createSession(db: Database, userId: number, now: number) {
  const id = random()
  const csrf = random()
  db.query(
    'insert into sessions (id, user_id, csrf, created_at, last_seen) values (?, ?, ?, ?, ?)',
  ).run(keyOf(id), userId, csrf, now, now)
  return { id, csrf }
}

export function loadSession(db: Database, sid: string | undefined, now: number) {
  if (!sid) return null
  const row = db
    .query(
      `select s.id, s.csrf, s.created_at, s.last_seen, u.id as uid, u.handle, u.name, u.role, u.language
       from sessions s join users u on u.id = s.user_id where s.id = ?`,
    )
    .get(keyOf(sid)) as {
    id: string
    csrf: string
    created_at: number
    last_seen: number
    uid: number
    handle: string
    name: string
    role: Role
    language: 'en' | 'da'
  } | null
  if (!row) return null
  if (now - row.created_at > SESSION_MAX_MS || now - row.last_seen > SESSION_IDLE_MS) {
    db.query('delete from sessions where id = ?').run(keyOf(sid))
    return null
  }
  db.query('update sessions set last_seen = ? where id = ?').run(now, keyOf(sid))
  const user: SessionUser = {
    id: row.uid,
    handle: row.handle,
    name: row.name,
    role: row.role,
    language: row.language,
  }
  return { sid, csrf: row.csrf, user }
}

export function endSession(db: Database, sid: string) {
  db.query('delete from sessions where id = ?').run(keyOf(sid))
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Secure is accepted on http://localhost by browsers; __Host- requires Path=/ and no Domain. */
export const sessionCookie = (id: string) =>
  `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`
export const clearedCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
