// Spike 1 page: register a passkey and sign in with it on http://localhost:3000 (rpId localhost).
// Ceremonies can be recorded as fixtures (spikes/01-passkey/fixtures) so real Windows Hello and
// password-manager passkeys become regression tests. Throwaway code; the verifier is the product.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Bytes, fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import {
  type Credential,
  SUPPORTED_ALGS,
  verifyAssertion,
  verifyRegistration,
} from '@site-studio/shared/webauthn'

type Pending = { kind: 'register' | 'sign-in'; challenge: Bytes; name?: string; expires: number }
type Stored = { name: string; credential: Credential }

export type ServerOptions = { port: number; origin: string; rpId: string; fixturesDir?: string }

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

  const newChallenge = (p: Omit<Pending, 'challenge' | 'expires'>) => {
    const id = crypto.randomUUID()
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    pending.set(id, { ...p, challenge, expires: Date.now() + CHALLENGE_TTL_MS })
    return { id, challenge: toBase64Url(challenge) }
  }

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
  })
  console.log(`listening on http://localhost:${server.port}`)
}
