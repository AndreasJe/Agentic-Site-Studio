// The fixed challenge formats (decisions #23, #24, #26). Each kind has its own length, so a
// signature made for one purpose can never verify as another.
import { type Bytes, concat, sha256, utf8 } from '../bytes.ts'
import { canonicalJson } from './canonical.ts'

/** Sign-in: 32 fresh random bytes. */
export const SIGN_IN_CHALLENGE_BYTES = 32

export function signInChallenge(): Bytes {
  return crypto.getRandomValues(new Uint8Array(SIGN_IN_CHALLENGE_BYTES))
}

/** Release: raw SHA-256 of the bundle file (32 bytes) ‖ release number as uint64 big-endian. */
export function releaseChallenge(bundleHash: Uint8Array, releaseNumber: number): Bytes {
  if (bundleHash.length !== 32) throw new Error('bundle hash must be 32 bytes')
  if (!Number.isSafeInteger(releaseNumber) || releaseNumber < 1) {
    throw new Error('release number must be a positive integer')
  }
  const out = new Uint8Array(40)
  out.set(bundleHash)
  new DataView(out.buffer).setBigUint64(32, BigInt(releaseNumber))
  return out
}

const COMMAND_TAG = utf8.encode('cmd1')

/** Command: "cmd1" ‖ SHA-256 of the command without `signatures`, as canonical JSON. */
export async function commandChallenge(command: Record<string, unknown>): Promise<Bytes> {
  const { signatures: _signatures, ...unsigned } = command
  return concat(COMMAND_TAG, await sha256(utf8.encode(canonicalJson(unsigned))))
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function packageHashOf(bundle: Bytes): Promise<string> {
  return `sha256:${hex(await sha256(bundle))}`
}
