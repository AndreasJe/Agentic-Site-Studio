// Pairing a production target (M7.5; decisions #1, #25, #31, #34; plan §13.6).
//
// The wizard, all Admin only:
//   1. keys      the app's SSH public key and signing public key, to install on production
//   2. connect   host and port; the app connects, pins nothing yet, shows the host key it saw and
//                production's first heartbeat (untrusted data, shown only)
//   3. pin-host  the Admin compares the host key with the server's screen; the app pins it
//   4. prepare   builds the pairing file (app address, rpId, target, signing key, every Admin's
//                keys, the rule, and the target's last command and release numbers) as the
//                unsigned `trust-keys` genesis command, and shows ONE fingerprint over all of it
//   5. confirm   the confirming Admin's passkey assertion over that command; the app checks it
//                the way production will, then writes the file to the inbox. The person at the
//                server compares the fingerprint and confirms it there (decisions #25).
//
// Re-pairing a target that is live (sent or paired) never touches the live pairing until the new
// file is confirmed: the wizard works on a candidate (deploy_candidates), and confirm switches the
// target to it. Until then freeze and every other command still go to the live host (#48).
// The genesis carries the app's current rule and only approved keys that aren't removed.
import {
  acceptCommand,
  commandChallenge,
  emptyState,
  genesisFingerprint,
  type TrustedKey,
} from '@site-studio/shared/release'
import { currentPolicy, parsePolicy, samePolicy, strictest } from '../governance/policy.ts'
import type { StoreContext } from '../store/revisions.ts'
import { FolderTransport } from '../transport/folder.ts'
import { type HostPins, loadOrCreateClientKey, MemoryHostPins } from '../transport/keys.ts'
import { SftpTransport } from '../transport/sftp.ts'
import { type Transport, TransportError } from '../transport/types.ts'
import { appSigningPublicKey } from './app-key.ts'

export class PairingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message)
  }
}

export type TargetStatus = 'connecting' | 'pinned' | 'prepared' | 'sent' | 'paired'

export type TargetRow = {
  target: string
  kind: 'sftp' | 'folder'
  host: string | null
  port: number | null
  username: string | null
  inbox_dir: string | null
  outbox_dir: string | null
  host_fp_seen: string | null
  host_fp: string | null
  domains: string
  status: TargetStatus
  last_sequence: number
  last_release: number
  pending: string | null
  fingerprint: string | null
  created_at: string
  updated_at: string
}

/** A re-pairing in progress on a live target: the wizard's state, kept apart from the live row. */
export type CandidateRow = Omit<TargetRow, 'last_sequence' | 'last_release' | 'status'> & {
  status: 'connecting' | 'pinned' | 'prepared'
}

/** What the API shows: never the pending command's internals. */
export type TargetView = {
  target: string
  kind: 'sftp' | 'folder'
  host: string | null
  port: number | null
  hostFingerprintSeen: string | null
  hostFingerprintPinned: string | null
  domains: string[]
  status: TargetStatus
  fingerprint: string | null
  lastSequence: number
  lastRelease: number
  /** A re-pairing in progress; the fields above stay the live pairing until it is confirmed. */
  candidate: {
    kind: 'sftp' | 'folder'
    host: string | null
    port: number | null
    hostFingerprintSeen: string | null
    hostFingerprintPinned: string | null
    domains: string[]
    status: CandidateRow['status']
    fingerprint: string | null
  } | null
}

export type PairingDeps = {
  ctx: StoreContext
  appUrl: URL
  now?: () => Date
  /** Dev and tests: targets that are two local folders instead of SFTP. */
  allowFolder?: boolean
}

export type Heartbeat = {
  at: string | null
  agentVersion: string | null
  paired: boolean
  frozen: boolean
  site: string | null
  target: string | null
  highestRelease: number | null
  lastSequence: number | null
}

const TARGET = /^[a-z][a-z0-9-]{0,31}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9a-fA-F:.]+\])$/
const DNS = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/_-]{43}$/
const B64U = /^[A-Za-z0-9_-]{1,8192}$/
const PAIRING_FILE_LIFETIME_MS = 3600_000
const MAX_HEARTBEAT_BYTES = 64 * 1024
const NAME_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/

const nowOf = (d: PairingDeps) => (d.now ?? (() => new Date()))()

export function getTarget(ctx: StoreContext, target: string): TargetRow | null {
  return (
    (ctx.db.query('select * from deploy_targets where target = ?').get(target) as
      | TargetRow
      | undefined) ?? null
  )
}

export function getCandidate(ctx: StoreContext, target: string): CandidateRow | null {
  return (
    (ctx.db.query('select * from deploy_candidates where target = ?').get(target) as
      | CandidateRow
      | undefined) ?? null
  )
}

const isLive = (r: Pick<TargetRow, 'status'>) => r.status === 'sent' || r.status === 'paired'

/**
 * The row the wizard works on: the candidate while a live pairing stays in force, else the target
 * itself. The numbers always come from the target (#34).
 */
function wizardOf(
  ctx: StoreContext,
  target: string,
): { row: TargetRow; live: TargetRow; candidate: boolean } | null {
  const live = getTarget(ctx, target)
  if (!live) return null
  const c = isLive(live) ? getCandidate(ctx, target) : null
  if (!c) return { row: live, live, candidate: false }
  return {
    row: { ...c, target, last_sequence: live.last_sequence, last_release: live.last_release },
    live,
    candidate: true,
  }
}

export function listTargets(ctx: StoreContext): TargetView[] {
  return (ctx.db.query('select * from deploy_targets order by target').all() as TargetRow[]).map(
    (r) => viewOf(r, getCandidate(ctx, r.target)),
  )
}

export function viewOf(r: TargetRow, c: CandidateRow | null = null): TargetView {
  return {
    candidate:
      c && isLive(r)
        ? {
            kind: c.kind,
            host: c.host,
            port: c.port,
            hostFingerprintSeen: c.host_fp_seen,
            hostFingerprintPinned: c.host_fp,
            domains: JSON.parse(c.domains) as string[],
            status: c.status,
            fingerprint: c.fingerprint,
          }
        : null,
    target: r.target,
    kind: r.kind,
    host: r.host,
    port: r.port,
    hostFingerprintSeen: r.host_fp_seen,
    hostFingerprintPinned: r.host_fp,
    domains: JSON.parse(r.domains) as string[],
    status: r.status,
    fingerprint: r.fingerprint,
    lastSequence: r.last_sequence,
    lastRelease: r.last_release,
  }
}

/** The app's two public keys, for the first wizard step. */
export async function appPublicKeys(ctx: StoreContext) {
  return {
    ssh: loadOrCreateClientKey(ctx.dataDir).publicKey,
    signing: await appSigningPublicKey(ctx.dataDir),
  }
}

/**
 * The next command number for a target, one counter for every command (decisions #26). Everything
 * that signs a command for production takes its number here.
 */
export function allocateSequence(ctx: StoreContext, target: string): number {
  const row = ctx.db
    .query(
      'update deploy_targets set last_sequence = last_sequence + 1 where target = ? returning last_sequence',
    )
    .get(target) as { last_sequence: number } | null
  if (!row) throw new PairingError('unknown-target', `No target called ${target}`, 404)
  return row.last_sequence
}

// ---- transports -------------------------------------------------------------------------

class RowPins implements HostPins {
  constructor(
    private readonly ctx: StoreContext,
    private readonly target: string,
  ) {}
  get() {
    return getTarget(this.ctx, this.target)?.host_fp ?? undefined
  }
  set() {
    // Pinning is the Admin's deliberate step (pin-host), never a side effect of connecting.
  }
}

const cache = new WeakMap<object, Map<string, { key: string; t: Transport }>>()

function forget(ctx: StoreContext, target: string) {
  const m = cache.get(ctx.db)
  const old = m?.get(target)
  if (old) void old.t.close()
  m?.delete(target)
}

/** Closes every cached connection (shutdown, and tests that stop the server). */
export async function closeTransports(ctx: StoreContext): Promise<void> {
  const m = cache.get(ctx.db)
  if (!m) return
  const all = [...m.values()]
  m.clear()
  await Promise.allSettled(all.map((x) => x.t.close()))
}

/** The transport of a paired target, or null if it isn't paired (or its file isn't sent yet). */
export function transportFor(ctx: StoreContext, target: string): Transport | null {
  const row = getTarget(ctx, target)
  if (!row || (row.status !== 'sent' && row.status !== 'paired')) return null
  const key = JSON.stringify([
    row.kind,
    row.host,
    row.port,
    row.username,
    row.inbox_dir,
    row.outbox_dir,
    row.host_fp,
  ])
  let m = cache.get(ctx.db)
  if (!m) {
    m = new Map()
    cache.set(ctx.db, m)
  }
  const hit = m.get(target)
  if (hit && hit.key === key) return hit.t
  if (hit) void hit.t.close()
  const t = build(ctx, row, new RowPins(ctx, target))
  m.set(target, { key, t })
  return t
}

function build(ctx: StoreContext, row: TargetRow, pins: HostPins): Transport {
  if (row.kind === 'folder') {
    return new FolderTransport({
      inboxDir: row.inbox_dir as string,
      outboxDir: row.outbox_dir as string,
    })
  }
  const key = loadOrCreateClientKey(ctx.dataDir)
  return new SftpTransport({
    host: row.host as string,
    port: row.port ?? 22,
    username: row.username ?? 'app',
    privateKey: key.privateKey,
    pins,
    pinId: row.target,
  })
}

// ---- heartbeat ---------------------------------------------------------------------------

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null)
const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null)

/** Production's outbox is untrusted: parse with caps, keep only the known fields. */
export async function readHeartbeat(t: Transport): Promise<Heartbeat | null> {
  let bytes: Uint8Array
  try {
    const names = await t.listOutbox('heartbeat')
    if (!names.includes('heartbeat.json')) return null
    bytes = await t.readOutbox('heartbeat.json', MAX_HEARTBEAT_BYTES)
  } catch (e) {
    if (e instanceof TransportError && (e.code === 'not-found' || e.code === 'too-large'))
      return null
    throw e
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  return {
    at: str(o.at, 40),
    agentVersion: str(o.agentVersion, 40),
    paired: o.paired === true,
    frozen: o.frozen === true,
    site: str(o.site, 253),
    target: str(o.target, 64),
    highestRelease: int(o.highestRelease),
    lastSequence: int(o.lastSequence),
  }
}

// ---- wizard ------------------------------------------------------------------------------

export type ConnectInput = {
  target: unknown
  kind?: unknown
  host?: unknown
  port?: unknown
  username?: unknown
  inboxDir?: unknown
  outboxDir?: unknown
  domains?: unknown
}

/**
 * The names certificates may carry, from the Admin. Never from the heartbeat: production's outbox
 * is untrusted, and these names decide what the app gets certificates for.
 */
function domainsOf(input: unknown): string[] {
  if (input === undefined)
    throw new PairingError('domains-required', 'List the names the certificate may carry.')
  if (!Array.isArray(input) || input.length === 0 || input.length > 20)
    throw new PairingError('bad-domains', 'List the names the certificate may carry.')
  const names = input.map((d) => (typeof d === 'string' ? d.toLowerCase() : ''))
  if (!names.every((d) => DNS.test(d)))
    throw new PairingError('bad-domains', 'One of the names is not a valid domain name.')
  return [...new Set(names)]
}

type ConnectionFields = Pick<
  TargetRow,
  | 'kind'
  | 'host'
  | 'port'
  | 'username'
  | 'inbox_dir'
  | 'outbox_dir'
  | 'host_fp_seen'
  | 'host_fp'
  | 'domains'
> & { status: 'connecting' | 'pinned' }

export async function connectTarget(deps: PairingDeps, input: ConnectInput) {
  const { ctx } = deps
  const target = input.target
  if (typeof target !== 'string' || !TARGET.test(target))
    throw new PairingError('bad-target', 'A target name is lower-case letters, digits and hyphens.')
  const kind = input.kind ?? 'sftp'
  const at = nowOf(deps).toISOString()
  const existing = getTarget(ctx, target)
  // A live pairing stays as it is: the new connection becomes a candidate until it is confirmed.
  const live = existing !== null && isLive(existing)
  const domains = JSON.stringify(domainsOf(input.domains))
  const save = (v: ConnectionFields) =>
    live ? upsertCandidate(ctx, target, at, v) : upsert(ctx, target, existing, at, v)

  let hostFingerprint: string | null = null
  let hb: Heartbeat | null
  if (kind === 'folder') {
    if (!deps.allowFolder)
      throw new PairingError('folder-not-allowed', 'Folder targets are for development only.')
    if (typeof input.inboxDir !== 'string' || typeof input.outboxDir !== 'string')
      throw new PairingError('bad-folders', 'A folder target needs an inbox and an outbox folder.')
    const t = new FolderTransport({ inboxDir: input.inboxDir, outboxDir: input.outboxDir })
    hb = await readHeartbeat(t).catch(() => null)
    save({
      kind: 'folder',
      host: null,
      port: null,
      username: null,
      inbox_dir: input.inboxDir,
      outbox_dir: input.outboxDir,
      host_fp_seen: null,
      host_fp: null,
      domains,
      status: 'pinned',
    })
  } else if (kind === 'sftp') {
    const host = input.host
    const port = input.port === undefined ? 22 : Number(input.port)
    const username = input.username === undefined ? 'app' : input.username
    if (typeof host !== 'string' || !HOST.test(host))
      throw new PairingError('bad-host', 'Enter the production server address.')
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new PairingError('bad-port', 'The port is a number from 1 to 65535.')
    if (typeof username !== 'string' || !NAME_USERNAME.test(username))
      throw new PairingError('bad-user', 'The SFTP user name is not valid.')
    const pins = new MemoryHostPins()
    const key = loadOrCreateClientKey(ctx.dataDir)
    const t = new SftpTransport({
      host,
      port,
      username,
      privateKey: key.privateKey,
      pins,
      pinId: target,
      connectTimeoutMs: 8000,
      opTimeoutMs: 15000,
    })
    try {
      try {
        hb = await readHeartbeat(t)
      } catch (e) {
        // A connection that was accepted has seen the host key even if the listing then fails.
        if (!pins.get(target)) throw e
        hb = null
      }
    } catch (e) {
      if (e instanceof TransportError) throw new PairingError(`transport-${e.code}`, e.message, 502)
      throw e
    } finally {
      await t.close()
    }
    hostFingerprint = pins.get(target) ?? null
    if (!hostFingerprint)
      throw new PairingError('no-host-key', 'The server did not show a host key.', 502)
    save({
      kind: 'sftp',
      host,
      port,
      username,
      inbox_dir: null,
      outbox_dir: null,
      host_fp_seen: hostFingerprint,
      host_fp: null,
      domains,
      status: 'connecting',
    })
  } else {
    throw new PairingError('bad-kind', 'The server type is sftp.')
  }
  if (!live) forget(ctx, target)
  return { target: viewOf(...viewArgs(ctx, target)), hostFingerprint, heartbeat: hb }
}

const viewArgs = (ctx: StoreContext, target: string): [TargetRow, CandidateRow | null] => [
  getTarget(ctx, target) as TargetRow,
  getCandidate(ctx, target),
]

function upsert(
  ctx: StoreContext,
  target: string,
  existing: TargetRow | null,
  at: string,
  v: ConnectionFields,
) {
  // Command and release numbers belong to the target, not to a host: they survive a re-pairing
  // so signed files from the old host stay refused (decisions #34).
  ctx.db
    .query(
      `insert into deploy_targets
         (target, kind, host, port, username, inbox_dir, outbox_dir, host_fp_seen, host_fp, domains,
          status, last_sequence, last_release, pending, fingerprint, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)
       on conflict (target) do update set
         kind = excluded.kind, host = excluded.host, port = excluded.port,
         username = excluded.username, inbox_dir = excluded.inbox_dir,
         outbox_dir = excluded.outbox_dir, host_fp_seen = excluded.host_fp_seen,
         host_fp = excluded.host_fp, domains = excluded.domains, status = excluded.status,
         pending = null, fingerprint = null, updated_at = excluded.updated_at`,
    )
    .run(
      target,
      v.kind,
      v.host,
      v.port,
      v.username,
      v.inbox_dir,
      v.outbox_dir,
      v.host_fp_seen,
      v.host_fp,
      v.domains,
      v.status,
      existing?.last_sequence ?? 0,
      existing?.last_release ?? 0,
      existing?.created_at ?? at,
      at,
    )
}

function upsertCandidate(ctx: StoreContext, target: string, at: string, v: ConnectionFields) {
  ctx.db
    .query(
      `insert into deploy_candidates
         (target, kind, host, port, username, inbox_dir, outbox_dir, host_fp_seen, host_fp, domains,
          status, pending, fingerprint, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)
       on conflict (target) do update set
         kind = excluded.kind, host = excluded.host, port = excluded.port,
         username = excluded.username, inbox_dir = excluded.inbox_dir,
         outbox_dir = excluded.outbox_dir, host_fp_seen = excluded.host_fp_seen,
         host_fp = excluded.host_fp, domains = excluded.domains, status = excluded.status,
         pending = null, fingerprint = null, updated_at = excluded.updated_at`,
    )
    .run(
      target,
      v.kind,
      v.host,
      v.port,
      v.username,
      v.inbox_dir,
      v.outbox_dir,
      v.host_fp_seen,
      v.host_fp,
      v.domains,
      v.status,
      at,
      at,
    )
}

/** The table the wizard writes for this target: the candidate's while a live pairing is kept. */
const wizardTable = (candidate: boolean) => (candidate ? 'deploy_candidates' : 'deploy_targets')

/** The Admin compared the host key with the server's screen: pin exactly the one that was seen. */
export function pinHost(deps: PairingDeps, target: string, fingerprint: unknown): TargetView {
  const w = wizardOf(deps.ctx, target)
  if (!w) throw new PairingError('unknown-target', `No target called ${target}`, 404)
  const { row } = w
  if (row.kind !== 'sftp' || !row.host_fp_seen || row.status !== 'connecting')
    throw new PairingError('nothing-to-pin', 'Connect to the server first.', 409)
  if (
    typeof fingerprint !== 'string' ||
    !FINGERPRINT.test(fingerprint) ||
    fingerprint !== row.host_fp_seen
  )
    throw new PairingError('fingerprint-mismatch', 'That is not the host key the app saw.', 409)
  deps.ctx.db
    .query(
      `update ${wizardTable(w.candidate)} set host_fp = ?, status = 'pinned', updated_at = ? where target = ? and status = 'connecting'`,
    )
    .run(fingerprint, nowOf(deps).toISOString(), target)
  if (!w.candidate) forget(deps.ctx, target)
  return viewOf(...viewArgs(deps.ctx, target))
}

type Pending = {
  unsigned: Record<string, unknown>
  fingerprint: string
  userId: number
  keyIds: string[]
}

type KeyRow = { id: string; public_key: string; alg: number; handle: string; user_id: number }

export type PrepareInput = { policy?: unknown }

/** The pairing file, unsigned, with its fingerprint and the challenge the Admin's passkey signs. */
export async function preparePairing(
  deps: PairingDeps,
  user: { id: number },
  target: string,
  input: PrepareInput = {},
) {
  const { ctx, appUrl } = deps
  const w = wizardOf(ctx, target)
  if (!w) throw new PairingError('unknown-target', `No target called ${target}`, 404)
  const { row } = w
  if (row.status === 'connecting')
    throw new PairingError('host-not-pinned', 'Compare and pin the host key first.', 409)
  if (row.status === 'sent' || row.status === 'paired')
    throw new PairingError(
      'already-paired',
      'This target is paired. Connect again to re-pair.',
      409,
    )

  // Only keys production may trust: approved, and not removed. A key still waiting for approval
  // (#28) never enters a pairing file, so re-pairing can't be used to get it trusted.
  const keys = ctx.db
    .query(
      `select p.id, p.public_key, p.alg, u.handle, u.id as user_id
         from passkeys p join users u on u.id = p.user_id
        where u.role = 'admin' and p.removed_at is null and p.approved_at is not null
        order by u.id, p.created_at, p.id`,
    )
    .all() as KeyRow[]
  const own = keys.filter((k) => k.user_id === user.id)
  if (own.length === 0)
    throw new PairingError('no-passkey', 'Register a passkey for your own account first.', 409)
  const add: TrustedKey[] = keys.map((k) => ({
    keyId: k.id,
    adminId: k.handle,
    alg: k.alg as TrustedKey['alg'],
    publicKey: k.public_key,
  }))

  // The rule is the app's own (governance), never the request's: a pairing can't lower it.
  const policy = currentPolicy(ctx)
  if (input.policy !== undefined) {
    const asked = parsePolicy(input.policy)
    if (!asked || !samePolicy(asked, policy))
      throw new PairingError(
        'policy-mismatch',
        'The pairing file carries the current rule. Change the rule in governance.',
        409,
      )
  }
  if (new Set(add.map((a) => a.adminId)).size < strictest(policy))
    throw new PairingError(
      'too-few-admins',
      'The rule needs more Admins with a passkey than there are.',
      409,
    )

  const now = nowOf(deps)
  const from = { sequence: row.last_sequence, release: row.last_release }
  const sequence = allocateSequence(ctx, target)
  const unsigned = {
    command: 'trust-keys',
    target,
    sequence,
    expires: new Date(now.getTime() + PAIRING_FILE_LIFETIME_MS).toISOString(),
    args: {
      genesis: true,
      add,
      pairing: {
        appOrigin: appUrl.origin,
        rpId: appUrl.hostname,
        target,
        appSigningKey: await appSigningPublicKey(ctx.dataDir),
        from,
      },
      policy: { ...policy },
    },
  }
  const fingerprint = await genesisFingerprint(unsigned)
  const challenge = await commandChallenge(unsigned)
  const pending: Pending = {
    unsigned,
    fingerprint,
    userId: user.id,
    keyIds: add.map((a) => a.keyId),
  }
  ctx.db
    .query(
      `update ${wizardTable(w.candidate)} set pending = ?, fingerprint = ?, status = 'prepared', updated_at = ? where target = ?`,
    )
    .run(JSON.stringify(pending), fingerprint, now.toISOString(), target)
  return {
    fingerprint,
    sequence,
    expires: unsigned.expires,
    admins: [...new Set(add.map((a) => a.adminId))],
    policy,
    // For navigator.credentials.get: the challenge is the exact bytes production verifies.
    assertion: {
      challenge: toB64u(challenge),
      rpId: appUrl.hostname,
      allowCredentials: own.map((k) => k.id),
      userVerification: 'required' as const,
    },
  }
}

function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * The confirming Admin's assertion. It is checked here exactly as production will check it
 * (acceptCommand on an empty state), so a bad file never reaches the inbox. On a re-pairing this
 * is where the target switches from the live pairing to the candidate.
 */
export async function confirmPairing(
  deps: PairingDeps,
  user: { id: number },
  target: string,
  assertion: unknown,
) {
  const { ctx } = deps
  const w = wizardOf(ctx, target)
  if (!w) throw new PairingError('unknown-target', `No target called ${target}`, 404)
  const { row } = w
  if (row.status !== 'prepared' || !row.pending)
    throw new PairingError('not-prepared', 'Prepare the pairing file first.', 409)
  const pending = JSON.parse(row.pending) as Pending
  if (pending.userId !== user.id)
    throw new PairingError('other-admin', 'The Admin who prepared the file must confirm it.', 409)

  const a = assertion as Record<string, unknown> | null
  const fields = ['adminKeyId', 'authenticatorData', 'clientDataJSON', 'signature'] as const
  if (
    typeof a !== 'object' ||
    a === null ||
    !fields.every((f) => typeof a[f] === 'string' && B64U.test(a[f] as string))
  )
    throw new PairingError('bad-assertion', 'The passkey answer is incomplete.')
  const adminKeyId = a.adminKeyId as string
  // Approved and not removed now, not only when the file was prepared.
  const mine = ctx.db
    .query(
      'select 1 from passkeys where id = ? and user_id = ? and approved_at is not null and removed_at is null',
    )
    .get(adminKeyId, user.id)
  if (!mine || !pending.keyIds.includes(adminKeyId))
    throw new PairingError('wrong-key', 'That passkey is not one of yours.')

  const signed = {
    ...pending.unsigned,
    signatures: [
      {
        by: 'admin-passkey',
        adminKeyId,
        authenticatorData: a.authenticatorData,
        clientDataJSON: a.clientDataJSON,
        signature: a.signature,
      },
    ],
  }
  const check = await acceptCommand(emptyState(), signed, {
    now: nowOf(deps),
    confirmedFingerprint: pending.fingerprint,
  })
  if (!check.ok)
    throw new PairingError(
      `refused-${check.code}`,
      `The passkey answer was not accepted (${check.code}).`,
    )

  const t = transportForSend(ctx, row)
  try {
    await t.putInbox(
      `cmd-${pending.unsigned.sequence}.json`,
      new TextEncoder().encode(JSON.stringify(signed)),
    )
  } catch (e) {
    if (e instanceof TransportError) throw new PairingError(`transport-${e.code}`, e.message, 502)
    throw e
  } finally {
    if (row.kind === 'sftp') await t.close()
  }
  const at = nowOf(deps).toISOString()
  if (w.candidate) {
    // The new genesis is out: the target moves to the candidate's host in one step.
    ctx.db.transaction(() => {
      ctx.db
        .query(
          `update deploy_targets set kind = ?, host = ?, port = ?, username = ?, inbox_dir = ?,
             outbox_dir = ?, host_fp_seen = ?, host_fp = ?, domains = ?, status = 'sent',
             pending = ?, fingerprint = ?, updated_at = ? where target = ?`,
        )
        .run(
          row.kind,
          row.host,
          row.port,
          row.username,
          row.inbox_dir,
          row.outbox_dir,
          row.host_fp_seen,
          row.host_fp,
          row.domains,
          row.pending,
          row.fingerprint,
          at,
          target,
        )
      ctx.db.query('delete from deploy_candidates where target = ?').run(target)
    })()
  } else {
    ctx.db
      .query("update deploy_targets set status = 'sent', updated_at = ? where target = ?")
      .run(at, target)
  }
  forget(ctx, target)
  return { fingerprint: pending.fingerprint, sequence: pending.unsigned.sequence as number }
}

/** A transport for the pairing file itself, to the host the Admin pinned in this wizard. */
function transportForSend(ctx: StoreContext, row: TargetRow): Transport {
  const pinned = row.host_fp ?? undefined
  return build(ctx, row, { get: () => pinned, set() {} })
}

/** Reads the heartbeat; once production says it is paired, so does the app. */
export async function refreshTarget(deps: PairingDeps, target: string) {
  const { ctx } = deps
  const t = transportFor(ctx, target)
  if (!t) throw new PairingError('not-sent', 'The pairing file has not been sent yet.', 409)
  let hb: Heartbeat | null
  try {
    hb = await readHeartbeat(t)
  } catch (e) {
    if (e instanceof TransportError) throw new PairingError(`transport-${e.code}`, e.message, 502)
    throw e
  }
  // The heartbeat is untrusted: it moves the status shown, never which keys count as approved
  // (only keys already approved go into a pairing file).
  if (hb?.paired) {
    ctx.db
      .query(
        "update deploy_targets set status = 'paired', pending = null, updated_at = ? where target = ? and status in ('sent', 'paired')",
      )
      .run(nowOf(deps).toISOString(), target)
  }
  return { target: viewOf(...viewArgs(ctx, target)), heartbeat: hb }
}
