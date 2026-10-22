// FolderTransport: two local folders standing in for production's inbox and outbox (dev and the
// browser tests).
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  TEMP_PREFIX,
  type Transport,
  TransportError,
  validateName,
  validatePrefix,
} from './types.ts'

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

  async readOutbox(name: string): Promise<Uint8Array> {
    const { dir, base } = validateName(name)
    try {
      return new Uint8Array(
        readFileSync(join(this.dirs.outboxDir, ...(dir ? [dir, base] : [base]))),
      )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TransportError('not-found', `${name} is not in the outbox`)
      }
      throw new TransportError('failed', (e as Error).message)
    }
  }

  async close(): Promise<void> {}
}
