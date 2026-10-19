// Registration and assertion checks. Fails closed: any parse error is a refusal, never a throw.
// Used by the app (Admin sign-in) and, offline, by the production agent (release signatures).
import { type Bytes, concat, equalBytes, fromBase64Url, sha256, utf8 } from '../bytes.ts'
import {
  type AuthenticatorData,
  type ClientData,
  parseAuthenticatorData,
  parseClientData,
} from './authdata.ts'
import { decodeCbor } from './cbor.ts'
import {
  type CoseAlg,
  coseAlgOf,
  importCoseKey,
  SUPPORTED_ALGS,
  verifyCoseSignature,
} from './cose.ts'

export type FailureCode =
  | 'malformed'
  | 'bad-type'
  | 'challenge-mismatch'
  | 'origin-mismatch'
  | 'cross-origin'
  | 'rpid-mismatch'
  | 'user-not-present'
  | 'user-not-verified'
  | 'unsupported-alg'
  | 'bad-signature'
  | 'counter-regressed'

export type Failure = { ok: false; code: FailureCode; detail?: string }

/** What the relying party stores after registration. */
export type Credential = { id: Bytes; publicKey: Bytes; alg: CoseAlg; signCount: number }

type Expected = { expectedChallenge: Bytes; expectedOrigin: string; rpId: string }

const fail = (code: FailureCode, detail?: string): Failure => ({ ok: false, code, detail })

async function checkCommon(
  clientDataJSON: Bytes,
  authenticatorData: Bytes,
  type: 'webauthn.create' | 'webauthn.get',
  e: Expected,
): Promise<Failure | { ok: true; client: ClientData; auth: AuthenticatorData }> {
  let client: ClientData
  let auth: AuthenticatorData
  let challenge: Bytes
  try {
    client = parseClientData(clientDataJSON)
    auth = parseAuthenticatorData(authenticatorData)
    challenge = fromBase64Url(client.challenge)
  } catch (err) {
    return fail('malformed', (err as Error).message)
  }
  if (client.type !== type) return fail('bad-type', client.type)
  if (!equalBytes(challenge, e.expectedChallenge)) return fail('challenge-mismatch')
  if (client.origin !== e.expectedOrigin) return fail('origin-mismatch', client.origin)
  if (client.crossOrigin === true) return fail('cross-origin')
  if (!equalBytes(auth.rpIdHash, await sha256(utf8.encode(e.rpId)))) return fail('rpid-mismatch')
  if (!auth.flags.up) return fail('user-not-present')
  if (!auth.flags.uv) return fail('user-not-verified')
  return { ok: true, client, auth }
}

export async function verifyRegistration(
  input: {
    attestationObject: Bytes
    clientDataJSON: Bytes
    allowedAlgs?: readonly CoseAlg[]
  } & Expected,
): Promise<Failure | { ok: true; credential: Credential; backupEligible: boolean }> {
  let authData: Bytes
  try {
    const att = decodeCbor(input.attestationObject)
    const raw = att instanceof Map ? att.get('authData') : undefined
    if (!(raw instanceof Uint8Array))
      return fail('malformed', 'attestation object without authData')
    authData = raw
  } catch (err) {
    return fail('malformed', (err as Error).message)
  }
  // The attestation statement is not checked: we request attestation "none" and trust comes from
  // the ceremony on our own origin, not from the authenticator's maker.
  const common = await checkCommon(input.clientDataJSON, authData, 'webauthn.create', input)
  if (!common.ok) return common
  const attested = common.auth.attested
  if (!attested) return fail('malformed', 'no attested credential data')

  const allowed: readonly number[] = input.allowedAlgs ?? SUPPORTED_ALGS
  let alg: number
  try {
    alg = coseAlgOf(attested.publicKey)
    if (!allowed.includes(alg)) return fail('unsupported-alg', String(alg))
    await importCoseKey(attested.publicKey) // rejects keys we could never verify with
  } catch (err) {
    return fail('unsupported-alg', (err as Error).message)
  }
  return {
    ok: true,
    credential: {
      id: attested.credentialId,
      publicKey: attested.publicKey,
      alg: alg as CoseAlg,
      signCount: common.auth.signCount,
    },
    backupEligible: common.auth.flags.be,
  }
}

export async function verifyAssertion(
  input: {
    credential: Credential
    authenticatorData: Bytes
    clientDataJSON: Bytes
    signature: Bytes
  } & Expected,
): Promise<Failure | { ok: true; signCount: number; backedUp: boolean }> {
  const common = await checkCommon(
    input.clientDataJSON,
    input.authenticatorData,
    'webauthn.get',
    input,
  )
  if (!common.ok) return common

  let valid: boolean
  try {
    const pk = await importCoseKey(input.credential.publicKey)
    if (pk.alg !== input.credential.alg)
      return fail('unsupported-alg', 'stored alg differs from key')
    const signed = concat(input.authenticatorData, await sha256(input.clientDataJSON))
    valid = await verifyCoseSignature(pk, input.signature, signed)
  } catch (err) {
    return fail('bad-signature', (err as Error).message)
  }
  if (!valid) return fail('bad-signature')

  // A counter of 0 means the authenticator doesn't count (synced passkeys): ignore it.
  const count = common.auth.signCount
  if (count !== 0 && count <= input.credential.signCount)
    return fail('counter-regressed', String(count))
  return { ok: true, signCount: count, backedUp: common.auth.flags.bs }
}
