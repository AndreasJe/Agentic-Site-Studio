// Model endpoints and roles (plan §15 "Routing", decisions #18 and #36; M8.2). Endpoints live in
// SQLite; the API key is sealed with the same AES-256-GCM box as the SMTP password and never
// leaves the server. The .env endpoint stays as the fallback until an Admin adds one.
import type { Database } from 'bun:sqlite'
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
  if (input.capabilityOverride === false && input.capability === undefined) next.override = 0
  // Changing where or how we call it makes the last test stale.
  const moved = next.base_url !== cur.base_url || next.model !== cur.model || k !== undefined
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
  error: string | null
  latencyMs: number
}

/**
 * A tiny call: json_schema first, then json_object, then none (#36). A rejection (400/422) or a
 * reply that is not the probe object moves down a step; a bad key, a missing path, a server error
 * or no connection stops at once. The result is stored; an Admin override keeps its capability.
 */
export async function testEndpoint(
  ctx: StoreContext,
  id: number,
  signal?: AbortSignal,
): Promise<TestResult> {
  const row = rowOf(ctx.db, id)
  if (!row) throw new ModelError('not-found')
  const base = toEndpoint(ctx, row)
  const started = performance.now()
  let detected: Capability | null = null
  let error: string | null = null
  if (!base) error = 'The stored key cannot be read. Enter it again.'
  else {
    for (const cap of CAPABILITIES) {
      try {
        await llm({
          endpoint: { ...base, capability: cap },
          schema: PROBE_SCHEMA,
          schemaName: 'connection_test',
          instructions: 'This is a connection test. Reply with {"ok": true}.',
          maxRetries: 0,
          maxTokens: 30,
          signal,
        })
        detected = cap
        error = null
        break
      } catch (e) {
        error = (e as Error).message
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
    .run(
      new Date().toISOString(),
      ok ? 1 : 0,
      ok ? null : (error ?? 'failed').slice(0, 300),
      effective,
      id,
    )
  return {
    ok,
    detected,
    capability: effective,
    override,
    error: ok ? null : error,
    latencyMs: Math.round(performance.now() - started),
  }
}
