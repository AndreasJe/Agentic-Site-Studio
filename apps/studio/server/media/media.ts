// The media library's rules (plan §6.8): what a file is, whether an SVG is safe, metadata
// validation, the licence-expiry flag and the "used in" record.
// Metadata (GPS, author, XMP) is stripped on upload by strip.ts (M8.3, decision #22); image
// optimisation (decision #42) is separate and still pending.
import type { Database } from 'bun:sqlite'
import { StripError, stripMetadata } from './strip.ts'

export const MEDIA_MAX_BYTES = 20 * 1024 * 1024
export const CATEGORIES = [
  'free',
  'customer-logo',
  'customer-story',
  'employee',
  'partner',
  'award',
  'certification',
  'event',
] as const
export type Category = (typeof CATEGORIES)[number]

export class MediaError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 409 | 413 | 415 | 422,
    message = code,
  ) {
    super(message)
  }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to))

/** The type is decided by the first bytes, never by the name or the claimed type. */
export function sniff(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  const head = new TextDecoder().decode(bytes.slice(0, 2048)).replace(/^﻿/, '')
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

/** Refuse anything in an SVG that could run or fetch: this file is shown on the app's origin. */
export function checkSvg(bytes: Uint8Array): void {
  const text = new TextDecoder().decode(bytes)
  const unsafe = (why: string) => new MediaError('unsafe-svg', 422, why)
  // A namespace prefix (<x:script>) is the same element to the browser (review of M4).
  if (/<\s*([\w.-]+:)?script/i.test(text)) throw unsafe('script')
  if (/<\s*([\w.-]+:)?foreignObject/i.test(text)) throw unsafe('foreignObject')
  if (/<\s*([\w.-]+:)?(set|animate\w*|handler|iframe|embed|object)\b/i.test(text))
    throw unsafe('animation or embedded content')
  if (/(javascript|vbscript)\s*:/i.test(text)) throw unsafe('script URL')
  if (/<!\s*(ENTITY|DOCTYPE)/i.test(text)) throw unsafe('entity')
  if (/(^|[\s"'/])on[a-z]+\s*=/i.test(text)) throw unsafe('event handler')
  for (const m of text.matchAll(/\b(?:[\w.-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!v.startsWith('#')) throw unsafe('external reference')
  }
  for (const m of text.matchAll(/url\(\s*(['"]?)([^)]*)\1\s*\)/gi)) {
    if (!(m[2] ?? '').trim().startsWith('#')) throw unsafe('external reference')
  }
  if (/@import/i.test(text)) throw unsafe('external reference')
}

export function checkFile(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MEDIA_MAX_BYTES) throw new MediaError('too-large', 413)
  const mime = sniff(bytes)
  if (!mime) throw new MediaError('bad-type', 415)
  if (mime === 'image/svg+xml') checkSvg(bytes)
  return mime
}

/**
 * checkFile, then strip metadata: the type and the bytes to store. A file that isn't well formed
 * is refused (422 bad-file). The upload route must store `bytes` from here, never the raw upload.
 */
export function prepareUpload(raw: Uint8Array): { mime: string; bytes: Uint8Array } {
  const mime = checkFile(raw)
  try {
    const bytes = stripMetadata(mime, raw)
    if (mime === 'image/svg+xml') checkSvg(bytes)
    return { mime, bytes }
  } catch (err) {
    if (err instanceof StripError) throw new MediaError('bad-file', 422, err.message)
    throw err
  }
}

export type Meta = {
  title: string
  alt: string
  category: Category
  subject: string
  rights: string
  allowedUse: string
  licenceExpires: string | null
}

const TEXT_MAX = 500

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Validate the fields that are present; the rest are left out of the result. */
export function parseMeta(input: Record<string, unknown>): Partial<Meta> {
  const out: Partial<Meta> = {}
  const bad = (field: string) => new MediaError('bad-field', 400, field)
  if ('title' in input) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      throw bad('title')
    out.title = input.title.trim()
  }
  for (const k of ['alt', 'subject', 'rights', 'allowedUse'] as const) {
    if (k in input) {
      if (typeof input[k] !== 'string' || (input[k] as string).length > TEXT_MAX) throw bad(k)
      out[k] = (input[k] as string).trim()
    }
  }
  if ('category' in input) {
    if (!CATEGORIES.includes(input.category as Category)) throw bad('category')
    out.category = input.category as Category
  }
  if ('licenceExpires' in input) {
    const v = input.licenceExpires
    if (v === null || v === '') out.licenceExpires = null
    else if (typeof v === 'string' && validDate(v)) out.licenceExpires = v
    else throw bad('licenceExpires')
  }
  return out
}

/** Flag a licence that has run out, or runs out within 30 days (today counts as expiring). */
export function expiryStatus(
  expires: string | null,
  now = Date.now(),
): 'expired' | 'expiring' | null {
  if (!expires) return null
  const today = new Date(now).toISOString().slice(0, 10)
  if (expires < today) return 'expired'
  const days = (Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000
  return days <= 30 ? 'expiring' : null
}

/** Design calls this when a section uses an image; "Used in" lists the refs. */
export function recordUse(db: Database, mediaId: number, ref: string): void {
  db.query('insert or ignore into media_uses (media_id, ref, at) values (?, ?, ?)').run(
    mediaId,
    ref,
    new Date().toISOString(),
  )
}
