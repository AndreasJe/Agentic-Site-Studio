// Spike 1 page: register a passkey and sign in with it on http://localhost:3000 (rpId localhost).
// Ceremonies can be recorded as fixtures (spikes/01-passkey/fixtures) so real Windows Hello and
// password-manager passkeys become regression tests. Throwaway code; the verifier is the product.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Bytes, fromBase64Url, sha256, toBase64Url, utf8 } from '@site-studio/shared/bytes'
import {
  commandChallenge,
  genesisFingerprint,
  packageHashOf,
  releaseChallenge,
  type TrustedKey,
  writeBundle,
} from '@site-studio/shared/release'
import {
  type Credential,
  SUPPORTED_ALGS,
  verifyAssertion,
  verifyRegistration,
} from '@site-studio/shared/webauthn'

type Pending = {
  kind: 'register' | 'sign-in' | 'sign'
  challenge: Bytes
  name?: string
  expires: number
  /** What a 'sign' challenge is for: the unsigned command or release, and the bundle. */
  document?: Record<string, unknown>
  bundle?: Bytes
}
type Stored = { name: string; credential: Credential }

export type ServerOptions = {
  port: number
  origin: string
  rpId: string
  fixturesDir?: string
  /** Where signed commands, releases and bundles are written for the production process. */
  outDir?: string
  target?: string
}

const CHALLENGE_TTL_MS = 120_000
const PUBLIC = join(import.meta.dir, '../public')
const HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, 'content-type': 'application/json' },
  })

function field(body: unknown, ...path: string[]): string {
  let v: unknown = body
  for (const key of path)
    v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined
  if (typeof v !== 'string') throw new Error(`missing ${path.join('.')}`)
  return v
}

export function startServer(opts: ServerOptions) {
  const pending = new Map<string, Pending>()
  const credentials = new Map<string, Stored>()

  const take = (id: string, kind: Pending['kind']): Pending | null => {
    const p = pending.get(id)
    pending.delete(id) // single use, whatever the outcome
    if (!p || p.kind !== kind || p.expires < Date.now()) return null
    return p
  }

  const record = (label: string, data: Record<string, unknown>) => {
    if (!opts.fixturesDir || !/^[a-z0-9-]{1,40}$/.test(label)) return
    mkdirSync(opts.fixturesDir, { recursive: true })
    const file = join(opts.fixturesDir, `${label}-${data.kind}-${Date.now()}.json`)
    writeFileSync(
      file,
      `${JSON.stringify({ origin: opts.origin, rpId: opts.rpId, ...data }, null, 2)}\n`,
    )
  }

  const newChallenge = (
    p: Omit<Pending, 'challenge' | 'expires'>,
    challenge: Bytes = crypto.getRandomValues(new Uint8Array(32)),
  ) => {
    const id = crypto.randomUUID()
    pending.set(id, { ...p, challenge, expires: Date.now() + CHALLENGE_TTL_MS })
    return { id, challenge: toBase64Url(challenge) }
  }

  // The app's own signing key (freeze only) and command numbering, as the app would hold them.
  const target = opts.target ?? 'production'
  const appKeys = crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  let nextSequence = 1
  const out = (name: string, data: string | Bytes) => {
    if (!opts.outDir) throw new Error('no outDir')
    mkdirSync(opts.outDir, { recursive: true })
    writeFileSync(join(opts.outDir, name), data)
    return join(opts.outDir, name)
  }
  const appInfo = (async () => {
    const raw = await crypto.subtle.exportKey('raw', ((await appKeys) as CryptoKeyPair).publicKey)
    const info = {
      appSigningKey: toBase64Url(new Uint8Array(raw)),
      origin: opts.origin,
      rpId: opts.rpId,
      target,
    }
    if (opts.outDir) out('app.json', `${JSON.stringify(info, null, 2)}\n`)
    return info
  })()

  const signOptions = (challengeId: string, challenge: string) => ({
    challengeId,
    publicKey: {
      rpId: opts.rpId,
      challenge,
      allowCredentials: [...credentials.keys()].map((cid) => ({ type: 'public-key', id: cid })),
      userVerification: 'required',
      timeout: 60_000,
    },
  })

  async function api(path: string, body: unknown): Promise<Response> {
    if (path === '/api/register/options') {
      const name = field(body, 'name').trim().slice(0, 64) || 'admin'
      const { id, challenge } = newChallenge({ kind: 'register', name })
      return json({
        challengeId: id,
        publicKey: {
          rp: { id: opts.rpId, name: 'Site Studio spike 1' },
          user: {
            id: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
            name,
            displayName: name,
          },
          challenge,
          pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          attestation: 'none',
          timeout: 60_000,
        },
      })
    }

    if (path === '/api/register') {
      const p = take(field(body, 'challengeId'), 'register')
      if (!p) return json({ ok: false, code: 'challenge-expired' }, 400)
      const attestationObject = fromBase64Url(field(body, 'response', 'attestationObject'))
      const clientDataJSON = fromBase64Url(field(body, 'response', 'clientDataJSON'))
      const result = await verifyRegistration({
        attestationObject,
        clientDataJSON,
        expectedChallenge: p.challenge,
        expectedOrigin: opts.origin,
        rpId: opts.rpId,
      })
      if (!result.ok) return json(result, 400)
      // The credential ID comes from the client: never let a registration replace a stored key.
      const id = toBase64Url(result.credential.id)
      if (credentials.has(id)) return json({ ok: false, code: 'credential-exists' }, 409)
      credentials.set(id, { name: p.name ?? 'admin', credential: result.credential })
      record(String((body as { label?: unknown }).label ?? ''), {
        kind: 'register',
        challenge: toBase64Url(p.challenge),
        attestationObject: toBase64Url(attestationObject),
        clientDataJSON: toBase64Url(clientDataJSON),
      })
      return json({
        ok: true,
        credentialId: id,
        alg: result.credential.alg,
        backupEligible: result.backupEligible,
      })
    }

    if (path === '/api/sign-in/options') {
      const { id, challenge } = newChallenge({ kind: 'sign-in' })
      return json({
        challengeId: id,
        publicKey: {
          rpId: opts.rpId,
          challenge,
          allowCredentials: [...credentials.keys()].map((cid) => ({ type: 'public-key', id: cid })),
          userVerification: 'required',
          timeout: 60_000,
        },
      })
    }

    if (path === '/api/sign-in') {
      const p = take(field(body, 'challengeId'), 'sign-in')
      if (!p) return json({ ok: false, code: 'challenge-expired' }, 400)
      const stored = credentials.get(field(body, 'rawId'))
      if (!stored) return json({ ok: false, code: 'unknown-credential' }, 400)
      const authenticatorData = fromBase64Url(field(body, 'response', 'authenticatorData'))
      const clientDataJSON = fromBase64Url(field(body, 'response', 'clientDataJSON'))
      const signature = fromBase64Url(field(body, 'response', 'signature'))
      const before = { ...stored.credential }
      const result = await verifyAssertion({
        credential: stored.credential,
        authenticatorData,
        clientDataJSON,
        signature,
        expectedChallenge: p.challenge,
        expectedOrigin: opts.origin,
        rpId: opts.rpId,
      })
      if (!result.ok) return json(result, 400)
      stored.credential = { ...stored.credential, signCount: result.signCount }
      record(String((body as { label?: unknown }).label ?? ''), {
        kind: 'assertion',
        challenge: toBase64Url(p.challenge),
        credential: {
          id: toBase64Url(before.id),
          publicKey: toBase64Url(before.publicKey),
          alg: before.alg,
          signCount: before.signCount,
        },
        authenticatorData: toBase64Url(authenticatorData),
        clientDataJSON: toBase64Url(clientDataJSON),
        signature: toBase64Url(signature),
      })
      return json({
        ok: true,
        name: stored.name,
        signCount: result.signCount,
        backedUp: result.backedUp,
      })
    }

    if (path === '/api/pairing') return json(await appInfo)

    // The pairing keys file (decisions #25): every registered key, signed by one of them.
    if (path === '/api/sign/genesis') {
      const add: TrustedKey[] = [...credentials.entries()].map(([keyId, s]) => ({
        keyId,
        adminId: s.name,
        alg: s.credential.alg,
        publicKey: toBase64Url(s.credential.publicKey),
      }))
      if (add.length === 0) return json({ ok: false, code: 'no-keys-registered' }, 400)
      const document = {
        command: 'trust-keys',
        target,
        sequence: nextSequence++,
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        // Everything production will trust from the app, under one fingerprint (#31, #34).
        args: {
          genesis: true,
          add,
          pairing: {
            appOrigin: opts.origin,
            rpId: opts.rpId,
            target,
            appSigningKey: (await appInfo).appSigningKey,
            from: { sequence: 0, release: 0 },
          },
        },
      }
      const { id, challenge } = newChallenge(
        { kind: 'sign', document },
        await commandChallenge(document),
      )
      return json({
        ...signOptions(id, challenge),
        fingerprint: await genesisFingerprint(document),
      })
    }

    // A release (decisions #23): the challenge is the bundle hash and the release number.
    if (path === '/api/sign/release') {
      const releaseNumber = Number(field(body, 'releaseNumber'))
      if (!Number.isSafeInteger(releaseNumber) || releaseNumber < 1) {
        return json({ ok: false, code: 'bad-release-number' }, 400)
      }
      // The bundle names its own project, site, target and lifetime (decisions #27, #29).
      const bundle = writeBundle(
        {
          project: 'qualiwarego',
          site: 'example.com',
          target,
          revision: 'qualiwarego-r7',
          validUntil: new Date(Date.now() + 7 * 24 * 3600_000 - 600_000).toISOString(),
        },
        [
          {
            path: 'index.html',
            bytes: utf8.encode(
              `<!doctype html><title>Release ${releaseNumber}</title><p>Spike 1 demo bundle ${releaseNumber}</p>\n`,
            ),
          },
        ],
      )
      const document = {
        project: 'qualiwarego',
        revision: 'qualiwarego-r7',
        releaseNumber,
        packageHash: await packageHashOf(bundle),
        approvedBy: 'alex',
        checks: 'passed',
      }
      const { id, challenge } = newChallenge(
        { kind: 'sign', document, bundle },
        releaseChallenge(await sha256(bundle), releaseNumber),
      )
      return json(signOptions(id, challenge))
    }

    // Attach the passkey signature and hand the files to "production" (the outbox in spike 2).
    if (path === '/api/sign') {
      const p = take(field(body, 'challengeId'), 'sign')
      if (!p?.document) return json({ ok: false, code: 'challenge-expired' }, 400)
      const adminKeyId = field(body, 'rawId')
      if (!credentials.has(adminKeyId)) return json({ ok: false, code: 'unknown-credential' }, 400)
      const signature = {
        adminKeyId,
        authenticatorData: field(body, 'response', 'authenticatorData'),
        clientDataJSON: field(body, 'response', 'clientDataJSON'),
        signature: field(body, 'response', 'signature'),
      }
      if (p.bundle) {
        const n = p.document.releaseNumber as number
        const files = [
          out(
            `release-${n}.json`,
            `${JSON.stringify({ ...p.document, signatures: [signature] }, null, 2)}\n`,
          ),
          out(`bundle-${n}.bin`, p.bundle),
        ]
        return json({ ok: true, files })
      }
      const signed = { ...p.document, signatures: [{ by: 'admin-passkey', ...signature }] }
      const file = out(
        `command-${p.document.sequence}.json`,
        `${JSON.stringify(signed, null, 2)}\n`,
      )
      return json({ ok: true, files: [file], fingerprint: await genesisFingerprint(signed) })
    }

    return json({ ok: false, code: 'not-found' }, 404)
  }

  return Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        if (!['index.html', 'app.js', 'app.css'].includes(name)) return json({ ok: false }, 404)
        return new Response(Bun.file(join(PUBLIC, name)), { headers: HEADERS })
      }
      if (req.method !== 'POST') return json({ ok: false }, 405)
      if (req.headers.get('origin') !== opts.origin)
        return json({ ok: false, code: 'bad-origin' }, 403)
      try {
        return await api(url.pathname, await req.json())
      } catch (err) {
        return json({ ok: false, code: 'malformed', detail: (err as Error).message }, 400)
      }
    },
  })
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  const server = startServer({
    port,
    origin: `http://localhost:${port}`,
    rpId: 'localhost',
    fixturesDir: join(import.meta.dir, '../fixtures'),
    outDir: process.env.OUT_DIR ?? join(import.meta.dir, '../out'),
  })
  console.log(`listening on http://localhost:${server.port}`)
}
