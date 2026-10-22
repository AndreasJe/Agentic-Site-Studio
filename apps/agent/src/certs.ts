// Production's TLS key and certificates (decisions #3, plan §13.6). The key is made here at first
// start and never leaves state/; the app gets a CSR from the outbox, runs ACME, and sends the
// public certificate back as an app-signed `cert` command. A certificate is installed only when
// it is for this key and only for this site's names.
import 'reflect-metadata'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PemConverter,
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from '@peculiar/x509'
import { equalBytes } from '@site-studio/shared/bytes'
import type { Writer } from './fsx.ts'

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const
const MAX_PEM_BYTES = 64 * 1024
const MAX_CHAIN = 5
const SKEW_MS = 5 * 60_000

export type TlsKey = { keys: CryptoKeyPair; keyPem: string; spki: Uint8Array }

/** Loads the key from state/tls, or makes it on first start (private key mode 0600). */
export async function ensureKey(writer: Writer, tlsDir: string): Promise<TlsKey> {
  const keyFile = join(tlsDir, 'key.pem')
  const pubFile = join(tlsDir, 'public.pem')
  if (!existsSync(keyFile)) {
    const keys = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey)
    const spki = await crypto.subtle.exportKey('spki', keys.publicKey)
    writer.atomic(pubFile, PemConverter.encode(spki, 'PUBLIC KEY'))
    writer.atomic(keyFile, PemConverter.encode(pkcs8, 'PRIVATE KEY'), 0o600)
  }
  const keyPem = readFileSync(keyFile, 'utf8')
  const spki = new Uint8Array(PemConverter.decodeFirst(readFileSync(pubFile, 'utf8')))
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    PemConverter.decodeFirst(keyPem),
    EC,
    false,
    ['sign'],
  )
  const publicKey = await crypto.subtle.importKey('spki', spki, EC, true, ['verify'])
  return { keys: { privateKey, publicKey }, keyPem, spki }
}

/** A PKCS#10 request for these names, signed with production's own key. */
export async function makeCsr(key: TlsKey, names: string[]): Promise<string> {
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: `CN=${names[0]}`,
    keys: key.keys,
    signingAlgorithm: SIGNING,
    extensions: [
      new SubjectAlternativeNameExtension(names.map((n) => ({ type: 'dns' as const, value: n }))),
    ],
  })
  return csr.toString('pem')
}

export type CertCode =
  | 'cert-malformed'
  | 'cert-wrong-key'
  | 'cert-wrong-domain'
  | 'cert-expired'
  | 'cert-not-yet-valid'
  | 'cert-chain-broken'

export type CertCheck =
  | { ok: false; code: CertCode; detail?: string }
  | { ok: true; pem: string; names: string[]; notBefore: string; notAfter: string; serial: string }

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END CERTIFICATE-----/g

/**
 * A PEM chain, leaf first. The leaf's public key must be production's own; every name it
 * carries must be one of `domains` (a wildcard only if listed as one); it must be valid now; and
 * each certificate must be signed by the next one given.
 */
export async function checkCertificate(
  pem: string,
  key: TlsKey,
  domains: string[],
  now: Date,
): Promise<CertCheck> {
  const fail = (code: CertCode, detail?: string): CertCheck => ({ ok: false, code, detail })
  if (new TextEncoder().encode(pem).length > MAX_PEM_BYTES) return fail('cert-malformed', 'size')
  const blocks = [...pem.matchAll(PEM_BLOCK)].map((m) => m[0])
  if (blocks.length === 0 || blocks.length > MAX_CHAIN) return fail('cert-malformed', 'count')
  if (pem.replace(PEM_BLOCK, '').trim() !== '') return fail('cert-malformed', 'extra text')
  let chain: X509Certificate[]
  try {
    chain = blocks.map((b) => new X509Certificate(b))
  } catch (err) {
    return fail('cert-malformed', (err as Error).message)
  }
  const leaf = chain[0] as X509Certificate
  if (!equalBytes(new Uint8Array(leaf.publicKey.rawData), key.spki)) return fail('cert-wrong-key')

  const san = leaf.getExtension(SubjectAlternativeNameExtension)
  const items = san?.names.items ?? []
  if (items.length === 0) return fail('cert-wrong-domain', 'no subject alternative names')
  const allowed = new Set(domains.map((d) => d.toLowerCase()))
  const names: string[] = []
  for (const item of items) {
    const name = String(item.value).toLowerCase()
    if (item.type !== 'dns' || !allowed.has(name)) return fail('cert-wrong-domain', name)
    names.push(name)
  }

  if (leaf.notBefore.getTime() > now.getTime() + SKEW_MS) return fail('cert-not-yet-valid')
  if (leaf.notAfter.getTime() <= now.getTime()) return fail('cert-expired')
  for (let i = 0; i + 1 < chain.length; i++) {
    const child = chain[i] as X509Certificate
    const parent = chain[i + 1] as X509Certificate
    let ok = false
    try {
      ok = await child.verify({ publicKey: parent.publicKey, signatureOnly: true })
    } catch {}
    if (!ok) return fail('cert-chain-broken', `certificate ${i + 1}`)
  }
  return {
    ok: true,
    pem: `${chain.map((c) => c.toString('pem')).join('\n')}\n`,
    names,
    notBefore: leaf.notBefore.toISOString(),
    notAfter: leaf.notAfter.toISOString(),
    serial: leaf.serialNumber,
  }
}
