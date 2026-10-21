// Signed, short-lived review paths (decision #46, rule 4). Like artboard links, but for a saved
// revision's package: the app checks membership, then signs which project, revision and package
// hash the preview may serve, until when. A key of its own, so the two kinds never mix.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const REVIEW_LINK_LIFETIME_MS = 15 * 60 * 1000

export type ReviewLink = { project: string; rev: string; hash: string; exp: number }

const PROJECT = /^[a-z0-9-]{1,64}$/
const REV = /^[a-z0-9-]{1,80}$/
const HASH = /^[0-9a-f]{64}$/

const keyOf = (appSecret: string) =>
  createHmac('sha256', appSecret).update('preview-review-v1').digest()

const valid = (l: Omit<ReviewLink, 'exp'>) =>
  PROJECT.test(l.project) && REV.test(l.rev) && HASH.test(l.hash)

export function signReviewLink(
  appSecret: string,
  link: Omit<ReviewLink, 'exp'>,
  now = Date.now(),
): string {
  if (!valid(link)) throw new Error('bad review link')
  const body = {
    project: link.project,
    rev: link.rev,
    hash: link.hash,
    exp: now + REVIEW_LINK_LIFETIME_MS,
  }
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = createHmac('sha256', keyOf(appSecret)).update(payload).digest('base64url')
  return `/__review/${payload}.${sig}/`
}

/** The link's content if the signature is ours and it hasn't expired; otherwise null. */
export function verifyReviewLink(
  appSecret: string,
  token: string,
  now = Date.now(),
): ReviewLink | null {
  const [payload, sig, extra] = token.split('.')
  if (!payload || !sig || extra !== undefined) return null
  const want = createHmac('sha256', keyOf(appSecret)).update(payload).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  let link: ReviewLink
  try {
    link = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof link.exp !== 'number' || link.exp < now || !valid(link)) return null
  return link
}
