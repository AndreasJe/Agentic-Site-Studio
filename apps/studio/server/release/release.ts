// The release flow, app side (plan §13.3; decisions #6, #23, #27, #29, #47, #48; M7.3): the Admin
// review of a publication request, warnings acknowledged with a reason, the release bundle built
// once, passkey signatures from one or two Admins over `releaseChallenge(bundleHash, n)`, and
// delivery to production's inbox. Production checks everything again; the app's checks only
// keep a bad release from being signed or sent.
import { sha256 } from '@site-studio/shared/bytes'
import { hex, releaseChallenge, SITE, writeReleaseBundle } from '@site-studio/shared/release'
import type { SessionUser } from '../auth/sessions.ts'
import { ADVISORY_CHECKS, FLOOR_CHECKS, isFloor, type RunRow } from '../checks/checks.ts'
import { audit } from '../governance/audit.ts'
import { effectivePolicy } from '../governance/project-settings.ts'
import {
  getPackage,
  leadOf,
  pageDir,
  revisionDesign,
  revisionStructure,
} from '../review/package.ts'
import { getBlob, putBlob } from '../store/blobs.ts'
import { projectDir, readRevision, type StoreContext } from '../store/revisions.ts'
import { TransportError } from '../transport/types.ts'
import { resolve } from './inbox.ts'
import {
  createSigning,
  type Fail,
  highestSent,
  markOlderStale,
  passkeySignatures,
  requestOptions,
  type SigningRow,
  setStatus,
  signersOf,
  type WebAuthnDeps,
} from './signing.ts'
import { nextReleaseNumber, PRODUCTION, transportOf } from './targets.ts'

/** Decisions #29: production refuses more than 7 days ahead; an hour less, for the clocks. */
export const RELEASE_VALIDITY_MS = 7 * 24 * 3600_000 - 3600_000
export const REASON_MAX = 500
export const NOTE_MAX = 2000

export type RequestRow = {
  id: number
  project_id: string
  rev: string
  hash: string
  note: string
  user_id: number
  at: string
  status: 'open' | 'superseded' | 'sent-back' | 'published'
  closed_by: string | null
  closed_note: string | null
  closed_at: string | null
  by: string
}

type Finding = { message?: unknown; file?: unknown; target?: unknown; rule?: unknown }
type CheckResult = { id: string; status: string; findings?: Finding[] }

const fail = (status: Fail['status'], code: string): Fail => ({ ok: false, status, code })
export const requestRef = (id: number) => `request:${id}`

export function requestOf(ctx: StoreContext, id: number): RequestRow | null {
  return ctx.db
    .query(
      `select r.*, u.handle as "by" from publication_requests r join users u on u.id = r.user_id
       where r.id = ?`,
    )
    .get(id) as RequestRow | null
}

const lastRun = (ctx: StoreContext, r: RequestRow, kind: 'package' | 'smoke') =>
  ctx.db
    .query(
      `select * from check_runs where project_id = ? and rev = ? and hash = ? and kind = ?
       and status = 'done' order by at desc, rowid desc limit 1`,
    )
    .get(r.project_id, r.rev, r.hash, kind) as RunRow | null

const checksOf = (run: RunRow | null): CheckResult[] => {
  if (!run?.result_json) return []
  const parsed = JSON.parse(run.result_json) as { checks?: unknown }
  return Array.isArray(parsed.checks) ? (parsed.checks as CheckResult[]) : []
}

/** The floor checks all passed on this exact package, and the worker checked its hash. */
function floorPassed(run: RunRow | null): boolean {
  if (!run || run.blocked || run.error) return false
  const checks = checksOf(run)
  return FLOOR_CHECKS.every((id) => checks.find((c) => c.id === id)?.status === 'pass')
}

/** Every advisory check that did not pass: the warnings an Admin acknowledges (§13.3 step 6). */
function warningsOf(ctx: StoreContext, r: RequestRow) {
  const pkg = checksOf(lastRun(ctx, r, 'package'))
  const smoke = checksOf(lastRun(ctx, r, 'smoke'))
  const acks = ctx.db
    .query(
      `select a.check_id, a.reason, a.at, u.handle from review_acknowledgements a
       join users u on u.id = a.user_id where a.request_id = ?`,
    )
    .all(r.id) as { check_id: string; reason: string; at: string; handle: string }[]
  const out: {
    check: string
    status: string
    findings: { message: string; file?: string; rule?: string }[]
    acknowledged: { by: string; reason: string; at: string } | null
  }[] = []
  for (const id of [...ADVISORY_CHECKS, 'smoke']) {
    const c = (id === 'smoke' ? smoke : pkg).find((x) => x.id === id)
    const status = c?.status ?? 'not-run'
    if (status === 'pass' || isFloor(id)) continue
    const ack = acks.find((a) => a.check_id === id)
    out.push({
      check: id,
      status,
      findings: findingsOf(c),
      acknowledged: ack ? { by: ack.handle, reason: ack.reason, at: ack.at } : null,
    })
  }
  return out
}

function findingsOf(c: CheckResult | undefined) {
  const list = Array.isArray(c?.findings) ? (c?.findings as Finding[]) : []
  return list.slice(0, 200).map((f) => ({
    message: typeof f.message === 'string' ? f.message.slice(0, 500) : '',
    ...(typeof f.file === 'string' ? { file: f.file.slice(0, 300) } : {}),
    ...(typeof f.rule === 'string' ? { rule: f.rule.slice(0, 100) } : {}),
  }))
}

const pagePath = (file: string) =>
  file
    .replace(/^\/+/, '')
    .replace(/(^|\/)index\.html$/, '')
    .replace(/\/+$/, '')

/**
 * The per-section visual comparison (plan §13.3 step 6) from the M6 worker's visual check: its
 * findings per page, with the page's sections from this revision's own design. Screenshots are
 * not stored by the worker, so the findings are what there is.
 */
async function visualOf(ctx: StoreContext, r: RequestRow) {
  const check = checksOf(lastRun(ctx, r, 'package')).find((c) => c.id === 'visual')
  const findings = findingsOf(check)
  const base = { status: check?.status ?? 'not-run', screenshots: null, findings }
  try {
    const doc = readRevision(ctx.dataDir, r.project_id, r.rev)
    if (!doc) return { ...base, pages: [] }
    const structure = await revisionStructure(ctx, r.project_id, doc.files)
    const boards = await revisionDesign(ctx, r.project_id, doc.files)
    const pages = structure.pages.map((p) => {
      const dir = pageDir(structure, p.id)
      const mine = findings.filter((f) => f.file !== undefined && pagePath(f.file) === dir)
      return {
        page: p.id,
        path: dir,
        status: mine.length ? 'changed' : base.status === 'pass' ? 'unchanged' : base.status,
        findings: mine,
        sections: (leadOf(boards, p.id)?.sections ?? []).map((s) => ({ id: s.id, name: s.name })),
      }
    })
    return { ...base, pages }
  } catch {
    return { ...base, pages: [] }
  }
}

/** The newest signing request for this review, of any status. */
export const signingFor = (ctx: StoreContext, requestId: number) =>
  ctx.db
    .query('select * from signing_requests where ref = ? order by id desc limit 1')
    .get(requestRef(requestId)) as SigningRow | null

export function signingView(ctx: StoreContext, row: SigningRow | null) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    releaseNumber: row.kind === 'release' ? row.number : null,
    sequence: row.kind === 'command' ? row.number : null,
    target: row.target,
    needed: row.needed,
    owner: row.owner,
    signers: signersOf(ctx, row.id).map((s) => ({ adminId: s.adminId, at: s.at })),
    outcome: row.outcome,
    smoke: row.smoke ? (JSON.parse(row.smoke) as unknown) : null,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }
}

export async function reviewOf(ctx: StoreContext, id: number) {
  const r = requestOf(ctx, id)
  if (!r) return null
  const staged = ctx.db
    .query('select rev, hash, at from staged where project_id = ?')
    .get(r.project_id) as { rev: string; hash: string; at: string } | null
  const pkgRun = lastRun(ctx, r, 'package')
  const warnings = warningsOf(ctx, r)
  const signing = signingFor(ctx, id)
  const floor = floorPassed(pkgRun)
  return {
    request: {
      id: r.id,
      project: r.project_id,
      rev: r.rev,
      hash: r.hash,
      note: r.note,
      by: r.by,
      at: r.at,
      status: r.status,
      closed: r.closed_at ? { by: r.closed_by, note: r.closed_note, at: r.closed_at } : null,
    },
    staged,
    isStaged: staged?.rev === r.rev && staged.hash === r.hash,
    checks: {
      floorPassed: floor,
      run: pkgRun?.id ?? null,
      results: checksOf(pkgRun).map((c) => ({ id: c.id, status: c.status, floor: isFloor(c.id) })),
    },
    visual: await visualOf(ctx, r),
    warnings,
    policy: effectivePolicy(ctx, r.project_id),
    signing: signingView(ctx, signing),
    signers: signing
      ? signersOf(ctx, signing.id).map((s) => ({ adminId: s.adminId, at: s.at }))
      : [],
    canSign: r.status === 'open' && floor && warnings.every((w) => w.acknowledged),
  }
}

export function acknowledge(
  ctx: StoreContext,
  id: number,
  user: SessionUser,
  body: Record<string, unknown>,
): { ok: true } | Fail {
  const r = requestOf(ctx, id)
  if (!r) return fail(404, 'not-found')
  if (r.status !== 'open') return fail(409, 'request-closed')
  const check = typeof body.check === 'string' ? body.check : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return fail(400, 'reason-required')
  if (reason.length > REASON_MAX) return fail(400, 'reason-too-long')
  const warning = warningsOf(ctx, r).find((w) => w.check === check)
  if (!warning) return fail(404, 'no-such-warning')
  if (warning.acknowledged) return fail(409, 'already-acknowledged')
  ctx.db
    .query(
      'insert into review_acknowledgements (request_id, check_id, reason, user_id, at) values (?, ?, ?, ?, ?)',
    )
    .run(id, check, reason, user.id, new Date().toISOString())
  audit(ctx, user.handle, 'warning-acknowledged', {
    request: id,
    check,
    status: warning.status,
    reason,
  })
  return { ok: true }
}

/**
 * The bundle is built before anyone signs: manifest (project, site, target, revision, validUntil,
 * packageHash) then site.tar, the M6 archive byte for byte. The second Admin signs the same bundle
 * and number; a closed, expired or overtaken one starts again with a new number.
 */
export async function releaseChallengeFor(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  id: number,
  user: SessionUser,
) {
  const r = requestOf(ctx, id)
  if (!r) return fail(404, 'not-found')
  if (r.status !== 'open') return fail(409, 'request-closed')
  const review = await reviewOf(ctx, id)
  if (!review?.checks.floorPassed) return fail(409, 'checks-not-passed')
  if (!review.warnings.every((w) => w.acknowledged)) return fail(409, 'warnings-not-acknowledged')

  const existing = signingFor(ctx, id)
  if (existing && existing.status === 'open' && existing.expires_at > deps.now()) {
    return { ok: true as const, options: requestOptions(ctx, deps, existing, user) }
  }
  if (existing && existing.status === 'signed') return fail(409, 'already-signed')
  if (existing && (existing.status === 'sent' || existing.status === 'accepted'))
    return fail(409, 'already-sent')
  if (existing?.status === 'open') setStatus(ctx, existing.id, 'stale', { outcome: 'expired' })

  const target = PRODUCTION
  if (!transportOf(ctx, target)) return fail(409, 'not-paired')
  const pkg = getPackage(ctx, r.project_id, r.rev)
  if (!pkg || pkg.hash !== r.hash) return fail(409, 'package-mismatch')
  const dir = projectDir(ctx.dataDir, r.project_id)
  const siteTar = new Uint8Array(await getBlob(dir, pkg.archive))
  if (hex(await sha256(siteTar)) !== r.hash) return fail(409, 'package-mismatch')
  const doc = readRevision(ctx.dataDir, r.project_id, r.rev)
  if (!doc) return fail(409, 'package-mismatch')
  const site = (await revisionStructure(ctx, r.project_id, doc.files)).roots[0]?.address ?? ''
  if (!SITE.test(site)) return fail(409, 'no-site-address')

  const validUntil = new Date(
    Math.floor((deps.now() + RELEASE_VALIDITY_MS) / 1000) * 1000,
  ).toISOString()
  let bundle: Uint8Array
  try {
    bundle = await writeReleaseBundle(
      { project: r.project_id, site, target, revision: r.rev, validUntil },
      siteTar,
    )
  } catch {
    return fail(409, 'bundle-refused')
  }
  const bundleHash = await sha256(new Uint8Array(bundle))
  const blob = await putBlob(dir, bundle)
  const n = nextReleaseNumber(ctx, target)
  const row = createSigning(ctx, {
    kind: 'release',
    purpose: 'release',
    target,
    ref: requestRef(id),
    body: {
      project: r.project_id,
      revision: r.rev,
      releaseNumber: n,
      packageHash: `sha256:${hex(bundleHash)}`,
      approvedBy: '',
      checks: 'passed',
    },
    challenge: releaseChallenge(bundleHash, n),
    needed: effectivePolicy(ctx, r.project_id).releases,
    number: n,
    effect: {
      type: 'release',
      requestId: id,
      project: r.project_id,
      bundle: blob,
      site,
      validUntil,
    },
    createdBy: user.handle,
    expiresAt: Date.parse(validUntil),
  })
  audit(ctx, user.handle, 'release-prepared', {
    request: id,
    project: r.project_id,
    revision: r.rev,
    release: n,
    bundle: `sha256:${hex(bundleHash)}`,
    packageHash: `sha256:${r.hash}`,
  })
  return { ok: true as const, options: requestOptions(ctx, deps, row, user) }
}

export const releaseFileNames = (n: number) => ({
  tar: `release-${n}.tar`,
  json: `release-${n}.json`,
})

/** release-<n>.tar first, then release-<n>.json: the agent waits for the bundle (#48). */
export async function deliverRelease(
  ctx: StoreContext,
  deps: WebAuthnDeps,
  row: SigningRow,
  who: string,
): Promise<{ ok: true; releaseNumber: number } | Fail> {
  if (row.kind !== 'release' || row.number === null || !row.target)
    return fail(409, 'not-a-release')
  if (row.status !== 'signed') return fail(409, 'not-signed')
  const effect = JSON.parse(row.effect) as { requestId: number; project: string; bundle: string }
  const r = requestOf(ctx, effect.requestId)
  if (r?.status !== 'open') {
    setStatus(ctx, row.id, 'cancelled', { outcome: 'request-closed' })
    return fail(409, 'request-closed')
  }
  if (row.expires_at <= deps.now()) {
    setStatus(ctx, row.id, 'stale', { outcome: 'expired' })
    return fail(409, 'needs-re-signing')
  }
  // Checked again at the moment of sending: a later run on the same package, or a warning not
  // acknowledged, stops it.
  const review = await reviewOf(ctx, r.id)
  if (!review?.checks.floorPassed) return fail(409, 'checks-not-passed')
  if (!review.warnings.every((w) => w.acknowledged)) return fail(409, 'warnings-not-acknowledged')
  if (row.number <= highestSent(ctx, row.target, 'release')) {
    setStatus(ctx, row.id, 'stale', { outcome: 'overtaken' })
    return fail(409, 'needs-re-signing')
  }
  const signers = signersOf(ctx, row.id)
  // A key removed after it signed no longer counts: the release has to be signed again (#32).
  const usable = ctx.db.query(
    'select 1 from passkeys where id = ? and removed_at is null and approved_at is not null',
  )
  if (signers.some((s) => !usable.get(s.keyId))) {
    setStatus(ctx, row.id, 'stale', { outcome: 'key-removed' })
    return fail(409, 'needs-re-signing')
  }
  const t = transportOf(ctx, row.target)
  if (!t) return fail(409, 'not-paired')
  const bundle = await getBlob(projectDir(ctx.dataDir, effect.project), effect.bundle)
  const release = {
    ...(JSON.parse(row.body) as Record<string, unknown>),
    approvedBy: signers.map((s) => s.adminId).join(', '),
    signatures: passkeySignatures(ctx, row.id),
  }
  const names = releaseFileNames(row.number)
  try {
    await t.putInbox(names.tar, new Uint8Array(bundle))
    await t.putInbox(names.json, new TextEncoder().encode(JSON.stringify(release)))
  } catch (e) {
    return fail(502, e instanceof TransportError ? `transport-${e.code}` : 'transport-failed')
  }
  setStatus(ctx, row.id, 'sent', { sent: true })
  markOlderStale(ctx, row.target, 'release', row.number)
  resolve(ctx, 'publication-request', requestRef(r.id))
  audit(ctx, who, 'release-sent', {
    request: r.id,
    release: row.number,
    target: row.target,
    signers: signers.map((s) => s.adminId),
  })
  return { ok: true, releaseNumber: row.number }
}

/** Plan §13.3 step 7: send it back with a comment; the request is closed. */
export function sendBack(
  ctx: StoreContext,
  id: number,
  user: SessionUser,
  body: Record<string, unknown>,
): { ok: true } | Fail {
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!note) return fail(400, 'note-required')
  if (note.length > NOTE_MAX) return fail(400, 'note-too-long')
  const done = ctx.db.transaction(() => {
    const changed = ctx.db
      .query(
        `update publication_requests set status = 'sent-back', closed_by = ?, closed_note = ?, closed_at = ?
         where id = ? and status = 'open'`,
      )
      .run(user.handle, note, new Date().toISOString(), id)
    if (changed.changes !== 1) return false
    ctx.db
      .query(
        `update signing_requests set status = 'cancelled', outcome = 'sent-back'
         where ref = ? and status in ('open', 'signed')`,
      )
      .run(requestRef(id))
    return true
  })()
  if (!done) return requestOf(ctx, id) ? fail(409, 'request-closed') : fail(404, 'not-found')
  resolve(ctx, 'publication-request', requestRef(id))
  audit(ctx, user.handle, 'request-sent-back', { request: id, note })
  return { ok: true }
}
