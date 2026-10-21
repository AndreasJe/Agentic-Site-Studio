// Signed, short-lived paths to a saved revision's package on the preview site (rule 4):
// review (decision #46) and staging (decision #47). The app checks membership, then signs which
// project, revision and package hash the preview may serve, until when. Each kind has a key of
// its own, so a review link never opens staging and neither passes as an artboard link.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const REVIEW_LINK_LIFETIME_MS = 15 * 60 * 1000

export type ReviewLink = { project: string; rev: string; hash: string; exp: number }
export type LinkKind = 'review' | 'staging'

const PROJECT = /^[a-z0-9-]{1,64}$/
const REV = /^[a-z0-9-]{1,80}$/
const HASH = /^[0-9a-f]{64}$/

const LABEL: Record<LinkKind, string> = {
  review: 'preview-review-v1',
  staging: 'preview-staging-v1',
}
const PREFIX: Record<LinkKind, string> = { review: '/__review/', staging: '/staging/' }

const keyOf = (appSecret: string, kind: LinkKind) =>
  createHmac('sha256', appSecret).update(LABEL[kind]).digest()

const valid = (l: Omit<ReviewLink, 'exp'>) =>
  PROJECT.test(l.project) && REV.test(l.rev) && HASH.test(l.hash)

export function signLink(
  kind: LinkKind,
  appSecret: string,
  link: Omit<ReviewLink, 'exp'>,
  now = Date.now(),
): string {
  if (!valid(link)) throw new Error(`bad ${kind} link`)
  const body = {
    project: link.project,
    rev: link.rev,
    hash: link.hash,
    exp: now + REVIEW_LINK_LIFETIME_MS,
  }
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = createHmac('sha256', keyOf(appSecret, kind)).update(payload).digest('base64url')
  return `${PREFIX[kind]}${payload}.${sig}/`
}

/** The link's content if the signature is ours for this kind and it hasn't expired; else null. */
export function verifyLink(
  kind: LinkKind,
  appSecret: string,
  token: string,
  now = Date.now(),
): ReviewLink | null {
  const [payload, sig, extra] = token.split('.')
  if (!payload || !sig || extra !== undefined) return null
  const want = createHmac('sha256', keyOf(appSecret, kind)).update(payload).digest()
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

export const signReviewLink = (s: string, l: Omit<ReviewLink, 'exp'>, now?: number) =>
  signLink('review', s, l, now)
export const verifyReviewLink = (s: string, t: string, now?: number) =>
  verifyLink('review', s, t, now)
export const signStagingLink = (s: string, l: Omit<ReviewLink, 'exp'>, now?: number) =>
  signLink('staging', s, l, now)
export const verifyStagingLink = (s: string, t: string, now?: number) =>
  verifyLink('staging', s, t, now)
