// The app's own SSH client key (ed25519), made at first use and kept under DATA_DIR/keys/.
// The private key is never logged or returned by anything but loadOrCreateClientKey.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { utils } from 'ssh2'
import { writeReplace } from '../store/atomic.ts'

export interface ClientKey {
  /** OpenSSH PEM. Secret. */
  privateKey: string
  /** `ssh-ed25519 AAAA...`, for the pairing screen and the authorized_keys line. */
  publicKey: string
}

export function loadOrCreateClientKey(dataDir: string): ClientKey {
  const dir = join(dataDir, 'keys')
  const priv = join(dir, 'app-ssh-ed25519')
  const pub = `${priv}.pub`
  mkdirSync(dir, { recursive: true })
  if (!existsSync(priv) || !existsSync(pub)) {
    const pair = utils.generateKeyPairSync('ed25519')
    try {
      writeFileSync(priv, pair.private, { flag: 'wx', mode: 0o600 })
      writeFileSync(pub, pair.public, { flag: 'wx', mode: 0o644 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  return { privateKey: readFileSync(priv, 'utf8'), publicKey: readFileSync(pub, 'utf8').trim() }
}

/** `SHA256:<base64 without padding>`, the OpenSSH fingerprint format. */
export function fingerprint(keyBlob: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`
}

/** Pinned host key fingerprints, by host id. Trust on first use (decision #1). */
export interface HostPins {
  get(id: string): string | undefined
  set(id: string, fp: string): void
}

export class FileHostPins implements HostPins {
  constructor(private readonly file: string) {}
  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }
  get(id: string) {
    return this.read()[id]
  }
  set(id: string, fp: string) {
    mkdirSync(dirname(this.file), { recursive: true })
    writeReplace(
      this.file,
      new TextEncoder().encode(JSON.stringify({ ...this.read(), [id]: fp }, null, 2)),
    )
  }
}

export class MemoryHostPins implements HostPins {
  private m = new Map<string, string>()
  get(id: string) {
    return this.m.get(id)
  }
  set(id: string, fp: string) {
    this.m.set(id, fp)
  }
}
