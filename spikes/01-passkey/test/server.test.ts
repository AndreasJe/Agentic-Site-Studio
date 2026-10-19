// The spike server end to end over HTTP with a software authenticator (no browser).
import { afterAll, expect, test } from 'bun:test'
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { SoftAuthenticator } from '../../../packages/shared/test/soft-authenticator.ts'
import { startServer } from '../src/server.ts'

const server = startServer({ port: 0, origin: 'http://localhost:3999', rpId: 'localhost' })
const ORIGIN = 'http://localhost:3999'
afterAll(() => server.stop(true))

const post = async (path: string, body: unknown, origin = ORIGIN) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function registerWith(auth: SoftAuthenticator) {
  const opts = await post('/api/register/options', { name: 'rune' })
  const publicKey = opts.body.publicKey as { challenge: string }
  const reg = await auth.register({
    challenge: fromBase64Url(publicKey.challenge),
    origin: ORIGIN,
    rpId: 'localhost',
  })
  return post('/api/register', {
    challengeId: opts.body.challengeId,
    response: {
      attestationObject: toBase64Url(reg.attestationObject),
      clientDataJSON: toBase64Url(reg.clientDataJSON),
    },
  })
}

async function signInWith(auth: SoftAuthenticator, uv = true) {
  const opts = await post('/api/sign-in/options', {})
  const publicKey = opts.body.publicKey as { challenge: string }
  const a = await auth.assert({
    challenge: fromBase64Url(publicKey.challenge),
    origin: ORIGIN,
    rpId: 'localhost',
    uv,
  })
  const body = {
    challengeId: opts.body.challengeId,
    rawId: toBase64Url(auth.credentialId),
    response: {
      authenticatorData: toBase64Url(a.authenticatorData),
      clientDataJSON: toBase64Url(a.clientDataJSON),
      signature: toBase64Url(a.signature),
    },
  }
  return { result: await post('/api/sign-in', body), body }
}

test('register, then sign in', async () => {
  const auth = await SoftAuthenticator.create()
  expect((await registerWith(auth)).body).toMatchObject({ ok: true, alg: -7 })
  expect((await signInWith(auth)).result.body).toMatchObject({ ok: true, name: 'rune' })
})

test('a challenge works once: replaying the same assertion is refused', async () => {
  const auth = await SoftAuthenticator.create(-8)
  await registerWith(auth)
  const { result, body } = await signInWith(auth)
  expect(result.body.ok).toBe(true)
  expect((await post('/api/sign-in', body)).body).toMatchObject({
    ok: false,
    code: 'challenge-expired',
  })
})

test('an assertion without user verification is refused', async () => {
  const auth = await SoftAuthenticator.create()
  await registerWith(auth)
  expect((await signInWith(auth, false)).result.body).toMatchObject({
    ok: false,
    code: 'user-not-verified',
  })
})

test('a request from another origin is refused before anything else', async () => {
  const res = await post('/api/register/options', { name: 'x' }, 'http://127.0.0.1:3001')
  expect(res.status).toBe(403)
  const none = await fetch(`http://127.0.0.1:${server.port}/api/sign-in/options`, {
    method: 'POST',
    body: '{}',
  })
  expect(none.status).toBe(403)
})

test('an unknown credential is refused', async () => {
  const auth = await SoftAuthenticator.create()
  expect((await signInWith(auth)).result.body).toMatchObject({
    ok: false,
    code: 'unknown-credential',
  })
})

test('malformed input is refused, not crashed on', async () => {
  const res = await post('/api/register', { challengeId: 'x' })
  expect(res.status).toBe(400)
  const bad = await post('/api/sign-in', { challengeId: 1 })
  expect(bad.body).toMatchObject({ ok: false, code: 'malformed' })
})
