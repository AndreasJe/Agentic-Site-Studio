// M7.2 transport (decision #1, plan §13.4): the app writes to production's inbox and reads its
// outbox. Production never connects to the app.

export type TransportErrorCode =
  | 'invalid-name'
  | 'host-key-changed'
  | 'auth-failed'
  | 'connect-failed'
  | 'timeout'
  | 'connection-lost'
  | 'not-found'
  | 'refused'
  | 'failed'

export class TransportError extends Error {
  readonly code: TransportErrorCode
  constructor(code: TransportErrorCode, message: string) {
    super(message)
    this.name = 'TransportError'
    this.code = code
  }
}

export interface Transport {
  /** Atomic: written under `.tmp-<name>`, then renamed. Never visible half-written. */
  putInbox(name: string, bytes: Uint8Array): Promise<void>
  /** File names in the outbox (with one optional subfolder level), optionally filtered by prefix. */
  listOutbox(prefix?: string): Promise<string[]>
  readOutbox(name: string): Promise<Uint8Array>
  close(): Promise<void>
}

export const TEMP_PREFIX = '.tmp-'
const SEGMENT = /^[A-Za-z0-9._-]+$/

/** `[A-Za-z0-9._-]` plus one optional subfolder level; no `..`, no leading `/`, no temp names. */
export function validateName(name: string): { dir: string | null; base: string } {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new TransportError('invalid-name', 'name must be 1 to 200 characters')
  }
  const parts = name.split('/')
  if (parts.length > 2) throw new TransportError('invalid-name', 'at most one subfolder level')
  for (const p of parts) {
    if (!SEGMENT.test(p) || p === '.' || p.includes('..')) {
      throw new TransportError('invalid-name', `invalid name: ${JSON.stringify(name)}`)
    }
  }
  const base = parts[parts.length - 1] as string
  if (base.startsWith(TEMP_PREFIX)) {
    throw new TransportError('invalid-name', `names starting with ${TEMP_PREFIX} are reserved`)
  }
  return { dir: parts.length === 2 ? (parts[0] as string) : null, base }
}

/** A list prefix: the same characters, at most one `/`, no `..`. May be empty. */
export function validatePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return ''
  const parts = prefix.split('/')
  const ok =
    parts.length <= 2 &&
    prefix.length <= 200 &&
    parts.every((p, i) =>
      p === '' ? i === parts.length - 1 : SEGMENT.test(p) && !p.includes('..'),
    )
  if (!ok) throw new TransportError('invalid-name', `invalid prefix: ${JSON.stringify(prefix)}`)
  return prefix
}
