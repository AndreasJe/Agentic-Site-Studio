// Signed, short-lived path to one check run's stored review images on the preview site (rule 4;
// decision #50). Same shape as review-link.ts, with a key of its own: a shots link never opens a
// package, and a review or staging link never opens an image. Path: /shots/<token>/<name>.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { REVIEW_LINK_LIFETIME_MS } from './review-link.ts'

export const SHOTS_LABEL = 'preview-shots-v1'
export type ShotsLink = { project: string; run: string; exp: number }

const PROJECT = /^[a-z0-9-]{1,64}$/
const RUN = /^[a-f0-9-]{36}$/
/** What the worker writes (apps/worker/src/visual.js IMAGE_NAME). Nothing else is ever served. */
export const SHOT_NAME = /^[A-Za-z0-9_]{1,80}-\d{3,4}-(baseline|current|diff)\.png$/

const keyOf = (appSecret: string) => createHmac('sha256', appSecret).update(SHOTS_LABEL).digest()
const valid = (l: Omit<ShotsLink, 'exp'>) => PROJECT.test(l.project) && RUN.test(l.run)

/** The token only; the caller adds `/shots/<token>/<name>`. */
export function signShotsToken(
  appSecret: string,
  link: Omit<ShotsLink, 'exp'>,
  now = Date.now(),
): string {
  if (!valid(link)) throw new Error('bad shots link')
  const body = { project: link.project, run: link.run, exp: now + REVIEW_LINK_LIFETIME_MS }
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = createHmac('sha256', keyOf(appSecret)).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyShotsToken(
  appSecret: string,
  token: string,
  now = Date.now(),
): ShotsLink | null {
  const [payload, sig, extra] = token.split('.')
  if (!payload || !sig || extra !== undefined) return null
  const want = createHmac('sha256', keyOf(appSecret)).update(payload).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  let link: ShotsLink
  try {
    link = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof link.exp !== 'number' || link.exp < now || !valid(link)) return null
  return link
}
