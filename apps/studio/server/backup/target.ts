// Where backups go (plan §12.2). The app drives rclone for real storage later; until then the
// folder target covers local folders and network shares, and the rclone target is a stub.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ImmutableError, writeNew } from '../store/atomic.ts'

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

export type BackupFile = { name: string; size: number; modified: number }

export interface BackupTarget {
  /** Store a new file. Never replaces one: an existing name is refused. */
  put(name: string, bytes: Uint8Array): Promise<void>
  list(): Promise<BackupFile[]>
  get(name: string): Promise<Uint8Array>
  remove(name: string): Promise<void>
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/
const checkName = (name: string) => {
  if (!SAFE_NAME.test(name) || name.includes('..')) throw new BackupError('bad-name', name)
}

/** A folder on the server or a mounted share. Uploads are atomic (temp file, then link). */
export class FolderTarget implements BackupTarget {
  constructor(readonly dir: string) {}

  async put(name: string, bytes: Uint8Array) {
    checkName(name)
    mkdirSync(this.dir, { recursive: true })
    try {
      writeNew(join(this.dir, name), bytes)
    } catch (err) {
      if (err instanceof ImmutableError) throw new BackupError('exists', name)
      throw err
    }
  }

  async list() {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((n) => SAFE_NAME.test(n) && !n.endsWith('.tmp'))
      .map((name) => {
        const s = statSync(join(this.dir, name))
        return { name, size: s.size, modified: s.mtimeMs }
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  async get(name: string) {
    checkName(name)
    try {
      return new Uint8Array(readFileSync(join(this.dir, name)))
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') throw new BackupError('not-found', name)
      throw err
    }
  }

  async remove(name: string) {
    checkName(name)
    try {
      unlinkSync(join(this.dir, name))
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
    }
  }
}

/**
 * PENDING: rclone (Azure Blob, S3, OneDrive, network shares). Every call reports "needs-rclone"
 * until the app drives rclone; settings for it ([remote name], [config path]) are not decided.
 */
export class RcloneTarget implements BackupTarget {
  constructor(readonly remote: string) {}
  private fail(): never {
    throw new BackupError('needs-rclone', 'rclone is not set up yet')
  }
  async put(_name: string, _bytes: Uint8Array): Promise<void> {
    this.fail()
  }
  async list(): Promise<BackupFile[]> {
    return this.fail()
  }
  async get(_name: string): Promise<Uint8Array> {
    return this.fail()
  }
  async remove(_name: string): Promise<void> {
    this.fail()
  }
}
