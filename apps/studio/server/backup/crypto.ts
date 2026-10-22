// Backup encryption: AES-256-GCM under a key from the passphrase (scrypt, random salt).
// Layout: "SSBK" | version 1 | log2(N) | salt 16 | iv 12 | ciphertext | tag 16.
// The header is the GCM additional data, so changing any byte of it fails the tag.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { BackupError } from './target.ts'

const MAGIC = [0x53, 0x53, 0x42, 0x4b]
const HEADER = 4 + 1 + 1 + 16 + 12
const TAG = 16
const LOG_N = 15

export const MIN_PASSPHRASE = 8

const keyOf = (passphrase: string, salt: Uint8Array, logN: number) =>
  scryptSync(passphrase, salt, 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })

export function encrypt(plain: Uint8Array, passphrase: string, logN = LOG_N): Uint8Array {
  if (passphrase.length < MIN_PASSPHRASE) throw new BackupError('weak-passphrase')
  const header = new Uint8Array(HEADER)
  header.set(MAGIC)
  header[4] = 1
  header[5] = logN
  header.set(randomBytes(16), 6)
  header.set(randomBytes(12), 22)
  const c = createCipheriv(
    'aes-256-gcm',
    keyOf(passphrase, header.subarray(6, 22), logN),
    header.subarray(22, 34),
  )
  c.setAAD(header)
  const body = Buffer.concat([c.update(plain), c.final()])
  return new Uint8Array(Buffer.concat([header, body, c.getAuthTag()]))
}

/** Throws `bad-backup` for something that isn't a backup, `wrong-passphrase-or-tampered` otherwise. */
export function decrypt(file: Uint8Array, passphrase: string): Uint8Array {
  if (file.length < HEADER + TAG || !MAGIC.every((x, i) => file[i] === x) || file[4] !== 1) {
    throw new BackupError('bad-backup')
  }
  const logN = file[5] as number
  if (logN < 14 || logN > 20) throw new BackupError('bad-backup')
  const header = file.subarray(0, HEADER)
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      keyOf(passphrase, header.subarray(6, 22), logN),
      header.subarray(22, 34),
    )
    d.setAAD(header)
    d.setAuthTag(file.subarray(file.length - TAG))
    return new Uint8Array(
      Buffer.concat([d.update(file.subarray(HEADER, file.length - TAG)), d.final()]),
    )
  } catch {
    // A wrong passphrase and a changed file look the same by design.
    throw new BackupError('wrong-passphrase-or-tampered')
  }
}
