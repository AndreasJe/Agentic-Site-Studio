// The app's own signing key (decisions #1, #3, #31): Ed25519, made at first use and kept under
// DATA_DIR/keys/. It signs only what production accepts on the app's signature alone: freeze,
// cert and csr. Production learns the public key from the pairing file. The private key never
// leaves this module: it is not logged, returned or put in an error message.
//
// The file is the same one `server/deploy/app-key.ts` reads (`app-signing-ed25519.json`), so the
// deployment side and this module can never hold two different keys.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromBase64Url, toBase64Url } from '@site-studio/shared/bytes'
import { commandChallenge } from '@site-studio/shared/release'

type Stored = { privateKey: string; publicKey: string }
type Loaded = { priv: CryptoKey; publicKey: string }

export const APP_SIGNING_KEY_FILE = 'app-signing-ed25519.json'
const cache = new Map<string, Promise<Loaded>>()

async function load(dataDir: string): Promise<Loaded> {
  const dir = join(dataDir, 'keys')
  const file = join(dir, APP_SIGNING_KEY_FILE)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const stored: Stored = {
      privateKey: toBase64Url(
        new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
      ),
      publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))),
    }
    try {
      // `wx`: two first uses at once can't both write; the loser reads the winner's key.
      writeFileSync(file, JSON.stringify(stored), { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('app signing key: write failed')
    }
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows keeps its own ACLs
    }
  }
  let stored: Stored
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as Stored
  } catch {
    throw new Error('app signing key: the key file is unreadable')
  }
  const priv = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(stored.privateKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  return { priv, publicKey: stored.publicKey }
}

function get(dataDir: string): Promise<Loaded> {
  let p = cache.get(dataDir)
  if (!p) {
    p = load(dataDir)
    // A failed load is not cached, so a fixed file works on the next call.
    p.catch(() => cache.delete(dataDir))
    cache.set(dataDir, p)
  }
  return p
}

const dirOf = (where: string | { dataDir: string }) =>
  typeof where === 'string' ? where : where.dataDir

/** The raw 32-byte Ed25519 public key, base64url, as the pairing file carries it. */
export async function appSigningPublicKey(where: string | { dataDir: string }): Promise<string> {
  return (await get(dirOf(where))).publicKey
}

/** An Ed25519 signature by the app's key over `bytes`, base64url. */
export async function appSign(
  where: string | { dataDir: string },
  bytes: Uint8Array,
): Promise<string> {
  const { priv } = await get(dirOf(where))
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, new Uint8Array(bytes))
  return toBase64Url(new Uint8Array(sig))
}

/** An inbox command signed by the app's key alone. `unsigned` has no `signatures`. */
export async function signAppCommand(
  where: string | { dataDir: string },
  unsigned: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = await appSign(where, await commandChallenge(unsigned))
  return { ...unsigned, signatures: [{ by: 'app', value }] }
}
