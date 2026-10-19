// Replays ceremonies recorded from real authenticators (Windows Hello, password managers) through
// the verifier, and checks that a tampered copy is refused. Skips until fixtures exist.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromBase64Url } from '@site-studio/shared/bytes'
import { type CoseAlg, verifyAssertion, verifyRegistration } from '@site-studio/shared/webauthn'

const dir = join(import.meta.dir, '../fixtures')
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []

type Fixture = Record<string, string> & {
  kind: 'register' | 'assertion'
  credential?: { id: string; publicKey: string; alg: CoseAlg; signCount: number }
}

describe.skipIf(files.length === 0)('recorded ceremonies', () => {
  for (const file of files) {
    const f = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fixture
    const b = (k: string) => fromBase64Url(f[k] ?? '')
    const expected = {
      expectedChallenge: b('challenge'),
      expectedOrigin: f.origin ?? '',
      rpId: f.rpId ?? '',
    }

    if (f.kind === 'register') {
      test(`${file}: accepted, refused from another origin`, async () => {
        const input = {
          attestationObject: b('attestationObject'),
          clientDataJSON: b('clientDataJSON'),
        }
        expect(await verifyRegistration({ ...input, ...expected })).toMatchObject({ ok: true })
        expect(
          await verifyRegistration({
            ...input,
            ...expected,
            expectedOrigin: 'https://studio.internal',
          }),
        ).toMatchObject({ ok: false, code: 'origin-mismatch' })
      })
    } else {
      test(`${file}: accepted, refused with a changed byte`, async () => {
        const c = f.credential
        if (!c) throw new Error('assertion fixture without credential')
        const credential = {
          id: fromBase64Url(c.id),
          publicKey: fromBase64Url(c.publicKey),
          alg: c.alg,
          signCount: c.signCount,
        }
        const input = {
          credential,
          authenticatorData: b('authenticatorData'),
          clientDataJSON: b('clientDataJSON'),
          signature: b('signature'),
        }
        expect(await verifyAssertion({ ...input, ...expected })).toMatchObject({ ok: true })
        const tampered = input.clientDataJSON.slice()
        tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1
        expect(
          await verifyAssertion({ ...input, ...expected, clientDataJSON: tampered }),
        ).toMatchObject({
          ok: false,
        })
      })
    }
  }
})
