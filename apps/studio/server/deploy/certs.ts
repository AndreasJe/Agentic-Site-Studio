// Certificates (M7.6; decisions #3, plan §13.6). Production makes its own key and a CSR in its
// outbox. The app gets a certificate from an `Issuer`, signs a `cert` command with its own key
// (no passkey: the private key never leaves production, and the agent checks the key, the names
// and the validity itself) and puts it in the inbox. Renewal is the same step, from the stored CSR,
// once two thirds of the validity are gone (day 60 of 90).
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { equalBytes } from '@site-studio/shared/bytes'
import { Client as AcmeClient } from 'acme-client'
import { type MailDeps, mailAdmins } from '../mail/send.ts'
import { sendAppCommand } from '../release/commands.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { Transport } from '../transport/types.ts'
import { defaultNotify, type Notify } from './hooks.ts'
import { getTarget, transportFor } from './pairing.ts'
import {
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from './x509.ts'

const DAY = 24 * 3600_000
/** Renewal when this share of the validity has passed: 60 of 90 days. */
export const RENEW_AT = 2 / 3
/** A warning goes to the Admins when a certificate still has not been renewed this close to its end. */
export const WARN_DAYS = 14
const RETRY_AFTER_FAILURE_MS = 3600_000
const MAX_CSR_BYTES = 16 * 1024
const MAX_CSR_FILES = 20

// ---- issuers -----------------------------------------------------------------------------

export type IssueRequest = { csrPem: string; names: string[]; now: Date }

export interface Issuer {
  readonly name: string
  /** A PEM chain, leaf first, for the key in the CSR and exactly these names. */
  issue(req: IssueRequest): Promise<string>
}

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const

/** A local CA, for tests and development. Never trusted by anything real. */
export class TestIssuer implements Issuer {
  readonly name = 'test-ca'
  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly ca: X509Certificate,
    private readonly validDays: number,
  ) {}

  static async create(opts: { now?: Date; validDays?: number } = {}) {
    const now = opts.now ?? new Date()
    const keys = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
    const ca = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=Site Studio test CA',
      keys,
      notBefore: new Date(now.getTime() - DAY),
      notAfter: new Date(now.getTime() + 3650 * DAY),
      signingAlgorithm: SIGNING,
    })
    return new TestIssuer(keys, ca, opts.validDays ?? 90)
  }

  get caPem(): string {
    return this.ca.toString('pem')
  }

  async issue({ csrPem, names, now }: IssueRequest): Promise<string> {
    const csr = new Pkcs10CertificateRequest(csrPem)
    if (!(await csr.verify())) throw new Error('the request is not signed by its own key')
    const leaf = await X509CertificateGenerator.create({
      subject: `CN=${names[0]}`,
      issuer: this.ca.subject,
      publicKey: csr.publicKey,
      signingKey: this.keys.privateKey,
      notBefore: new Date(now.getTime() - 60_000),
      notAfter: new Date(now.getTime() + this.validDays * DAY),
      signingAlgorithm: SIGNING,
      extensions: [
        new SubjectAlternativeNameExtension(names.map((n) => ({ type: 'dns' as const, value: n }))),
      ],
    })
    return `${leaf.toString('pem')}\n${this.ca.toString('pem')}\n`
  }
}

/** Where the DNS-01 answer goes. The real provider is [to be chosen]; none is built. */
export interface DnsProvider {
  setTxt(name: string, value: string): Promise<void>
  removeTxt(name: string, value: string): Promise<void>
}

type AcmeAuthz = { identifier: { type: string; value: string } }
type AcmeChallenge = { type: string }
export type AcmeClientLike = {
  auto(o: {
    csr: string
    email?: string
    termsOfServiceAgreed: boolean
    challengePriority: string[]
    challengeCreateFn: (a: AcmeAuthz, c: AcmeChallenge, keyAuth: string) => Promise<unknown>
    challengeRemoveFn: (a: AcmeAuthz, c: AcmeChallenge, keyAuth: string) => Promise<unknown>
  }): Promise<string>
}

export type AcmeOptions = {
  /** e.g. `acme.directory.letsencrypt.production`. */
  directoryUrl: string
  /** PEM of the ACME account key (see `loadAcmeAccountKey`). */
  accountKey: string
  email?: string
  dns: DnsProvider
  /** For tests: a stand-in for the real client. */
  makeClient?: (o: { directoryUrl: string; accountKey: string }) => AcmeClientLike
}

/**
 * ACME with the DNS-01 challenge (acme-client). Tested against a mock client only; real issuance
 * is pending DNS and the VM.
 */
export class AcmeIssuer implements Issuer {
  readonly name = 'acme'
  constructor(private readonly o: AcmeOptions) {}

  async issue({ csrPem }: IssueRequest): Promise<string> {
    const client: AcmeClientLike = this.o.makeClient
      ? this.o.makeClient({ directoryUrl: this.o.directoryUrl, accountKey: this.o.accountKey })
      : (new AcmeClient({
          directoryUrl: this.o.directoryUrl,
          accountKey: this.o.accountKey,
        }) as unknown as AcmeClientLike)
    const record = (a: AcmeAuthz) => `_acme-challenge.${a.identifier.value}`
    return await client.auto({
      csr: csrPem,
      email: this.o.email,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (a, c, keyAuth) => {
        if (c.type !== 'dns-01') throw new Error(`unexpected challenge ${c.type}`)
        await this.o.dns.setTxt(record(a), keyAuth)
      },
      challengeRemoveFn: async (a, c, keyAuth) => {
        if (c.type !== 'dns-01') return
        await this.o.dns.removeTxt(record(a), keyAuth)
      },
    })
  }
}

/** The ACME account key, made once and kept under DATA_DIR/keys (mode 0600). */
export function loadAcmeAccountKey(dataDir: string): string {
  const dir = join(dataDir, 'keys')
  const file = join(dir, 'acme-account.pem')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    try {
      writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  return readFileSync(file, 'utf8')
}

// ---- flow --------------------------------------------------------------------------------

export type CertDeps = {
  ctx: StoreContext
  /** Null: nothing can be issued; requests are recorded as failed ("no issuer"). */
  issuer: Issuer | null
  now?: () => Date
  notify?: Notify
  /** Without it no mail goes out (the in-app inbox still gets the notification). */
  mail?: MailDeps | null
}

export type CertOutcome =
  | { ok: true; target: string; host: string; notAfter: string; sequence: number }
  | { ok: false; reason: string }

type IssueRow = {
  id: number
  target: string
  host: string
  csr_hash: string
  csr_pem: string
  names: string
  issued_at: string | null
  not_after: string | null
  status: 'issued' | 'failed' | 'refused'
  error: string | null
  warned_at: string | null
  at: string
}

const nowOf = (d: CertDeps) => (d.now ?? (() => new Date()))()
const hashOf = (pem: string) => createHash('sha256').update(pem.trim()).digest('hex')
const SAFE_HOST = /^[A-Za-z0-9._-]{1,200}$/

/** A CSR from production's outbox is untrusted: parse it, check its signature, read its names. */
export async function parseCsr(pem: string) {
  if (typeof pem !== 'string' || pem.length > MAX_CSR_BYTES) throw new Error('csr too large')
  let csr: Pkcs10CertificateRequest
  try {
    csr = new Pkcs10CertificateRequest(pem)
  } catch {
    throw new Error('csr is not valid')
  }
  if (!(await csr.verify())) throw new Error('csr is not signed by its own key')
  const san = csr.getExtension('2.5.29.17') as SubjectAlternativeNameExtension | null
  const names = (san?.names.items ?? []).map((i) => String(i.value).toLowerCase())
  if (names.length === 0 || (san?.names.items ?? []).some((i) => i.type !== 'dns'))
    throw new Error('csr needs DNS names only')
  return { csr, names: [...new Set(names)] }
}

function record(
  deps: CertDeps,
  v: {
    target: string
    host: string
    csrPem: string
    names: string[]
    status: IssueRow['status']
    certPem?: string
    issuedAt?: string
    notAfter?: string
    error?: string
  },
) {
  deps.ctx.db
    .query(
      `insert into cert_issues
         (target, host, csr_hash, csr_pem, names, cert_pem, issued_at, not_after, status, error, at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      v.target,
      v.host,
      hashOf(v.csrPem),
      v.csrPem,
      JSON.stringify(v.names),
      v.certPem ?? null,
      v.issuedAt ?? null,
      v.notAfter ?? null,
      v.status,
      v.error?.slice(0, 300) ?? null,
      nowOf(deps).toISOString(),
    )
}

const allowedNames = (ctx: StoreContext, target: string): string[] =>
  JSON.parse(getTarget(ctx, target)?.domains ?? '[]') as string[]

/** Every name in the request must be one the Admin listed for the target (a wildcard only if listed). */
function namesAllowed(names: string[], allowed: string[]): boolean {
  const set = new Set(allowed.map((d) => d.toLowerCase()))
  return names.length > 0 && names.every((n) => set.has(n))
}

/** Issue for this CSR and send the `cert` command. Records the outcome either way. */
async function issueAndSend(
  deps: CertDeps,
  target: string,
  host: string,
  csrPem: string,
  names: string[],
): Promise<CertOutcome> {
  const notify = deps.notify ?? defaultNotify
  const fail = (reason: string): CertOutcome => {
    record(deps, { target, host, csrPem, names, status: 'failed', error: reason })
    notify(
      deps.ctx,
      'certificate',
      `${target}:${host}`,
      `Certificate for ${target} could not be issued`,
    )
    return { ok: false, reason }
  }
  if (!deps.issuer) return fail('no-issuer')
  let pem: string
  try {
    pem = await deps.issuer.issue({ csrPem, names, now: nowOf(deps) })
  } catch (e) {
    return fail(`issuer: ${(e as Error).message}`)
  }
  // Never forward a certificate that isn't for this key and these names: production would refuse
  // it, and an Issuer that answers with something else is a fault to see here.
  let leaf: X509Certificate
  try {
    leaf = new X509Certificate(pem.slice(0, pem.indexOf('-----END CERTIFICATE-----') + 25))
    const { csr } = await parseCsr(csrPem)
    if (!equalBytes(new Uint8Array(leaf.publicKey.rawData), new Uint8Array(csr.publicKey.rawData)))
      return fail('issuer returned a certificate for another key')
  } catch (e) {
    return fail(`issuer returned an unreadable certificate: ${(e as Error).message}`)
  }
  // Through the one command path (#26): the number from the target's counter, and any older
  // command still waiting for signatures is marked to be signed again.
  const sent = await sendAppCommand(
    deps.ctx,
    { now: () => nowOf(deps).getTime() },
    target,
    'cert',
    'app',
    { certificate: pem },
  )
  if (!sent.ok) return fail(`inbox: ${sent.code}`)
  const sequence = sent.sequence
  const notAfter = leaf.notAfter.toISOString()
  record(deps, {
    target,
    host,
    csrPem,
    names,
    status: 'issued',
    certPem: pem,
    issuedAt: nowOf(deps).toISOString(),
    notAfter,
  })
  return { ok: true, target, host, notAfter, sequence }
}

/**
 * A certificate request from production's outbox: parse it, check it is for the target's own
 * names, issue, and send the app-signed `cert` command. Idempotent per request.
 */
export async function handleCsr(
  deps: CertDeps,
  e: { target: string; host: string; pem: string },
  transport?: Transport | null,
): Promise<CertOutcome> {
  const { ctx } = deps
  const notify = deps.notify ?? defaultNotify
  const row = getTarget(ctx, e.target)
  if (!row || row.status !== 'paired') return { ok: false, reason: 'not-paired' }
  const t = transport ?? transportFor(ctx, e.target)
  if (!t) return { ok: false, reason: 'no-transport' }
  if (!SAFE_HOST.test(e.host)) return { ok: false, reason: 'bad-host' }

  const hash = hashOf(e.pem)
  const seen = ctx.db
    .query(
      'select id, status, at from cert_issues where target = ? and csr_hash = ? order by id desc limit 1',
    )
    .get(e.target, hash) as { id: number; status: string; at: string } | null
  if (seen) {
    if (seen.status !== 'failed') return { ok: false, reason: 'already-handled' }
    // A first issuance that failed is tried again later; a renewal is maintainCertificates' job.
    const has = ctx.db
      .query("select 1 from cert_issues where target = ? and host = ? and status = 'issued'")
      .get(e.target, e.host)
    if (has) return { ok: false, reason: 'already-handled' }
    if (nowOf(deps).getTime() - Date.parse(seen.at) < RETRY_AFTER_FAILURE_MS)
      return { ok: false, reason: 'retry-later' }
  }

  let parsed: Awaited<ReturnType<typeof parseCsr>>
  try {
    parsed = await parseCsr(e.pem)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
  if (!namesAllowed(parsed.names, allowedNames(ctx, e.target))) {
    record(deps, {
      target: e.target,
      host: e.host,
      csrPem: e.pem,
      names: parsed.names,
      status: 'refused',
      error: 'names are not in the target list',
    })
    notify(
      ctx,
      'certificate',
      `${e.target}:${e.host}`,
      `Certificate request from ${e.target} refused: wrong names`,
    )
    return { ok: false, reason: 'names-not-allowed' }
  }
  return issueAndSend(deps, e.target, e.host, e.pem, parsed.names)
}

/** Requests already waiting in the outbox (made at first start, before the pairing was done). */
async function scanCsrs(deps: CertDeps, target: string, t: Transport) {
  let names: string[]
  try {
    names = (await t.listOutbox('csr/')).slice(0, MAX_CSR_FILES)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.pem')) continue
    try {
      // Capped by the transport: an oversize request is refused without being read in full.
      const bytes = await t.readOutbox(name, MAX_CSR_BYTES)
      await handleCsr(
        deps,
        { target, host: name.slice(4, -4), pem: new TextDecoder().decode(bytes) },
        t,
      )
    } catch {
      // unreadable now; the next pass tries again
    }
  }
}

export type MaintenanceReport = {
  requested: string[]
  renewed: string[]
  warned: string[]
  failed: string[]
}

/**
 * One pass (an hourly timer, or the Deployment tab's button): pick up waiting requests, renew
 * certificates two thirds through their validity, and warn the Admins about any that is close to
 * its end and still not renewed. No passkey is involved.
 */
export async function maintainCertificates(deps: CertDeps): Promise<MaintenanceReport> {
  const { ctx } = deps
  const notify = deps.notify ?? defaultNotify
  const now = nowOf(deps)
  const report: MaintenanceReport = { requested: [], renewed: [], warned: [], failed: [] }
  const targets = ctx.db
    .query("select target from deploy_targets where status = 'paired'")
    .all() as {
    target: string
  }[]
  for (const { target } of targets) {
    const t = transportFor(ctx, target)
    if (!t) continue
    const before = (
      ctx.db.query('select count(*) as n from cert_issues where target = ?').get(target) as {
        n: number
      }
    ).n
    await scanCsrs(deps, target, t)
    const after = (
      ctx.db.query('select count(*) as n from cert_issues where target = ?').get(target) as {
        n: number
      }
    ).n
    if (after > before) report.requested.push(target)

    const hosts = ctx.db
      .query('select distinct host from cert_issues where target = ?')
      .all(target) as { host: string }[]
    for (const { host } of hosts) {
      const latest = ctx.db
        .query('select * from cert_issues where target = ? and host = ? order by id desc limit 1')
        .get(target, host) as IssueRow
      const issued = ctx.db
        .query(
          "select * from cert_issues where target = ? and host = ? and status = 'issued' order by id desc limit 1",
        )
        .get(target, host) as IssueRow | null
      if (!issued?.issued_at || !issued.not_after) continue

      const from = Date.parse(issued.issued_at)
      const to = Date.parse(issued.not_after)
      const due = from + (to - from) * RENEW_AT
      const retryOk =
        latest.status !== 'failed' ||
        now.getTime() - Date.parse(latest.at) >= RETRY_AFTER_FAILURE_MS
      if (now.getTime() >= due && retryOk) {
        const names = JSON.parse(issued.names) as string[]
        const r = await issueAndSend(deps, target, host, issued.csr_pem, names)
        if (r.ok) {
          report.renewed.push(`${target}/${host}`)
          continue
        }
        report.failed.push(`${target}/${host}`)
      }
      // The current certificate is nearly over and not renewed: tell the Admins once.
      const daysLeft = Math.floor((to - now.getTime()) / DAY)
      if (daysLeft <= WARN_DAYS && !issued.warned_at) {
        ctx.db
          .query('update cert_issues set warned_at = ? where id = ?')
          .run(now.toISOString(), issued.id)
        const names = JSON.parse(issued.names) as string[]
        notify(
          ctx,
          'certificate-expiry',
          `${target}:${host}`,
          `Certificate for ${target} expires in ${Math.max(0, daysLeft)} days`,
        )
        if (deps.mail) {
          await mailAdmins(ctx, deps.mail, {
            kind: 'certificate-expiry',
            target,
            names,
            notAfter: issued.not_after,
            daysLeft: Math.max(0, daysLeft),
          })
        }
        report.warned.push(`${target}/${host}`)
      }
    }
  }
  return report
}

/** The Deployment tab's list: what was issued, and when it ends. */
export function listCertificates(ctx: StoreContext) {
  return (
    ctx.db
      .query(
        `select target, host, names, issued_at, not_after, status, error, warned_at, at
           from cert_issues order by id desc limit 100`,
      )
      .all() as {
      target: string
      host: string
      names: string
      issued_at: string | null
      not_after: string | null
      status: string
      error: string | null
      warned_at: string | null
      at: string
    }[]
  ).map((r) => ({
    target: r.target,
    host: r.host,
    names: JSON.parse(r.names) as string[],
    issuedAt: r.issued_at,
    notAfter: r.not_after,
    status: r.status,
    error: r.error,
    warnedAt: r.warned_at,
    at: r.at,
  }))
}
