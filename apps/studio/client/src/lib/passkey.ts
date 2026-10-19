// Passkey ceremonies against /api/passkey/*. base64url comes from the shared module (the same
// encoding as spikes/01-passkey/public/app.js).
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { api, setCsrf } from './api.ts'

type Options = {
  code?: string
  challengeId: string
  publicKey: Record<string, unknown> & { challenge: string }
}

const buf = (s: string) => fromBase64Url(s) as BufferSource
const enc = (b: ArrayBuffer) => toBase64Url(new Uint8Array(b))

export type PasskeyResult = { ok: true } | { ok: false; code: string }

function finish(res: { ok: boolean; body: { csrf?: string; code?: string } }): PasskeyResult {
  if (!res.ok || !res.body.csrf) return { ok: false, code: res.body.code ?? 'other' }
  setCsrf(res.body.csrf)
  return { ok: true }
}

/** The browser said no (cancelled, timed out, no authenticator). */
const refused = (err: unknown): PasskeyResult => ({
  ok: false,
  code: err instanceof DOMException ? 'cancelled' : 'other',
})

export async function signInWithPasskey(): Promise<PasskeyResult> {
  const opts = await api<Options>('POST', '/api/passkey/sign-in/options', {})
  if (!opts.ok) return { ok: false, code: opts.body.code ?? 'other' }
  const { challengeId, publicKey } = opts.body
  try {
    const allow = (publicKey.allowCredentials as { id: string }[]).map((c) => ({
      type: 'public-key' as const,
      id: buf(c.id),
    }))
    const cred = (await navigator.credentials.get({
      publicKey: {
        ...(publicKey as object),
        challenge: buf(publicKey.challenge),
        allowCredentials: allow,
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null
    if (!cred) return { ok: false, code: 'cancelled' }
    const r = cred.response as AuthenticatorAssertionResponse
    return finish(
      await api('POST', '/api/passkey/sign-in', {
        challengeId,
        rawId: enc(cred.rawId),
        response: {
          authenticatorData: enc(r.authenticatorData),
          clientDataJSON: enc(r.clientDataJSON),
          signature: enc(r.signature),
        },
      }),
    )
  } catch (err) {
    return refused(err)
  }
}

export async function setUpPasskey(handle: string, code: string): Promise<PasskeyResult> {
  const opts = await api<Options>('POST', '/api/passkey/setup/options', { handle, code })
  if (!opts.ok) return { ok: false, code: opts.body.code ?? 'other' }
  const { challengeId, publicKey } = opts.body
  try {
    const user = publicKey.user as { id: string; name: string; displayName: string }
    const exclude = (publicKey.excludeCredentials as { id: string }[]).map((c) => ({
      type: 'public-key' as const,
      id: buf(c.id),
    }))
    const cred = (await navigator.credentials.create({
      publicKey: {
        ...(publicKey as object),
        challenge: buf(publicKey.challenge),
        user: { ...user, id: buf(user.id) },
        excludeCredentials: exclude,
      } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null
    if (!cred) return { ok: false, code: 'cancelled' }
    const r = cred.response as AuthenticatorAttestationResponse
    return finish(
      await api('POST', '/api/passkey/setup', {
        challengeId,
        response: {
          attestationObject: enc(r.attestationObject),
          clientDataJSON: enc(r.clientDataJSON),
        },
      }),
    )
  } catch (err) {
    return refused(err)
  }
}
