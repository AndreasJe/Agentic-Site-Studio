// Signed, short-lived preview paths for artboards (decision #45, rule 4). Previews get no
// cookies, so the app proves access by signing the path: the app checks membership, then signs
// exactly which project and which blobs may be served, until when.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const LINK_LIFETIME_MS = 15 * 60 * 1000

export type ArtboardLink = { project: string; html: string; css: string | null; exp: number }

const HASH = /^sha256:[0-9a-f]{64}$/
const PROJECT = /^[a-z0-9-]{1,64}$/

// A key of its own, so a preview signature can never pass as anything else the secret signs.
const keyOf = (appSecret: string) =>
  createHmac('sha256', appSecret).update('preview-artboard-v1').digest()

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function signArtboardLink(
  appSecret: string,
  link: Omit<ArtboardLink, 'exp'>,
  now = Date.now(),
): string {
  if (
    !PROJECT.test(link.project) ||
    !HASH.test(link.html) ||
    (link.css !== null && !HASH.test(link.css))
  )
    throw new Error('bad artboard link')
  const payload = b64(JSON.stringify({ ...link, exp: now + LINK_LIFETIME_MS }))
  const sig = b64(createHmac('sha256', keyOf(appSecret)).update(payload).digest())
  return `/a/${payload}.${sig}/`
}

/** The link's content if the signature is ours and it hasn't expired; otherwise null. */
export function verifyArtboardLink(
  appSecret: string,
  token: string,
  now = Date.now(),
): ArtboardLink | null {
  const [payload, sig, extra] = token.split('.')
  if (!payload || !sig || extra !== undefined) return null
  const want = createHmac('sha256', keyOf(appSecret)).update(payload).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  let link: ArtboardLink
  try {
    link = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof link.exp !== 'number' || link.exp < now) return null
  if (
    !PROJECT.test(link.project) ||
    !HASH.test(link.html) ||
    (link.css !== null && !HASH.test(link.css))
  )
    return null
  return link
}
