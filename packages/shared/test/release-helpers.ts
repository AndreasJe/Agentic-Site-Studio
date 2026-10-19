// Shared by the release-layer tests: Admins with software passkeys, signed commands and
// releases, and a paired production state.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { type Bytes, sha256, toBase64Url, utf8 } from '../src/bytes.ts'
import { type Manifest, writeBundle } from '../src/release/bundle.ts'
import { commandChallenge, releaseChallenge } from '../src/release/challenge.ts'
import {
  acceptCommand,
  emptyState,
  genesisFingerprint,
  type TrustedKey,
  type TrustState,
} from '../src/release/trust.ts'
import { verifyRegistration } from '../src/webauthn/index.ts'
import { SoftAuthenticator } from './soft-authenticator.ts'

export const APP = 'http://localhost:3000'
export const RP = 'localhost'
export const TARGET = 'production'
export const NOW = new Date('2026-10-19T12:00:00Z')
export const LATER = '2026-10-19T13:00:00Z'
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export const contract = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../../../contracts', name), 'utf8'))
export const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
export const validRelease = ajv.compile(contract('release.schema.json'))
export const validCommand = ajv.compile(contract('command.schema.json'))

export type Admin = { auth: SoftAuthenticator; key: TrustedKey }

export async function admin(adminId: string): Promise<Admin> {
  const auth = await SoftAuthenticator.create(-7)
  const c = crypto.getRandomValues(new Uint8Array(32))
  const reg = await verifyRegistration({
    ...(await auth.register({ challenge: c, origin: APP, rpId: RP })),
    expectedChallenge: c,
    expectedOrigin: APP,
    rpId: RP,
  })
  if (!reg.ok) throw new Error(reg.code)
  const key: TrustedKey = {
    keyId: toBase64Url(reg.credential.id),
    adminId,
    alg: reg.credential.alg,
    publicKey: toBase64Url(reg.credential.publicKey),
  }
  return { auth, key }
}

export type Over = { origin?: string; uv?: boolean }

export async function passkeySig(a: Admin, challenge: Bytes, over: Over = {}) {
  const s = await a.auth.assert({ challenge, origin: over.origin ?? APP, rpId: RP, uv: over.uv })
  return {
    adminKeyId: a.key.keyId,
    authenticatorData: toBase64Url(s.authenticatorData),
    clientDataJSON: toBase64Url(s.clientDataJSON),
    signature: toBase64Url(s.signature),
  }
}

export async function command(body: Record<string, unknown>, signers: Admin[], over: Over = {}) {
  const unsigned = { target: TARGET, expires: LATER, ...body }
  const ch = await commandChallenge(unsigned)
  const signatures = []
  for (const s of signers)
    signatures.push({ by: 'admin-passkey', ...(await passkeySig(s, ch, over)) })
  return { ...unsigned, signatures }
}

export async function release(
  bundle: Bytes,
  releaseNumber: number,
  signers: Admin[],
  extra = {},
  over: Over = {},
) {
  const hash = await sha256(bundle)
  const ch = releaseChallenge(hash, releaseNumber)
  const signatures = []
  for (const s of signers) signatures.push(await passkeySig(s, ch, over))
  return {
    project: 'qualiwarego',
    revision: 'qualiwarego-r7',
    releaseNumber,
    packageHash: `sha256:${hex(hash)}`,
    approvedBy: 'alex',
    checks: 'passed',
    ...extra,
    signatures,
  }
}

export async function appKey() {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  return {
    publicKey: toBase64Url(raw),
    sign: async (cmd: Record<string, unknown>) => {
      const unsigned = { target: TARGET, expires: LATER, ...cmd }
      const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        await commandChallenge(unsigned),
      )
      return { ...unsigned, signatures: [{ by: 'app', value: toBase64Url(new Uint8Array(sig)) }] }
    },
  }
}

export const pairingFor = (appSigningKey: string, from = { sequence: 0, release: 0 }) => ({
  appOrigin: APP,
  rpId: RP,
  target: TARGET,
  appSigningKey,
  from,
})

/** A paired production: genesis with the given Admins' keys, signed by the first, fingerprint confirmed. */
export async function paired(admins: Admin[], policy?: Record<string, number>) {
  const app = await appKey()
  const genesis = await command(
    {
      command: 'trust-keys',
      sequence: 1,
      args: {
        genesis: true,
        add: admins.map((a) => a.key),
        pairing: pairingFor(app.publicKey),
        ...(policy ? { policy } : {}),
      },
    },
    [admins[0] as Admin],
  )
  const r = await acceptCommand(emptyState(), genesis, {
    now: NOW,
    confirmedFingerprint: await genesisFingerprint(genesis),
  })
  if (!r.ok) throw new Error(`genesis refused: ${r.code}`)
  return { state: r.state, app, genesis }
}

export const ok = (r: { ok: boolean; code?: string }) => {
  if (!r.ok) throw new Error(`refused: ${r.code}`)
  return r as { ok: true; state: TrustState }
}

/** The clock production is told in these tests. */
export const AT = { now: NOW }

export const MANIFEST_DEFAULT: Manifest = {
  project: 'qualiwarego',
  site: 'example.com',
  target: TARGET,
  revision: 'qualiwarego-r7',
  validUntil: new Date(NOW.getTime() + 6 * 24 * 3600_000).toISOString(),
}

export const makeBundle = (
  text = '<html>release bundle bytes</html>',
  over: Partial<Manifest> = {},
) =>
  writeBundle({ ...MANIFEST_DEFAULT, ...over }, [{ path: 'index.html', bytes: utf8.encode(text) }])

export const bundle = makeBundle()
