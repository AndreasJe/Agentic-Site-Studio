// What production trusts and accepts (spike 1; decisions #1, #6, #23–#35). Pure functions over a
// state object the agent persists: no network, no clock of its own, and every refusal fails
// closed with a code instead of throwing.
import { type Bytes, fromBase64Url, sha256, toBase64Url, utf8 } from '../bytes.ts'
import {
  type CoseAlg,
  coseKeyIdentity,
  importCoseKey,
  isSmallOrderEd25519,
  SUPPORTED_ALGS,
} from '../webauthn/cose.ts'
import { type FailureCode, verifyAssertion } from '../webauthn/verify.ts'
import { BundleError, listEntries, readManifest } from './bundle.ts'
import { canonicalJson } from './canonical.ts'
import { commandChallenge, hex, releaseChallenge } from './challenge.ts'

/** A key as it travels in a trust-keys command (contracts/command.schema.json trustedKey). */
export type TrustedKey = { keyId: string; adminId: string; alg: CoseAlg; publicKey: string }

/** As production stores it: plus the key material, so one key can never count twice. */
export type StoredKey = TrustedKey & { identity: string }

/** The two-person rule (plan §13.9): how many different Admins must sign each kind of action. */
export type Policy = { releases: 1 | 2; keys: 1 | 2; domains: 1 | 2 }

/** What the pairing file installs (decisions #31, #34). Empty strings until paired. */
export type Pairing = { appOrigin: string; rpId: string; target: string; appSigningKey: string }

export type TrustState = Pairing & {
  keys: StoredKey[]
  /** Keys removed once are never trusted again (decisions #32). */
  revoked: { keyId: string; identity: string }[]
  counters: Record<string, number>
  policy: Policy
  highestRelease: number
  /** Accepted release number → its package and site: what activate may switch back to. */
  releases: Record<string, { packageHash: string; site: string }>
  lastSequence: number
  frozen: boolean
  activeRequest?: number
}

export type TrustCode =
  | FailureCode
  | 'wrong-target'
  | 'replayed'
  | 'expired'
  | 'too-long-lived'
  | 'frozen'
  | 'no-trusted-keys'
  | 'already-paired'
  | 'fingerprint-not-confirmed'
  | 'hash-mismatch'
  | 'manifest-mismatch'
  | 'release-number-not-higher'
  | 'number-jump'
  | 'unknown-release'
  | 'unknown-key'
  | 'revoked-key'
  | 'needs-key-owner'
  | 'duplicate-signer'
  | 'not-enough-signers'
  | 'passkey-required'
  | 'bad-app-signature'
  | 'duplicate-key'
  | 'would-remove-all-keys'
  | 'too-few-admins'
  | 'unknown-command'

export type Refusal = { ok: false; code: TrustCode; detail?: string }
export type Accepted = { ok: true; state: TrustState }

const DEFAULT_POLICY: Policy = { releases: 1, keys: 1, domains: 1 }
const COMMANDS = ['freeze', 'unfreeze', 'activate', 'trust-keys', 'remove-key', 'cert', 'csr']
const ALLOWED_ARGS: Record<string, string[]> = {
  freeze: [],
  unfreeze: [],
  activate: ['release'],
  'trust-keys': ['genesis', 'add', 'remove', 'policy', 'pairing'],
  // A trust-keys that only removes (#48): the same key rule, nothing added, the rule unchanged.
  'remove-key': ['remove'],
  // Certificates and certificate requests (#3, #48): the app's signature is enough, because the
  // private key never leaves production. What the certificate may be is checked by the agent.
  cert: ['certificate'],
  csr: [],
}
/** Commands the app's own key may sign alone: the safe direction (decisions #1, #3). */
const APP_SIGNABLE = new Set(['freeze', 'cert', 'csr'])
/** Numbers may only move forward by a bounded step, so one signed file can't use them all up. */
export const MAX_STEP = 1000
/** Decisions #29. A few minutes of clock difference between the app and production is allowed. */
export const MAX_COMMAND_LIFETIME_MS = 24 * 3600_000
export const MAX_RELEASE_VALIDITY_MS = 7 * 24 * 3600_000
export const CLOCK_SKEW_MS = 5 * 60_000
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/

const refuse = (code: TrustCode, detail?: string): Refusal => ({ ok: false, code, detail })
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isB64u = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v) && v.length % 4 !== 1
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
/** Re-encode so two spellings of the same bytes can never count as two keys. */
const canonicalB64u = (v: string) => toBase64Url(fromBase64Url(v))
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) =>
  Object.keys(o).every((k) => allowed.includes(k))
const adminCount = (keys: StoredKey[]) => new Set(keys.map((k) => k.adminId)).size
const strictest = (p: Policy) => Math.max(p.releases, p.keys, p.domains)

/** A time in the future, but not further than `max` (plus clock skew). */
function checkWindow(value: unknown, now: Date, max: number): Refusal | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value))
    return refuse('malformed', 'time must be ISO 8601 in UTC')
  const t = Date.parse(value)
  // The pattern alone lets through dates that don't exist (month 13): NaN must refuse, not pass.
  if (!Number.isFinite(t)) return refuse('malformed', 'time is not a real date')
  if (t <= now.getTime()) return refuse('expired')
  if (t > now.getTime() + max + CLOCK_SKEW_MS) return refuse('too-long-lived')
  return null
}

export function emptyState(): TrustState {
  return {
    appOrigin: '',
    rpId: '',
    target: '',
    appSigningKey: '',
    keys: [],
    revoked: [],
    counters: {},
    policy: DEFAULT_POLICY,
    highestRelease: 0,
    releases: {},
    lastSequence: 0,
    frozen: false,
  }
}

type PasskeySig = {
  adminKeyId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

function passkeySigOf(v: unknown): PasskeySig | null {
  if (!isObj(v)) return null
  const { adminKeyId, authenticatorData, clientDataJSON, signature } = v
  if (![adminKeyId, authenticatorData, clientDataJSON, signature].every(isB64u)) return null
  return { adminKeyId, authenticatorData, clientDataJSON, signature } as PasskeySig
}

async function parseKey(v: unknown): Promise<StoredKey | null> {
  if (!isObj(v) || !onlyKeys(v, ['keyId', 'adminId', 'alg', 'publicKey'])) return null
  const { keyId, adminId, alg, publicKey } = v
  if (!isB64u(keyId) || !isB64u(publicKey)) return null
  if (typeof adminId !== 'string' || adminId.length === 0) return null
  if (!(SUPPORTED_ALGS as readonly unknown[]).includes(alg)) return null
  try {
    const cose = fromBase64Url(publicKey)
    const pk = await importCoseKey(cose)
    if (pk.alg !== alg) return null
    return {
      keyId: canonicalB64u(keyId),
      adminId,
      alg: alg as CoseAlg,
      publicKey: canonicalB64u(publicKey),
      identity: coseKeyIdentity(cose),
    }
  } catch {
    return null
  }
}

function parsePairing(
  v: unknown,
): (Pairing & { from: { sequence: number; release: number } }) | null {
  if (!isObj(v) || !onlyKeys(v, ['appOrigin', 'rpId', 'target', 'appSigningKey', 'from']))
    return null
  const { appOrigin, rpId, target, appSigningKey, from } = v
  if (typeof appOrigin !== 'string' || typeof rpId !== 'string' || typeof target !== 'string')
    return null
  if (rpId.length === 0 || target.length === 0) return null
  try {
    const url = new URL(appOrigin)
    if (url.origin !== appOrigin) return null
    // Passkeys need HTTPS; plain HTTP only for local development on this machine.
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  } catch {
    return null
  }
  if (!isB64u(appSigningKey)) return null
  const raw = fromBase64Url(appSigningKey)
  if (raw.length !== 32 || isSmallOrderEd25519(raw)) return null
  if (!isObj(from) || !onlyKeys(from, ['sequence', 'release'])) return null
  if (!isCount(from.sequence) || !isCount(from.release)) return null
  return {
    appOrigin,
    rpId,
    target,
    appSigningKey: canonicalB64u(appSigningKey),
    from: { sequence: from.sequence, release: from.release },
  }
}

/** Adds keys one by one, refusing any ID or key material already present or revoked. */
async function addKeys(
  keys: StoredKey[],
  revoked: TrustState['revoked'],
  raw: unknown[],
): Promise<Refusal | StoredKey[]> {
  const out = [...keys]
  for (const item of raw) {
    const key = await parseKey(item)
    if (!key) return refuse('malformed', 'key to add')
    if (revoked.some((r) => r.keyId === key.keyId || r.identity === key.identity)) {
      return refuse('revoked-key', key.keyId)
    }
    if (out.some((k) => k.keyId === key.keyId || k.identity === key.identity)) {
      return refuse('duplicate-key', key.keyId)
    }
    out.push(key)
  }
  return out
}

function parsePolicy(v: unknown, base: Policy): Policy | null {
  if (v === undefined) return base
  if (!isObj(v)) return null
  const out: Policy = { ...base }
  for (const [k, n] of Object.entries(v)) {
    if (!Object.hasOwn(DEFAULT_POLICY, k) || (n !== 1 && n !== 2)) return null
    out[k as keyof Policy] = n
  }
  return out
}

/** Every listed signature must verify; distinct Admins among them must reach `needed`. */
async function verifyPasskeys(
  state: Pick<TrustState, 'appOrigin' | 'rpId' | 'counters'>,
  keys: StoredKey[],
  signatures: unknown,
  challenge: Bytes,
  needed: number,
): Promise<Refusal | { ok: true; counters: Record<string, number>; admins: Set<string> }> {
  if (!Array.isArray(signatures) || signatures.length === 0)
    return refuse('malformed', 'no signatures')
  const seen = new Set<string>()
  const admins = new Set<string>()
  const counters = { ...state.counters }
  for (const raw of signatures) {
    const sig = passkeySigOf(raw)
    if (!sig) return refuse('malformed', 'signature fields')
    const keyId = canonicalB64u(sig.adminKeyId)
    const key = keys.find((k) => k.keyId === keyId)
    if (!key) return refuse('unknown-key', keyId)
    if (seen.has(key.keyId) || seen.has(key.identity)) return refuse('duplicate-signer', keyId)
    seen.add(key.keyId).add(key.identity)
    const result = await verifyAssertion({
      credential: {
        id: fromBase64Url(key.keyId),
        publicKey: fromBase64Url(key.publicKey),
        alg: key.alg,
        signCount: counters[key.keyId] ?? 0,
      },
      authenticatorData: fromBase64Url(sig.authenticatorData),
      clientDataJSON: fromBase64Url(sig.clientDataJSON),
      signature: fromBase64Url(sig.signature),
      expectedChallenge: challenge,
      expectedOrigin: state.appOrigin,
      rpId: state.rpId,
    })
    if (!result.ok)
      return refuse(result.code, `${keyId}${result.detail ? `: ${result.detail}` : ''}`)
    counters[key.keyId] = result.signCount
    admins.add(key.adminId)
  }
  if (admins.size < needed) return refuse('not-enough-signers', `${admins.size} of ${needed}`)
  return { ok: true, counters, admins }
}

async function verifyAppSignature(state: TrustState, value: unknown, challenge: Bytes) {
  try {
    if (!isB64u(value)) return false
    const raw = fromBase64Url(state.appSigningKey)
    if (raw.length !== 32 || isSmallOrderEd25519(raw)) return false
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(value), challenge)
  } catch {
    return false
  }
}

/**
 * Shown on the production server at pairing, for a person to compare with the app: one
 * fingerprint over the keys, the rule and everything production will trust from the app
 * (decisions #25, #31, #34).
 */
export async function genesisFingerprint(command: unknown): Promise<string> {
  const args = isObj(command) && isObj(command.args) ? command.args : null
  if (!args || !Array.isArray(args.add)) throw new Error('not a trust-keys command with keys')
  const covered = { add: args.add, policy: args.policy ?? null, pairing: args.pairing ?? null }
  return `SHA256:${toBase64Url(await sha256(utf8.encode(canonicalJson(covered))))}`
}

export async function acceptRelease(
  state: TrustState,
  release: unknown,
  bundle: Bytes,
  opts: { now: Date },
): Promise<Refusal | Accepted> {
  try {
    if (!isObj(release)) return refuse('malformed', 'release is not an object')
    const { project, revision, approvedBy, checks, releaseNumber, packageHash, signatures } =
      release
    if (
      typeof project !== 'string' ||
      typeof revision !== 'string' ||
      typeof approvedBy !== 'string'
    ) {
      return refuse('malformed', 'project, revision or approvedBy')
    }
    if (release.contentOf !== undefined)
      return refuse('malformed', 'contentOf: rollback is activate now')
    if (checks !== 'passed') return refuse('malformed', 'checks must be passed')
    if (!isPositiveInt(releaseNumber)) return refuse('malformed', 'releaseNumber')
    if (typeof packageHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(packageHash)) {
      return refuse('malformed', 'packageHash')
    }
    if (state.keys.length === 0) return refuse('no-trusted-keys')
    if (state.frozen) return refuse('frozen')

    const hash = await sha256(bundle)
    if (packageHash !== `sha256:${hex(hash)}`) return refuse('hash-mismatch')
    // The manifest is inside the hashed bytes, so production acts on it, not on release.json.
    let manifest: ReturnType<typeof readManifest>
    try {
      // The whole archive must be well-formed before any of it is trusted, not just the manifest.
      listEntries(bundle)
      manifest = readManifest(bundle)
    } catch (err) {
      if (err instanceof BundleError || err instanceof SyntaxError) {
        return refuse('malformed', `bundle: ${err.message}`)
      }
      throw err
    }
    if (manifest.target !== state.target) return refuse('wrong-target', manifest.target)
    if (manifest.project !== project || manifest.revision !== revision)
      return refuse('manifest-mismatch')
    const window = checkWindow(manifest.validUntil, opts.now, MAX_RELEASE_VALIDITY_MS)
    if (window) return window
    if (releaseNumber <= state.highestRelease) {
      return refuse('release-number-not-higher', `${releaseNumber} after ${state.highestRelease}`)
    }
    if (releaseNumber > state.highestRelease + MAX_STEP) return refuse('number-jump')

    const signed = await verifyPasskeys(
      state,
      state.keys,
      signatures,
      releaseChallenge(hash, releaseNumber),
      state.policy.releases,
    )
    if (!signed.ok) return signed
    return {
      ok: true,
      state: {
        ...state,
        highestRelease: releaseNumber,
        releases: {
          ...state.releases,
          [String(releaseNumber)]: { packageHash, site: manifest.site },
        },
        counters: signed.counters,
      },
    }
  } catch (err) {
    return refuse('malformed', (err as Error).message)
  }
}

export async function acceptCommand(
  state: TrustState,
  command: unknown,
  opts: { now: Date; confirmedFingerprint?: string },
): Promise<Refusal | Accepted> {
  try {
    if (!isObj(command)) return refuse('malformed', 'command is not an object')
    const { command: name, target, sequence, expires, signatures, args } = command
    if (typeof name !== 'string' || typeof target !== 'string') {
      return refuse('malformed', 'command or target')
    }
    if (!isPositiveInt(sequence)) return refuse('malformed', 'sequence')
    if (!Array.isArray(signatures) || signatures.length === 0)
      return refuse('malformed', 'signatures')
    if (args !== undefined && !isObj(args)) return refuse('malformed', 'args')
    if (!COMMANDS.includes(name)) return refuse('unknown-command', name)
    if (args !== undefined && !onlyKeys(args, ALLOWED_ARGS[name] ?? [])) {
      return refuse('malformed', 'unknown args')
    }
    const window = checkWindow(expires, opts.now, MAX_COMMAND_LIFETIME_MS)
    if (window) return window

    const challenge = await commandChallenge(command)
    const allPasskeys = signatures.every((s) => isObj(s) && s.by === 'admin-passkey')

    if (name === 'trust-keys' && args?.genesis !== undefined) {
      if (args.genesis !== true) return refuse('malformed', 'genesis')
      if (state.keys.length > 0) return refuse('already-paired')
      if (!allPasskeys) return refuse('passkey-required')
      if (args.remove !== undefined || !Array.isArray(args.add) || args.add.length === 0) {
        return refuse('malformed', 'genesis needs keys to add and nothing to remove')
      }
      const pairing = parsePairing(args.pairing)
      if (!pairing) return refuse('malformed', 'pairing')
      if (target !== pairing.target) return refuse('wrong-target', target)
      if (sequence <= pairing.from.sequence) return refuse('replayed')
      if (sequence > pairing.from.sequence + MAX_STEP) return refuse('number-jump')
      const keys = await addKeys([], [], args.add)
      if (!Array.isArray(keys)) return keys
      const policy = parsePolicy(args.policy, DEFAULT_POLICY)
      if (!policy) return refuse('malformed', 'policy')
      if (adminCount(keys) < strictest(policy)) return refuse('too-few-admins')
      // Signed by a key the file itself contains: the confirming Admin's passkey, on the origin
      // the file names. The fingerprint check is what makes that origin trustworthy.
      const signed = await verifyPasskeys(
        { ...pairing, counters: {} },
        keys,
        signatures,
        challenge,
        1,
      )
      if (!signed.ok) return signed
      if (opts.confirmedFingerprint !== (await genesisFingerprint(command))) {
        return refuse('fingerprint-not-confirmed')
      }
      const { from, ...trusted } = pairing
      return {
        ok: true,
        state: {
          ...emptyState(),
          ...trusted,
          keys,
          policy,
          counters: signed.counters,
          lastSequence: sequence,
          highestRelease: from.release,
        },
      }
    }

    if (state.keys.length === 0) return refuse('no-trusted-keys')
    if (target !== state.target) return refuse('wrong-target', target)
    if (sequence <= state.lastSequence)
      return refuse('replayed', `${sequence} after ${state.lastSequence}`)
    if (sequence > state.lastSequence + MAX_STEP) return refuse('number-jump')
    const next = { ...state, lastSequence: sequence }

    if (APP_SIGNABLE.has(name)) {
      // The safe direction: the app's own key is enough, so it works fast (decisions #1).
      // Freeze is the only one that changes trust state; cert and csr are acted on by the agent.
      const frozen = name === 'freeze' ? true : state.frozen
      if (name === 'cert' && typeof args?.certificate !== 'string') {
        return refuse('malformed', 'certificate')
      }
      const only = signatures.length === 1 ? signatures[0] : undefined
      if (isObj(only) && only.by === 'app') {
        if (!(await verifyAppSignature(state, only.value, challenge)))
          return refuse('bad-app-signature')
        return { ok: true, state: { ...next, frozen } }
      }
      if (!allPasskeys) return refuse('malformed', 'mixed signature kinds')
      const signed = await verifyPasskeys(state, state.keys, signatures, challenge, 1)
      if (!signed.ok) return signed
      return { ok: true, state: { ...next, frozen, counters: signed.counters } }
    }

    if (!allPasskeys) return refuse('passkey-required')

    if (name === 'unfreeze') {
      const signed = await verifyPasskeys(state, state.keys, signatures, challenge, 1)
      if (!signed.ok) return signed
      return { ok: true, state: { ...next, frozen: false, counters: signed.counters } }
    }

    if (name === 'activate') {
      // Also the rollback (decisions #35): one Admin, to a release this host accepted.
      if (state.frozen) return refuse('frozen')
      const release = args?.release
      if (!isPositiveInt(release)) return refuse('malformed', 'release')
      if (state.releases[String(release)] === undefined) {
        return refuse('unknown-release', String(release))
      }
      const signed = await verifyPasskeys(state, state.keys, signatures, challenge, 1)
      if (!signed.ok) return signed
      return { ok: true, state: { ...next, activeRequest: release, counters: signed.counters } }
    }

    // trust-keys after pairing. Works while frozen, so a stolen key can be removed (decisions #33).
    if (args?.pairing !== undefined) return refuse('malformed', 'pairing only at genesis')
    if (name === 'remove-key' && (!Array.isArray(args?.remove) || args.remove.length === 0)) {
      return refuse('malformed', 'remove-key needs keys to remove')
    }
    const add = args?.add ?? []
    const remove = args?.remove ?? []
    if (!Array.isArray(add) || !Array.isArray(remove) || !remove.every(isB64u)) {
      return refuse('malformed', 'add or remove')
    }
    const policy = parsePolicy(args?.policy, state.policy)
    if (!policy) return refuse('malformed', 'policy')
    if (add.length === 0 && remove.length === 0 && args?.policy === undefined) {
      return refuse('malformed', 'trust-keys changes nothing')
    }
    // Signed per the current key rule; lowering any part needs that part's current rule too
    // (plan §13.9: "Lowering the rule needs the current rule").
    let needed: number = state.policy.keys
    for (const k of Object.keys(policy) as (keyof Policy)[]) {
      if (policy[k] < state.policy[k]) needed = Math.max(needed, state.policy[k])
    }
    const signed = await verifyPasskeys(state, state.keys, signatures, challenge, needed)
    if (!signed.ok) return signed

    const removing = new Set(remove.map(canonicalB64u))
    for (const id of removing) {
      if (!state.keys.some((k) => k.keyId === id)) {
        return refuse('unknown-key', `cannot remove ${id}`)
      }
    }
    const removed = state.keys.filter((k) => removing.has(k.keyId))
    const revoked = [
      ...state.revoked,
      ...removed.map(({ keyId, identity }) => ({ keyId, identity })),
    ]
    const kept = state.keys.filter((k) => !removing.has(k.keyId))
    const keys = await addKeys(kept, revoked, add)
    if (!Array.isArray(keys)) return keys

    // Decisions #28: an Admin adds keys for themselves; a key for a new Admin needs as many
    // different Admins as a release, so a release rule of two can't be bypassed.
    const existingAdmins = new Set(state.keys.map((k) => k.adminId))
    for (const key of keys.slice(kept.length)) {
      if (existingAdmins.has(key.adminId)) {
        if (!signed.admins.has(key.adminId)) return refuse('needs-key-owner', key.adminId)
      } else {
        // The strictest rule, so a second Admin can't be invented under any of them.
        const forNewAdmin = strictest(state.policy)
        if (signed.admins.size < forNewAdmin) {
          return refuse('not-enough-signers', `new Admin ${key.adminId} needs ${forNewAdmin}`)
        }
      }
    }

    if (keys.length === 0) return refuse('would-remove-all-keys')
    // Never leave fewer Admins than the rule needs, or production locks itself out.
    if (adminCount(keys) < strictest(policy)) return refuse('too-few-admins')
    const counters = Object.fromEntries(
      Object.entries(signed.counters).filter(([id]) => !removing.has(id)),
    )
    return { ok: true, state: { ...next, keys, revoked, policy, counters } }
  } catch (err) {
    return refuse('malformed', (err as Error).message)
  }
}
