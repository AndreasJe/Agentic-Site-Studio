// The app's Origin and CSRF check for every state-changing request (CLAUDE.md rule 4).
import { timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = '__Host-sid'
export type Session = { csrf: string }
export type Verdict = { ok: true; sid?: string } | { ok: false; status: number; reason: string }

const SAFE = new Set(['GET', 'HEAD'])

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * GET and HEAD pass (handlers still need a session to answer). Anything else needs
 * Origin === the app origin and, unless it is the sign-in itself, a session cookie and an
 * X-CSRF-Token header that matches that session.
 */
export function checkRequest(
  req: Request,
  opts: { appOrigin: string; sessions: ReadonlyMap<string, Session>; requireSession: boolean },
): Verdict {
  if (SAFE.has(req.method)) return { ok: true }
  if (req.headers.get('origin') !== opts.appOrigin)
    return { ok: false, status: 403, reason: 'bad-origin' }
  if (!opts.requireSession) return { ok: true }
  const sid = readCookie(req.headers.get('cookie'), SESSION_COOKIE)
  const session = sid === undefined ? undefined : opts.sessions.get(sid)
  if (!sid || !session) return { ok: false, status: 403, reason: 'no-session' }
  const token = req.headers.get('x-csrf-token')
  if (!token || !sameToken(token, session.csrf))
    return { ok: false, status: 403, reason: 'bad-csrf' }
  return { ok: true, sid }
}
