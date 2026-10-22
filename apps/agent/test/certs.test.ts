// Certificates (decisions #3): production's own key, a CSR in the outbox, and an app-signed `cert`
// command that installs only a certificate for that key and this site's names.
import 'reflect-metadata'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  PemConverter,
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from '@peculiar/x509'
import { bundleOf, type Harness, harness, NOW, site } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.cleanup()
})

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const
const DAY = 24 * 3600_000

/** A local test CA, standing in for ACME (M7.6). */
async function testCa() {
  const keys = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  const cert = await X509CertificateGenerator.createSelfSigned({
    name: 'CN=Site Studio test CA',
    keys,
    notBefore: new Date(NOW.getTime() - DAY),
    notAfter: new Date(NOW.getTime() + 365 * DAY),
    signingAlgorithm: SIGNING,
  })
  return {
    cert,
    async issue(publicKey: CryptoKey, names: string[], days = 90, from = NOW) {
      const leaf = await X509CertificateGenerator.create({
        subject: `CN=${names[0]}`,
        issuer: cert.subject,
        publicKey,
        signingKey: keys.privateKey,
        notBefore: new Date(from.getTime() - 60_000),
        notAfter: new Date(from.getTime() + days * DAY),
        signingAlgorithm: SIGNING,
        extensions: [
          new SubjectAlternativeNameExtension(
            names.map((n) => ({ type: 'dns' as const, value: n })),
          ),
        ],
      })
      return `${leaf.toString('pem')}\n${cert.toString('pem')}\n`
    },
  }
}

/** Production's public key, as the app learns it: from the CSR in the outbox. */
async function keyFromCsr(h: Harness) {
  const csr = new Pkcs10CertificateRequest(
    readFileSync(join(h.outbox, 'csr/example.com.pem'), 'utf8'),
  )
  expect(await csr.verify()).toBe(true)
  const san = csr.getExtension('2.5.29.17') as SubjectAlternativeNameExtension | null
  expect(san?.names.items.map((i) => i.value)).toEqual(['example.com'])
  return await csr.publicKey.export(EC, ['verify'])
}

describe('certificates', () => {
  test('the key is made at first start and stays in state/; the CSR is in the outbox', async () => {
    h = await harness()
    const keyFile = join(h.root, 'agent', 'state', 'tls', 'key.pem')
    expect(readFileSync(keyFile, 'utf8')).toStartWith('-----BEGIN PRIVATE KEY-----')
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o077).toBe(0)
    const pub = readFileSync(join(h.root, 'agent', 'state', 'tls', 'public.pem'), 'utf8')
    const publicKey = await keyFromCsr(h)
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))
    expect(spki).toEqual(new Uint8Array(PemConverter.decodeFirst(pub)))
    // Nothing private in the outbox.
    for (const f of new Bun.Glob('**/*').scanSync(h.outbox)) {
      expect(readFileSync(join(h.outbox, f), 'utf8')).not.toContain('PRIVATE KEY')
    }
    expect(h.out('heartbeat.json').certificateRequests).toEqual(['csr/example.com.pem'])
    // A restart keeps the same key.
    await h.restart()
    const again = await keyFromCsr(h)
    expect(new Uint8Array(await crypto.subtle.exportKey('spki', again))).toEqual(spki)
    // The app can ask for the CSR again with its own signature.
    expect(await h.sendAppCommand({ command: 'csr' })).toMatchObject({
      ok: true,
      csr: 'csr/example.com.pem',
    })
  })

  test('a cert with the wrong key or domain is refused, and a good one is installed', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    const ca = await testCa()
    const ours = await keyFromCsr(h)

    const other = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
    expect(
      await h.sendAppCommand({
        command: 'cert',
        args: { certificate: await ca.issue(other.publicKey, ['example.com']) },
      }),
    ).toMatchObject({ ok: false, code: 'cert-wrong-key' })
    expect(
      await h.sendAppCommand({
        command: 'cert',
        args: { certificate: await ca.issue(ours, ['example.com', 'evil.example.net']) },
      }),
    ).toMatchObject({ ok: false, code: 'cert-wrong-domain', detail: 'evil.example.net' })
    // A wildcard is only allowed when the agent's domains list it.
    expect(
      await h.sendAppCommand({
        command: 'cert',
        args: { certificate: await ca.issue(ours, ['*.example.com']) },
      }),
    ).toMatchObject({ ok: false, code: 'cert-wrong-domain' })
    expect(
      await h.sendAppCommand({
        command: 'cert',
        args: {
          certificate: await ca.issue(
            ours,
            ['example.com'],
            90,
            new Date(NOW.getTime() - 100 * DAY),
          ),
        },
      }),
    ).toMatchObject({ ok: false, code: 'cert-expired' })
    expect(
      await h.sendAppCommand({ command: 'cert', args: { certificate: 'not a certificate' } }),
    ).toMatchObject({ ok: false, code: 'cert-malformed' })
    const good = await ca.issue(ours, ['example.com'])
    // The chain must hang together: a leaf followed by a CA that didn't sign it is refused.
    const strangerCa = await testCa()
    const broken = `${good.split('\n-----BEGIN CERTIFICATE-----')[0]}\n${strangerCa.cert.toString('pem')}\n`
    expect(
      await h.sendAppCommand({ command: 'cert', args: { certificate: broken } }),
    ).toMatchObject({ ok: false, code: 'cert-chain-broken' })
    // An Admin's passkey may sign one too; the app's key is just enough.
    expect(
      await h.sendCommand({ command: 'cert', args: { certificate: good } }, [h.alex]),
    ).toMatchObject({ ok: true })
    expect(h.agent.secure).toBe(true)

    const res = await h.get('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Home one')
    const installed = h.agent.snapshot().cert
    expect(installed).toMatchObject({ names: ['example.com'] })
    h.agent.heartbeat()
    expect(h.out('heartbeat.json')).toMatchObject({
      tls: true,
      certificate: { names: ['example.com'] },
    })

    // Renewal (around day 60) is the same app-signed step, with no passkey.
    h.clock.now = new Date(NOW.getTime() + 60 * DAY)
    const renewed = await ca.issue(ours, ['example.com'], 90, h.clock.now)
    const expires = new Date(h.clock.now.getTime() + 3600_000).toISOString()
    expect(
      await h.sendAppCommand({ command: 'cert', expires, args: { certificate: renewed } }),
    ).toMatchObject({ ok: true })
    expect(h.agent.snapshot().cert?.notAfter).not.toBe(installed?.notAfter)
    // Still serving over TLS after the reload, and after a restart.
    await h.restart()
    expect(h.agent.secure).toBe(true)
    expect((await h.get('/')).status).toBe(200)
  })

  test('a cert command signed by someone else is refused', async () => {
    h = await harness()
    const ca = await testCa()
    const good = await ca.issue(await keyFromCsr(h), ['example.com'])
    const sequence = ++h.sequence
    const signed = await h.app.sign({ sequence, command: 'cert', args: { certificate: good } })
    const forged = { ...signed, signatures: [{ by: 'app', value: 'A'.repeat(86) }] }
    h.put(`cmd-${sequence}.json`, JSON.stringify(forged))
    await h.scan()
    expect(h.result(`cmd-${sequence}.json`)).toMatchObject({ ok: false, code: 'bad-app-signature' })
    expect(h.agent.secure).toBe(false)
  })
})
