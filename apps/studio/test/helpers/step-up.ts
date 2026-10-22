// The passkey step-up as a screen runs it (governance/stepup.ts, `stp1`): ask, get 428 with the
// challenge, sign it with the Admin's own passkey, send the same request again with `stepUp`.
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import type { Admin } from '../../../../packages/shared/test/release-helpers.ts'

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any
type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Json }>

/** The `stepUp` answer to a 428 `step-up-required`, signed by `passkey`. */
export async function stepUpAnswer(
  passkey: Admin,
  stepUp: { id: string; publicKey: { challenge: string } },
  o: { origin?: string; rpId?: string; uv?: boolean } = {},
) {
  const s = await passkey.auth.assert({
    challenge: fromBase64Url(stepUp.publicKey.challenge),
    origin: o.origin ?? 'http://localhost:3000',
    rpId: o.rpId ?? 'localhost',
    uv: o.uv,
  })
  return {
    id: stepUp.id,
    rawId: passkey.key.keyId,
    response: {
      authenticatorData: toBase64Url(s.authenticatorData),
      clientDataJSON: toBase64Url(s.clientDataJSON),
      signature: toBase64Url(s.signature),
    },
  }
}

/** POST `body`; on 428, sign the step-up and POST it again. Returns the last answer. */
export async function withStepUp(call: Call, passkey: Admin, path: string, body: Json = {}) {
  const first = await call('POST', path, body)
  if (first.status !== 428) return first
  return await call('POST', path, {
    ...body,
    stepUp: await stepUpAnswer(passkey, first.body.stepUp),
  })
}
