// M7.6: certificates (decision #3). Production's agent makes its key and CSR; the app gets a
// certificate from an Issuer and sends an app-signed `cert` command; renewal at day 60 of 90.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signAppCommand } from '../server/deploy/app-key.ts'
import {
  type AcmeClientLike,
  AcmeIssuer,
  type CertDeps,
  handleCsr,
  type Issuer,
  listCertificates,
  maintainCertificates,
  RENEW_AT,
  TestIssuer,
  WARN_DAYS,
} from '../server/deploy/certs.ts'
import { allocateSequence, transportFor } from '../server/deploy/pairing.ts'
import {
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from '../server/deploy/x509.ts'
import { saveMailSettings } from '../server/mail/settings.ts'
import { openItems } from '../server/release/inbox.ts'
import { APP, NOW, pairProduction, type World, world } from './helpers/deploy-world.ts'
import { type SmtpSink, startSmtpSink, subjectOf } from './helpers/smtp-sink.ts'

const DAY = 24 * 3600_000
let w: World
let sink: SmtpSink | undefined
afterEach(async () => {
  await w?.cleanup()
  await sink?.close()
  sink = undefined
})

const deps = (over: Partial<CertDeps> = {}): CertDeps => ({
  ctx: w.ctx,
  issuer: w.issuer,
  now: () => w.clock.now,
  mail: { appOrigin: APP },
  ...over,
})
const result = (n: number) =>
  JSON.parse(readFileSync(join(w.sftp.outboxDir, `results/cmd-${n}.json`), 'utf8')) as {
    ok: boolean
    code?: string
  }
const advance = (ms: number) => {
  w.clock.now = new Date(w.clock.now.getTime() + ms)
}

describe('certificates', () => {
  test('a CSR from a real agent gets a certificate the agent installs (app-signed, no passkey)', async () => {
    w = await world()
    const r = await pairProduction(w)
    // Pairing's refresh picked up the CSR the agent made at first start.
    expect(r.refresh.body.target.status).toBe('paired')
    const issued = listCertificates(w.ctx)
    expect(issued).toHaveLength(1)
    expect(issued[0]).toMatchObject({ target: 'production', host: 'example.com', status: 'issued' })

    const file = JSON.parse(readFileSync(join(w.sftp.inboxDir, 'cmd-2.json'), 'utf8'))
    expect(file.command).toBe('cert')
    expect(file.signatures).toHaveLength(1)
    expect(file.signatures[0].by).toBe('app')

    await w.agent.scan()
    expect(result(2)).toMatchObject({ ok: true })
    const cert = w.agent.snapshot().cert
    expect(cert?.names).toEqual(['example.com'])
    expect(Date.parse(cert?.notAfter ?? '')).toBe(Date.parse(issued[0]?.notAfter ?? 'x'))
    expect(Date.parse(cert?.notAfter ?? '') - NOW.getTime()).toBeGreaterThan(89 * DAY)
    // The private key never left production: nothing in the inbox or the app's tables has it.
    for (const f of readdirSync(w.sftp.inboxDir))
      expect(readFileSync(join(w.sftp.inboxDir, f), 'utf8')).not.toContain('PRIVATE KEY')
    const dump = JSON.stringify(w.db.query('select * from cert_issues').all())
    expect(dump).not.toContain('PRIVATE KEY')
  })

  test('a certificate for another domain is refused by the agent', async () => {
    w = await world()
    await pairProduction(w)
    await w.agent.scan()
    const csr = readFileSync(join(w.sftp.outboxDir, 'csr/example.com.pem'), 'utf8')
    const pem = await (w.issuer as TestIssuer).issue({
      csrPem: csr,
      names: ['evil.example'],
      now: NOW,
    })
    const sequence = allocateSequence(w.ctx, 'production')
    const cmd = await signAppCommand(w.dataDir, {
      command: 'cert',
      target: 'production',
      sequence,
      expires: new Date(NOW.getTime() + 3600_000).toISOString(),
      args: { certificate: pem },
    })
    await transportFor(w.ctx, 'production')?.putInbox(
      `cmd-${sequence}.json`,
      new TextEncoder().encode(JSON.stringify(cmd)),
    )
    await w.agent.scan()
    expect(result(sequence)).toMatchObject({ ok: false, code: 'cert-wrong-domain' })
    // The installed certificate is still the right one.
    expect(w.agent.snapshot().cert?.names).toEqual(['example.com'])
  })

  test('the app itself refuses a request for names the target was not given', async () => {
    w = await world()
    await pairProduction(w)
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: 'CN=evil.example',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: 'evil.example' }])],
    })
    const before = readdirSync(w.sftp.inboxDir).length
    const r = await handleCsr(deps(), {
      target: 'production',
      host: 'evil.example',
      pem: csr.toString('pem'),
    })
    expect(r).toEqual({ ok: false, reason: 'names-not-allowed' })
    expect(readdirSync(w.sftp.inboxDir)).toHaveLength(before)
    expect(listCertificates(w.ctx)[0]).toMatchObject({ status: 'refused', host: 'evil.example' })
    expect(openItems(w.ctx).some((i) => i.kind === 'certificate')).toBe(true)
    // Garbage is not a request at all.
    expect(
      await handleCsr(deps(), { target: 'production', host: 'x', pem: 'nonsense' }),
    ).toMatchObject({ ok: false })
  })

  test('a request is handled once; not at all before the target is paired', async () => {
    w = await world()
    const pem = readFileSync(join(w.sftp.outboxDir, 'csr/example.com.pem'), 'utf8')
    expect(await handleCsr(deps(), { target: 'production', host: 'example.com', pem })).toEqual({
      ok: false,
      reason: 'not-paired',
    })
    await pairProduction(w)
    expect(listCertificates(w.ctx)).toHaveLength(1)
    expect(await handleCsr(deps(), { target: 'production', host: 'example.com', pem })).toEqual({
      ok: false,
      reason: 'already-handled',
    })
    expect(listCertificates(w.ctx)).toHaveLength(1)
  })

  test('renewal starts at day 60 of 90 and needs no passkey', async () => {
    w = await world()
    await pairProduction(w)
    await w.agent.scan()
    expect(RENEW_AT).toBeCloseTo(2 / 3, 10)
    const first = w.agent.snapshot().cert
    const inboxBefore = readdirSync(w.sftp.inboxDir).length

    advance(59 * DAY)
    w.clock.now = new Date(w.clock.now.getTime() + 20 * 3600_000) // 59 days 20 hours
    let rep = await maintainCertificates(deps())
    expect(rep.renewed).toEqual([])
    expect(readdirSync(w.sftp.inboxDir)).toHaveLength(inboxBefore)

    advance(4 * 3600_000 + 60_000) // 60 days and a minute
    rep = await maintainCertificates(deps())
    expect(rep.renewed).toEqual(['production/example.com'])
    const newest = readdirSync(w.sftp.inboxDir).sort().at(-1) ?? ''
    const cmd = JSON.parse(readFileSync(join(w.sftp.inboxDir, newest), 'utf8'))
    expect(cmd.command).toBe('cert')
    expect(cmd.signatures.map((s: { by: string }) => s.by)).toEqual(['app'])

    await w.agent.scan()
    const renewed = w.agent.snapshot().cert
    expect(renewed?.serial).not.toBe(first?.serial)
    expect(Date.parse(renewed?.notAfter ?? '') - Date.parse(first?.notAfter ?? '')).toBeGreaterThan(
      59 * DAY,
    )

    // Not again straight away.
    rep = await maintainCertificates(deps())
    expect(rep.renewed).toEqual([])
  })

  test('a failed renewal is retried later, and a nearly expired certificate warns the Admins by notification and mail', async () => {
    w = await world()
    sink = await startSmtpSink()
    saveMailSettings(w.ctx, {
      host: '127.0.0.1',
      port: sink.port,
      security: 'none',
      user: '',
      from: 'studio@example.test',
    })
    w.db.query("update users set email = handle || '@example.test' where role = 'admin'").run()
    await pairProduction(w)
    await w.agent.scan()

    const failing: Issuer = {
      name: 'failing',
      issue: async () => {
        throw new Error('dns not ready')
      },
    }
    advance(61 * DAY)
    let rep = await maintainCertificates(deps({ issuer: failing }))
    expect(rep.failed).toEqual(['production/example.com'])
    expect(rep.warned).toEqual([]) // 29 days left: not yet
    expect(listCertificates(w.ctx)[0]).toMatchObject({ status: 'failed' })
    // Within the hour it is not hammered.
    rep = await maintainCertificates(deps({ issuer: failing }))
    expect(rep.failed).toEqual([])

    expect(WARN_DAYS).toBe(14)
    advance(16 * DAY) // day 77 of 90: 13 days left
    rep = await maintainCertificates(deps({ issuer: failing }))
    expect(rep.warned).toEqual(['production/example.com'])
    const items = openItems(w.ctx).filter((i) => i.kind === 'certificate-expiry')
    expect(items).toHaveLength(1)
    expect(sink.messages).toHaveLength(2)
    expect(sink.messages.map((m) => m.to[0]).sort()).toEqual([
      'admina@example.test',
      'adminb@example.test',
    ])
    expect(subjectOf(sink.messages[0]?.data ?? '')).toContain('expires in 13 days')

    // Once only.
    rep = await maintainCertificates(deps({ issuer: failing }))
    expect(rep.warned).toEqual([])
    expect(sink.messages).toHaveLength(2)

    // And a working issuer renews it after all.
    advance(2 * 3600_000)
    rep = await maintainCertificates(deps())
    expect(rep.renewed).toEqual(['production/example.com'])
    await w.agent.scan()
    expect(w.agent.snapshot().cert?.notAfter).toBe(
      listCertificates(w.ctx).find((c) => c.status === 'issued')?.notAfter ?? 'x',
    )
  })

  test('with no issuer a request is recorded as failed and the Admins see it', async () => {
    w = await world({ issuer: null })
    await pairProduction(w)
    const [row] = listCertificates(w.ctx)
    expect(row).toMatchObject({ status: 'failed', error: 'no-issuer' })
    expect(openItems(w.ctx).some((i) => i.kind === 'certificate')).toBe(true)
    expect(existsSync(join(w.sftp.inboxDir, 'cmd-2.json'))).toBe(false)
  })

  test('an Issuer that answers with a certificate for another key is not forwarded', async () => {
    w = await world()
    const other = await TestIssuer.create({ now: NOW })
    const wrongKey: Issuer = {
      name: 'wrong-key',
      issue: async ({ names, now }) => {
        const keys = (await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign', 'verify'],
        )) as CryptoKeyPair
        const csr = await Pkcs10CertificateRequestGenerator.create({
          name: `CN=${names[0]}`,
          keys,
          signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
          extensions: [
            new SubjectAlternativeNameExtension(
              names.map((n) => ({ type: 'dns' as const, value: n })),
            ),
          ],
        })
        return other.issue({ csrPem: csr.toString('pem'), names, now })
      },
    }
    await pairProduction(w)
    // pairing already used the working issuer through the routes; start over with the bad one
    w.db.query('delete from cert_issues').run()
    const pem = readFileSync(join(w.sftp.outboxDir, 'csr/example.com.pem'), 'utf8')
    const before = readdirSync(w.sftp.inboxDir).length
    const r = await handleCsr(deps({ issuer: wrongKey }), {
      target: 'production',
      host: 'example.com',
      pem,
    })
    expect(r).toMatchObject({ ok: false })
    expect(readdirSync(w.sftp.inboxDir)).toHaveLength(before)
    expect(listCertificates(w.ctx)[0]?.error).toContain('another key')
  })
})

describe('AcmeIssuer (mocked client; real issuance is pending DNS and the VM)', () => {
  const csrPem = '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n'

  test('answers DNS-01 through the DNS provider and returns what the client returns', async () => {
    const calls: string[] = []
    const dns = {
      setTxt: async (n: string, v: string) => void calls.push(`set ${n} ${v}`),
      removeTxt: async (n: string, v: string) => void calls.push(`remove ${n} ${v}`),
    }
    let seen: Parameters<AcmeClientLike['auto']>[0] | undefined
    const client: AcmeClientLike = {
      auto: async (o) => {
        seen = o
        const authz = { identifier: { type: 'dns', value: 'example.com' } }
        await o.challengeCreateFn(authz, { type: 'dns-01' }, 'KEYAUTH')
        await o.challengeRemoveFn(authz, { type: 'dns-01' }, 'KEYAUTH')
        return 'CHAIN'
      },
    }
    const issuer = new AcmeIssuer({
      directoryUrl: 'https://acme.test/dir',
      accountKey: 'KEY',
      email: 'ops@example.test',
      dns,
      makeClient: (o) => {
        expect(o).toEqual({ directoryUrl: 'https://acme.test/dir', accountKey: 'KEY' })
        return client
      },
    })
    expect(await issuer.issue({ csrPem, names: ['example.com'], now: NOW })).toBe('CHAIN')
    expect(calls).toEqual([
      'set _acme-challenge.example.com KEYAUTH',
      'remove _acme-challenge.example.com KEYAUTH',
    ])
    expect(seen?.challengePriority).toEqual(['dns-01'])
    expect(seen?.csr).toBe(csrPem)
    expect(seen?.termsOfServiceAgreed).toBe(true)
  })

  test('refuses any other kind of challenge, and passes the client error on', async () => {
    const dns = { setTxt: async () => {}, removeTxt: async () => {} }
    const http: AcmeClientLike = {
      auto: async (o) => {
        await o.challengeCreateFn(
          { identifier: { type: 'dns', value: 'a.example.com' } },
          { type: 'http-01' },
          'x',
        )
        return 'never'
      },
    }
    const a = new AcmeIssuer({ directoryUrl: 'u', accountKey: 'k', dns, makeClient: () => http })
    await expect(a.issue({ csrPem, names: ['a.example.com'], now: NOW })).rejects.toThrow(
      'unexpected challenge',
    )
    const down: AcmeClientLike = {
      auto: async () => {
        throw new Error('directory unreachable')
      },
    }
    const b = new AcmeIssuer({ directoryUrl: 'u', accountKey: 'k', dns, makeClient: () => down })
    await expect(b.issue({ csrPem, names: ['a.example.com'], now: NOW })).rejects.toThrow(
      'directory unreachable',
    )
  })

  test('the test CA issues a chain the way the agent expects, for exactly the names given', async () => {
    const ca = await TestIssuer.create({ now: NOW })
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: 'CN=a.example.com',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: 'a.example.com' }])],
    })
    const pem = await ca.issue({ csrPem: csr.toString('pem'), names: ['a.example.com'], now: NOW })
    const leaf = new X509Certificate(pem.slice(0, pem.indexOf('-----END CERTIFICATE-----') + 25))
    expect(leaf.notAfter.getTime() - leaf.notBefore.getTime()).toBeGreaterThan(89 * DAY)
  })
})

describe('M7 security review', () => {
  test('a cert command goes through the one command path: an older unsent command must be signed again (finding 8)', async () => {
    w = await world()
    const r = await pairProduction(w)
    const unfreeze = await r.admin.call('POST', '/api/admin/commands/production/unfreeze')
    expect(unfreeze.status).toBe(201)
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: 'CN=example.com',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: 'example.com' }])],
    })
    const out = await handleCsr(deps(), {
      target: 'production',
      host: 'www',
      pem: csr.toString('pem'),
    })
    expect(out).toMatchObject({ ok: true })
    const rows = w.db
      .query('select id, purpose, status, outcome, number from signing_requests order by id')
      .all() as { id: number; purpose: string; status: string; outcome: string | null }[]
    expect(rows.find((x) => x.id === unfreeze.body.signingId)).toMatchObject({
      status: 'stale',
      outcome: 'overtaken',
    })
    expect(rows.filter((x) => x.purpose === 'cert').at(-1)).toMatchObject({
      status: 'sent',
      number: (out as { sequence: number }).sequence,
    })
  })
})
