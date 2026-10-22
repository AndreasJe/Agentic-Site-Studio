// Model endpoints and roles (plan §15 "Routing", decisions #18 and #36; M8.2). Endpoints live in
// SQLite; the API key is sealed with the same AES-256-GCM box as the SMTP password and never
// leaves the server. The .env endpoint stays as the fallback until an Admin adds one.
import type { Database } from 'bun:sqlite'
import { lookup } from 'node:dns/promises'
import type { Capability, Endpoint } from '../llm/llm.ts'
import { LlmHttpError, LlmSchemaError, llm } from '../llm/llm.ts'
import { seal, unseal } from '../mail/settings.ts'
import type { StoreContext } from '../store/revisions.ts'

export const MODEL_ROLES = [
  'writer',
  'sorter',
  'critic',
  'analyst',
  'design',
  'suggestions',
] as const
export type ModelRole = (typeof MODEL_ROLES)[number]
export const isRole = (v: unknown): v is ModelRole => MODEL_ROLES.includes(v as ModelRole)
const CAPABILITIES: Capability[] = ['json_schema', 'json_object', 'none']

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'ModelError'
  }
}

type Row = {
  id: number
  name: string
  base_url: string
  model: string
  capability: Capability
  capability_override: number
  key_sealed: string | null
  created_by: string
  created_at: string
  tested_at: string | null
  last_test_ok: number | null
  last_test_error: string | null
}

/** What the API returns: never the key, only whether one is set. */
export type EndpointPublic = {
  id: number
  name: string
  baseUrl: string
  model: string
  capability: Capability
  capabilityOverride: boolean
  keySet: boolean
  createdBy: string
  createdAt: string
  testedAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
}

const pub = (r: Row): EndpointPublic => ({
  id: r.id,
  name: r.name,
  baseUrl: r.base_url,
  model: r.model,
  capability: r.capability,
  capabilityOverride: r.capability_override === 1,
  keySet: r.key_sealed !== null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  testedAt: r.tested_at,
  lastTestOk: r.last_test_ok === null ? null : r.last_test_ok === 1,
  lastTestError: r.last_test_error,
})

const rowOf = (db: Database, id: number) =>
  db.query('select * from model_endpoints where id = ?').get(id) as Row | null

export function listEndpoints(ctx: Pick<StoreContext, 'db'>): EndpointPublic[] {
  return (ctx.db.query('select * from model_endpoints order by id').all() as Row[]).map(pub)
}

type Body = Record<string, unknown>
const str = (v: unknown, what: string, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\r\n]/.test(v))
    throw new ModelError('bad-input', `${what} is required.`)
  return v.trim()
}
function baseUrl(v: unknown): string {
  const s = str(v, 'The base URL', 500)
  let u: URL | null = null
  try {
    u = new URL(s)
  } catch {}
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:'))
    throw new ModelError('bad-input', 'The base URL must start with http:// or https://.')
  if (u.username || u.password)
    throw new ModelError('bad-input', 'Keep the key out of the address.')
  return s.replace(/\/+$/, '')
}
function key(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string' || v.length > 1000 || /[\r\n]/.test(v))
    throw new ModelError('bad-input', 'The key is not valid.')
  return v
}
function capability(v: unknown): Capability {
  if (!CAPABILITIES.includes(v as Capability))
    throw new ModelError('bad-input', 'Capability is json_schema, json_object or none.')
  return v as Capability
}
const taken = (e: unknown) => {
  if (/UNIQUE/i.test((e as Error).message)) throw new ModelError('name-taken', 'That name is used.')
  throw e
}

/** `apiKey` text is sealed; it is never read back out through the API. */
export function addEndpoint(ctx: StoreContext, input: Body, by: string): EndpointPublic {
  const name = str(input.name, 'The name', 60)
  const k = key(input.apiKey)
  const given = input.capability !== undefined
  const cap = given ? capability(input.capability) : 'json_schema'
  try {
    const r = ctx.db
      .query(
        `insert into model_endpoints (name, base_url, model, capability, capability_override, key_sealed, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?) returning *`,
      )
      .get(
        name,
        baseUrl(input.baseUrl),
        str(input.model, 'The model', 200),
        cap,
        given ? 1 : 0,
        k ? seal(ctx.dataDir, k) : null,
        by,
        new Date().toISOString(),
      ) as Row
    return pub(r)
  } catch (e) {
    return taken(e)
  }
}

/** `apiKey`: undefined keeps the stored key, null (or "") removes it, text replaces it. */
export function updateEndpoint(ctx: StoreContext, id: number, input: Body): EndpointPublic {
  const cur = rowOf(ctx.db, id)
  if (!cur) throw new ModelError('not-found')
  const k = key(input.apiKey)
  const next = {
    name: input.name === undefined ? cur.name : str(input.name, 'The name', 60),
    base_url: input.baseUrl === undefined ? cur.base_url : baseUrl(input.baseUrl),
    model: input.model === undefined ? cur.model : str(input.model, 'The model', 200),
    capability: input.capability === undefined ? cur.capability : capability(input.capability),
    // An explicit capability is an Admin override; `capabilityOverride: false` hands it back to the test.
    override: input.capability === undefined ? cur.capability_override : 1,
    sealed: k === undefined ? cur.key_sealed : k === null ? null : seal(ctx.dataDir, k),
  }
  // The key belongs to the server it was entered for: a new origin drops it, unless a new key
  // comes in the same request (review finding 5).
  if (k === undefined && new URL(next.base_url).origin !== new URL(cur.base_url).origin)
    next.sealed = null
  if (input.capabilityOverride === false && input.capability === undefined) next.override = 0
  // Changing where or how we call it makes the last test stale.
  const moved =
    next.base_url !== cur.base_url || next.model !== cur.model || next.sealed !== cur.key_sealed
  try {
    ctx.db
      .query(
        `update model_endpoints set name = ?, base_url = ?, model = ?, capability = ?,
           capability_override = ?, key_sealed = ?,
           tested_at = case when ? then null else tested_at end,
           last_test_ok = case when ? then null else last_test_ok end,
           last_test_error = case when ? then null else last_test_error end
         where id = ?`,
      )
      .run(
        next.name,
        next.base_url,
        next.model,
        next.capability,
        next.override,
        next.sealed,
        moved ? 1 : 0,
        moved ? 1 : 0,
        moved ? 1 : 0,
        id,
      )
  } catch (e) {
    return taken(e)
  }
  return pub(rowOf(ctx.db, id) as Row)
}

export function deleteEndpoint(ctx: StoreContext, id: number): void {
  ctx.db.transaction(() => {
    ctx.db.query('delete from model_roles where endpoint_id = ?').run(id)
    if (ctx.db.query('delete from model_endpoints where id = ?').run(id).changes !== 1)
      throw new ModelError('not-found')
  })()
}

// --- roles -------------------------------------------------------------------------------------

export function roleMap(ctx: Pick<StoreContext, 'db'>): Record<ModelRole, number | null> {
  const out = Object.fromEntries(MODEL_ROLES.map((r) => [r, null])) as Record<
    ModelRole,
    number | null
  >
  for (const r of ctx.db.query('select role, endpoint_id from model_roles').all() as {
    role: string
    endpoint_id: number
  }[])
    if (isRole(r.role)) out[r.role] = r.endpoint_id
  return out
}

/** `endpointId` null clears the mapping, so the role falls back to the default. */
export function setRole(ctx: StoreContext, role: ModelRole, endpointId: number | null): void {
  if (endpointId === null) {
    ctx.db.query('delete from model_roles where role = ?').run(role)
    return
  }
  if (!rowOf(ctx.db, endpointId)) throw new ModelError('not-found', 'No such endpoint.')
  ctx.db
    .query(
      'insert into model_roles (role, endpoint_id) values (?, ?) on conflict (role) do update set endpoint_id = excluded.endpoint_id',
    )
    .run(role, endpointId)
}

// --- lookup ------------------------------------------------------------------------------------

function toEndpoint(ctx: Pick<StoreContext, 'dataDir'>, r: Row): Endpoint | null {
  let apiKey = ''
  if (r.key_sealed) {
    try {
      apiKey = unseal(ctx.dataDir, r.key_sealed)
    } catch {
      return null // unreadable (e.g. restored without the key file): treat as not configured
    }
  }
  return { name: r.name, baseUrl: r.base_url, apiKey, model: r.model, capability: r.capability }
}

/**
 * The endpoint for llm(). A mapped role wins; an unmapped role uses the first endpoint an Admin
 * added; with none added, the `.env` endpoint (`fallback`) is still the default. Never throws.
 */
export function endpointFor(
  ctx: Pick<StoreContext, 'db' | 'dataDir'>,
  role: ModelRole,
  fallback?: Endpoint,
): Endpoint | undefined {
  const mapped = ctx.db
    .query(
      'select e.* from model_roles r join model_endpoints e on e.id = r.endpoint_id where r.role = ?',
    )
    .get(role) as Row | null
  if (mapped) return toEndpoint(ctx, mapped) ?? fallback
  const first = ctx.db
    .query('select * from model_endpoints order by id limit 1')
    .get() as Row | null
  if (first) return toEndpoint(ctx, first) ?? fallback
  return fallback
}

// --- test connection ---------------------------------------------------------------------------

const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

export type TestResult = {
  ok: boolean
  detected: Capability | null
  capability: Capability
  override: boolean
  /** The HTTP status of the last answer, when there was one. */
  status: number | null
  /** 'blocked-host' when the address was not called at all. */
  refused: 'blocked-host' | null
  /** Written here from the status; never the server's own reply. */
  error: string | null
  latencyMs: number
}

export type TestOptions = {
  signal?: AbortSignal
  /** The `.env` endpoint's origin: set by whoever runs the app, so it may be a local one. */
  trustedOrigin?: string
  /** Tests only (createApp `testOnly`): the mock LLM listens on localhost. */
  localHosts?: boolean
}

// Cloud metadata services by name; their addresses are covered by blockedAddress.
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
])

function v4Blocked(a: number, b: number, c: number, d: number): boolean {
  return (
    a === 127 || // loopback
    a === 0 || // "this network": 0.0.0.0 reaches the host itself
    (a === 169 && b === 254) || // link-local, with 169.254.169.254 (cloud metadata)
    (a === 100 && b === 100 && c === 100 && d === 200) // Alibaba Cloud metadata
  )
}

const DOTTED = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** An IP literal as URL.hostname or DNS gives it (IPv6 with or without brackets). */
export function blockedAddress(ip: string): boolean {
  const v4 = new RegExp(`^${DOTTED.source}`).exec(ip)
  if (v4) {
    const [a, b, c, d] = v4.slice(1, 5).map(Number) as [number, number, number, number]
    return v4Blocked(a, b, c, d)
  }
  let text = ip.replace(/^\[|\]$/g, '').toLowerCase()
  if (!text.includes(':')) return false
  // A trailing dotted IPv4 becomes the last two groups.
  const tail = DOTTED.exec(text)
  if (tail) {
    const [a, b, c, d] = tail.slice(1, 5).map(Number) as [number, number, number, number]
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = text.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = rest ? rest.split(':') : []
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0')
  const g = [...left, ...fill, ...right].map((x) => Number.parseInt(x, 16))
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as number[] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  if ((g0 & 0xffc0) === 0xfe80) return true // link-local
  if (g0 === 0xfd00 && g1 === 0xec2 && !(g2 | g3 | g4 | g5 | g6) && g7 === 0x254) return true // AWS
  // ::, ::1, IPv4-mapped and IPv4-compatible, and NAT64 (64:ff9b::/96): judged by the IPv4 inside.
  const embedded =
    (!(g0 | g1 | g2 | g3 | g4) && (g5 === 0 || g5 === 0xffff)) ||
    (g0 === 0x64 && g1 === 0xff9b && !(g2 | g3 | g4 | g5))
  return embedded && v4Blocked(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff)
}

/**
 * Test connection never calls loopback, link-local or cloud metadata addresses (by name, by
 * literal, or by what the name resolves to now), except the `.env` endpoint's own origin.
 */
async function blockedHost(baseUrl: string, o: TestOptions): Promise<boolean> {
  if (o.localHosts) return false
  const url = new URL(baseUrl)
  if (o.trustedOrigin && url.origin === o.trustedOrigin) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || METADATA_HOSTS.has(host)) return true
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return blockedAddress(host)
  try {
    const found = await lookup(host, { all: true, verbatim: true })
    return found.some((a) => blockedAddress(a.address))
  } catch {
    return false // no such name: the call itself fails as "no connection"
  }
}

/**
 * Decision #50, item 13: the Test connection host rule applies when an endpoint is saved too, so
 * ordinary `llm()` calls never start out at a local, link-local or cloud metadata address. Checked
 * for a new endpoint, and for a base URL that changes; the `.env` endpoint's origin and the
 * tests-only local flag stay allowed (`o`, as for Test connection). DNS can still change its
 * answer after the save (accepted for now, as for Test connection).
 */
export async function checkEndpointSave(
  ctx: Pick<StoreContext, 'db'>,
  id: number | null,
  input: Body,
  o: TestOptions = {},
): Promise<void> {
  if (id !== null && input.baseUrl === undefined) return
  const next = baseUrl(input.baseUrl)
  if (id !== null) {
    const cur = rowOf(ctx.db, id)
    if (!cur) throw new ModelError('not-found')
    if (cur.base_url === next) return
  }
  if (await blockedHost(next, o))
    throw new ModelError(
      'blocked-host',
      'The base URL may not point at a local, link-local or cloud metadata address.',
    )
}

/** What the Admin sees: from the status alone, never the server's own words. */
function failureOf(e: unknown, signal?: AbortSignal): { status: number | null; error: string } {
  if (e instanceof LlmHttpError)
    return { status: e.status, error: `The server answered HTTP ${e.status}.` }
  if (e instanceof LlmSchemaError)
    return { status: null, error: 'The server answered, but not with the test reply.' }
  if (signal?.aborted) return { status: null, error: 'The test was stopped.' }
  return { status: null, error: 'No connection to the server.' }
}

/**
 * A tiny call: json_schema first, then json_object, then none (#36). A rejection (400/422) or a
 * reply that is not the probe object moves down a step; a bad key, a missing path, a server error
 * or no connection stops at once. The result is stored; an Admin override keeps its capability.
 * Only the status and the capability come back, never bytes of the reply.
 */
export async function testEndpoint(
  ctx: StoreContext,
  id: number,
  o: TestOptions = {},
): Promise<TestResult> {
  const row = rowOf(ctx.db, id)
  if (!row) throw new ModelError('not-found')
  const base = toEndpoint(ctx, row)
  const started = performance.now()
  let detected: Capability | null = null
  let error: string | null = null
  let status: number | null = null
  let refused: TestResult['refused'] = null
  if (!base) error = 'The stored key cannot be read. Enter it again.'
  else if (await blockedHost(base.baseUrl, o)) {
    refused = 'blocked-host'
    error = 'Test connection does not call local, link-local or cloud metadata addresses.'
  } else {
    for (const cap of CAPABILITIES) {
      try {
        await llm({
          endpoint: { ...base, capability: cap },
          schema: PROBE_SCHEMA,
          schemaName: 'connection_test',
          instructions: 'This is a connection test. Reply with {"ok": true}.',
          maxRetries: 0,
          maxTokens: 30,
          signal: o.signal,
          redirect: 'error',
        })
        detected = cap
        error = null
        status = 200
        break
      } catch (e) {
        const f = failureOf(e, o.signal)
        status = f.status
        error = f.error
        const rejected = e instanceof LlmHttpError && (e.status === 400 || e.status === 422)
        if (rejected || e instanceof LlmSchemaError) continue
        break
      }
    }
  }
  const ok = detected !== null
  const override = row.capability_override === 1
  const effective = override ? row.capability : (detected ?? row.capability)
  ctx.db
    .query(
      'update model_endpoints set tested_at = ?, last_test_ok = ?, last_test_error = ?, capability = ? where id = ?',
    )
    .run(new Date().toISOString(), ok ? 1 : 0, ok ? null : (error ?? 'failed'), effective, id)
  return {
    ok,
    detected,
    capability: effective,
    override,
    status,
    refused,
    error: ok ? null : error,
    latencyMs: Math.round(performance.now() - started),
  }
}
