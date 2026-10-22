// FolderTransport: two local folders standing in for production's inbox and outbox (dev and the
// browser tests).
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  checkCap,
  readCapped,
  TEMP_PREFIX,
  type Transport,
  TransportError,
  tooLarge,
  validateName,
  validatePrefix,
} from './types.ts'

// Not on Windows; there a symlink in the outbox needs privileges to make.
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export class FolderTransport implements Transport {
  constructor(private readonly dirs: { inboxDir: string; outboxDir: string }) {}

  async putInbox(name: string, bytes: Uint8Array): Promise<void> {
    const { dir, base } = validateName(name)
    const folder = dir ? join(this.dirs.inboxDir, dir) : this.dirs.inboxDir
    mkdirSync(folder, { recursive: true })
    const tmp = join(folder, TEMP_PREFIX + base)
    writeFileSync(tmp, bytes)
    try {
      renameSync(tmp, join(folder, base))
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {}
      throw new TransportError(
        'failed',
        `could not finish writing ${name}: ${(e as Error).message}`,
      )
    }
  }

  async listOutbox(prefix?: string): Promise<string[]> {
    const p = validatePrefix(prefix)
    const out: string[] = []
    const root = this.dirs.outboxDir
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.name.startsWith(TEMP_PREFIX)) continue
      if (e.isDirectory()) {
        for (const f of readdirSync(join(root, e.name), { withFileTypes: true })) {
          if (f.isFile() && !f.name.startsWith(TEMP_PREFIX)) out.push(`${e.name}/${f.name}`)
        }
      } else if (e.isFile()) out.push(e.name)
    }
    return out.filter((n) => n.startsWith(p)).sort()
  }

  async readOutbox(name: string, maxBytes: number): Promise<Uint8Array> {
    const { dir, base } = validateName(name)
    const cap = checkCap(maxBytes)
    let fd: number
    try {
      fd = openSync(
        join(this.dirs.outboxDir, ...(dir ? [dir, base] : [base])),
        constants.O_RDONLY | NOFOLLOW,
      )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TransportError('not-found', `${name} is not in the outbox`)
      }
      throw new TransportError('failed', (e as Error).message)
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw new TransportError('failed', `${name} is not a file`)
      // The size first: an oversize file is refused without reading it.
      if (st.size > cap) throw tooLarge(name, cap)
      return await readCapped(name, cap, (buf, length, position) =>
        readSync(fd, buf, 0, length, position),
      )
    } catch (e) {
      if (e instanceof TransportError) throw e
      throw new TransportError('failed', (e as Error).message)
    } finally {
      closeSync(fd)
    }
  }

  async removeInbox(name: string): Promise<void> {
    const { dir, base } = validateName(name)
    try {
      unlinkSync(join(this.dirs.inboxDir, ...(dir ? [dir, base] : [base])))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new TransportError('failed', `could not remove ${name}: ${(e as Error).message}`)
    }
  }

  async close(): Promise<void> {}
}
