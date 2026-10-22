// Passkey signing for the Admin screens: a request from the server (a release, a production
// command, a rule change, a key) carries the exact challenge; the browser signs it and the server
// checks it, counts it and, when enough different Admins have signed, sends it on.
import { api, type Reply } from './api.ts'
import { type Assertion, assertWithPasskey } from './passkey.ts'

export type Signer = { adminId: string; at: string }
export type SigningView = {
  id: number
  status: string
  releaseNumber: number | null
  sequence: number | null
  target: string | null
  needed: number
  owner: string | null
  signers: Signer[]
  outcome: string | null
  smoke: unknown
  createdAt: string
  sentAt: string | null
}
export type PublicKeyOptions = {
  challenge: string
  allowCredentials?: { id: string }[]
  [k: string]: unknown
}
/** What the server answers when it starts a signing request for the signed-in Admin. */
export type SignOptions = {
  signingId: number
  purpose?: string
  needed: number
  owner: string | null
  signers: Signer[]
  publicKey: PublicKeyOptions
}
export type SignResult = {
  complete?: boolean
  sent?: boolean
  code?: string
  signing?: SigningView | null
}

export type Signed =
  | { ok: true; reply: Reply<SignResult>; cancelled?: false }
  | { ok: false; code: string; reply?: Reply<SignResult> }

/** The passkey ceremony, then the assertion goes to `path` (default: the generic signing route). */
export async function signAndSend(
  options: { signingId: number; publicKey: PublicKeyOptions },
  path = `/api/admin/signing/${options.signingId}/sign`,
): Promise<Signed> {
  const a = await assertWithPasskey(options.publicKey)
  if (!a.ok) return { ok: false, code: a.code }
  const reply = await api<SignResult>('POST', path, a.assertion satisfies Assertion)
  return reply.ok ? { ok: true, reply } : { ok: false, code: reply.body.code ?? 'other', reply }
}

/** A short, readable time. */
export const when = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** Seconds since an ISO time (Infinity when it is missing or unreadable). */
export const ageSeconds = (iso: string | null | undefined, now = Date.now()) => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, (now - t) / 1000)
}
