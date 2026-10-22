// The outbox poller (docs/pending/m7-interfaces.md; decisions #1, #30; plan §13.4). Production
// writes its outbox; the app reads it over the transport and reports only what is new since the
// last poll, keeping a digest per file and target in SQLite.
//
// Production's outbox is untrusted data. Every file is size-capped and schema-checked; anything
// malformed or oversize is skipped (and remembered, so it isn't read again until it changes). The
// app never acts on a code or text from it beyond showing it and mapping known refusal codes.
import { sha256 } from '@site-studio/shared/bytes'
import { hex } from '@site-studio/shared/release'
import { onResult, onSmoke } from '../release/complete.ts'
import { notify } from '../release/inbox.ts'
import { pairedTargets, transportOf } from '../release/targets.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { Transport } from '../transport/types.ts'

export { notify }

export type OutboxEvent =
  | { kind: 'heartbeat'; target: string; at: string; body: unknown }
  | { kind: 'result'; target: string; name: string; ok: boolean; code?: string; body: unknown }
  | {
      kind: 'smoke'
      target: string
      release: number
      ok: boolean
      switchedBack: boolean
      body: unknown
    }
  | { kind: 'csr'; target: string; host: string; pem: string }

/** Per-file caps (bytes), and how many files one poll looks at. */
export const OUTBOX_CAPS = {
  heartbeat: 64 * 1024,
  result: 64 * 1024,
  smoke: 1024 * 1024,
  csr: 16 * 1024,
  files: 2000,
}

const HEARTBEAT = 'heartbeat.json'
const RESULT = /^results\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/
const SMOKE = /^smoke\/([1-9][0-9]{0,15})\.json$/
const CSR = /^csr\/([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)\.pem$/
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/
const PEM_CSR =
  /^-----BEGIN CERTIFICATE REQUEST-----\r?\n[A-Za-z0-9+/=\r\n]{1,12000}-----END CERTIFICATE REQUEST-----\r?\n?$/

const subscribers: ((e: OutboxEvent) => void | Promise<void>)[] = []

/** Called for every new event, after the app's own handling. A subscriber's error is contained. */
export function onOutbox(fn: (e: OutboxEvent) => void | Promise<void>): void {
  subscribers.push(fn)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const short = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null)

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

/** The heartbeat fields the app shows (contracts/heartbeat.schema.json plus #34's numbers). */
function heartbeatOf(v: unknown) {
  if (!isObj(v) || typeof v.at !== 'string' || !ISO_UTC.test(v.at)) return null
  const disk = isObj(v.disk) ? v.disk : {}
  const smoke = isObj(v.lastSmokeTest) ? v.lastSmokeTest : null
  return {
    at: v.at,
    agentVersion: short(v.agentVersion, 40) ?? null,
    target: short(v.target, 64) ?? null,
    site: short(v.site, 253) ?? null,
    paired: v.paired === true,
    frozen: v.frozen === true,
    activeRelease: count(v.activeRelease),
    previousRelease: count(v.previousRelease),
    keptReleases: Array.isArray(v.keptReleases)
      ? v.keptReleases
          .slice(0, 100)
          .map(count)
          .filter((n): n is number => n !== null)
      : [],
    highestRelease: count(v.highestRelease),
    lastSequence: count(v.lastSequence),
    disk: {
      usedBytes: count(disk.usedBytes),
      totalBytes: count(disk.totalBytes),
      freeBytes: count(disk.freeBytes),
    },
    lastSmokeTest: smoke
      ? {
          release: count(smoke.release),
          passed: smoke.passed === true,
          switchedBack: smoke.switchedBack === true,
          at: short(smoke.at, 40) ?? null,
        }
      : null,
    tls: v.tls === true,
  }
}

function resultOf(v: unknown, file: string) {
  if (!isObj(v) || typeof v.ok !== 'boolean') return null
  // The result must be about the file whose name it carries.
  const named = typeof v.file === 'string' ? v.file : ''
  if (named !== file && `${named}.json` !== file) return null
  if (v.code !== undefined && (typeof v.code !== 'string' || !CODE.test(v.code))) return null
  if (!v.ok && v.code === undefined) return null
  return {
    file: named,
    kind: short(v.kind, 20) ?? null,
    ok: v.ok,
    ...(typeof v.code === 'string' ? { code: v.code } : {}),
    detail: short(v.detail, 500) ?? null,
    at: short(v.at, 40) ?? null,
    release: count(v.release),
  }
}

function smokeOf(v: unknown, n: number) {
  if (!isObj(v) || v.release !== n || typeof v.passed !== 'boolean') return null
  const outcome = short(v.outcome, 40) ?? (v.passed ? 'passed' : 'failed')
  if (!CODE.test(outcome)) return null
  return {
    release: n,
    passed: v.passed,
    switchedBack: v.switchedBack === true,
    outcome,
    activeAfter: count(v.activeAfter),
    at: short(v.at, 40) ?? null,
  }
}

type Seen = { digest: string }

/** Reads what is new in one target's outbox. Each file is read once per version. */
export async function pollOutbox(
  ctx: StoreContext,
  target: string,
  t: Transport,
): Promise<OutboxEvent[]> {
  const names = (await t.listOutbox())
    .filter((n) => n === HEARTBEAT || RESULT.test(n) || SMOKE.test(n) || CSR.test(n))
    .slice(0, OUTBOX_CAPS.files)
  const events: OutboxEvent[] = []
  const seenStmt = ctx.db.query('select digest from outbox_seen where target = ? and name = ?')
  const remember = (name: string, digest: string, body: unknown) =>
    ctx.db
      .query(
        `insert into outbox_seen (target, name, digest, at, body) values (?, ?, ?, ?, ?)
         on conflict (target, name) do update set digest = excluded.digest, at = excluded.at, body = coalesce(excluded.body, outbox_seen.body)`,
      )
      .run(
        target,
        name,
        digest,
        new Date().toISOString(),
        body === undefined ? null : JSON.stringify(body),
      )

  for (const name of names) {
    let bytes: Uint8Array
    try {
      bytes = await t.readOutbox(name)
    } catch {
      continue // gone between the listing and the read; next poll
    }
    const cap =
      name === HEARTBEAT
        ? OUTBOX_CAPS.heartbeat
        : RESULT.test(name)
          ? OUTBOX_CAPS.result
          : SMOKE.test(name)
            ? OUTBOX_CAPS.smoke
            : OUTBOX_CAPS.csr
    const digest =
      bytes.length > cap ? `oversize:${bytes.length}` : hex(await sha256(new Uint8Array(bytes)))
    const before = seenStmt.get(target, name) as Seen | null
    if (before?.digest === digest) continue
    if (bytes.length > cap) {
      remember(name, digest, undefined)
      continue
    }

    if (name === HEARTBEAT) {
      const body = heartbeatOf(parseJson(bytes))
      remember(name, digest, body ?? undefined)
      if (body) events.push({ kind: 'heartbeat', target, at: body.at, body })
      continue
    }
    const result = RESULT.exec(name)
    if (result) {
      const file = result[1] as string
      const body = resultOf(parseJson(bytes), file)
      remember(name, digest, body ?? undefined)
      if (!body) continue
      // The inbox name: results/<name> for *.json, results/<name>.json for anything else.
      const inboxName = body.file
      onResult(ctx, target, inboxName, body.ok, body.code)
      events.push({
        kind: 'result',
        target,
        name: inboxName,
        ok: body.ok,
        ...(body.code ? { code: body.code } : {}),
        body,
      })
      continue
    }
    const smoke = SMOKE.exec(name)
    if (smoke) {
      const n = Number(smoke[1])
      const body = smokeOf(parseJson(bytes), n)
      remember(name, digest, body ?? undefined)
      if (!body) continue
      onSmoke(ctx, target, n, body)
      events.push({
        kind: 'smoke',
        target,
        release: n,
        ok: body.passed,
        switchedBack: body.switchedBack,
        body,
      })
      continue
    }
    const csr = CSR.exec(name)
    if (csr) {
      let pem = ''
      try {
        pem = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {}
      const ok = PEM_CSR.test(pem)
      remember(name, digest, undefined)
      if (ok) events.push({ kind: 'csr', target, host: csr[1] as string, pem })
    }
  }

  for (const e of events) {
    for (const fn of subscribers) {
      try {
        await fn(e)
      } catch {
        // one subscriber's failure must not stop the others or the poller
      }
    }
  }
  return events
}

/** Every paired target, one after the other; an unreachable one is skipped this time. */
export async function pollAll(ctx: StoreContext): Promise<OutboxEvent[]> {
  const out: OutboxEvent[] = []
  for (const target of pairedTargets(ctx)) {
    const t = transportOf(ctx, target)
    if (!t) continue
    try {
      out.push(...(await pollOutbox(ctx, target, t)))
    } catch {
      // unreachable now: health shows it from the heartbeat's age
    }
  }
  return out
}

/** The last heartbeat the poller accepted for a target (parsed, capped), and when it was read. */
export function lastHeartbeat(ctx: StoreContext, target: string) {
  const row = ctx.db
    .query('select body, at from outbox_seen where target = ? and name = ?')
    .get(target, HEARTBEAT) as { body: string | null; at: string } | null
  if (!row?.body) return null
  return { readAt: row.at, ...(JSON.parse(row.body) as ReturnType<typeof heartbeatOf> & object) }
}

let timer: ReturnType<typeof setInterval> | null = null

/** A background poll for the running app (not used by tests). */
export function startOutboxPolling(ctx: StoreContext, everyMs = 10_000) {
  if (timer) return
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    pollAll(ctx)
      .catch(() => {})
      .finally(() => {
        running = false
      })
  }, everyMs)
  timer.unref?.()
}
