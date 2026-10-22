// Durable, atomic file writes, as in spike 1's production.ts: flushed before the rename, so a
// crash leaves the old file or the new one, never half of either. Every write goes through a
// Writer that only knows the agent's own folders, so nothing can ever be written to the inbox.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

/** The upload temp prefix the app's transport skips when it lists the outbox (#48 transport). */
export const TEMP_PREFIX = '.tmp-'

export const errno = (err: unknown) => (err as { code?: string }).code

/** True when `path` is `root` or inside it. Both are resolved first. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Not on Windows (there, making a symlink needs privileges); the lstat and fstat checks still hold.
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

/** An inbox entry as it is, without following a link: a regular file, or null (absent or not one). */
export function inboxStat(path: string): Stats | null {
  try {
    const st = lstatSync(path)
    return st.isFile() ? st : null
  } catch (err) {
    if (errno(err) === 'ENOENT') return null
    throw err
  }
}

export type InboxRead =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; size: number; mtimeMs: number }
  | { ok: false; code: 'not-a-file' | 'too-large' | 'gone'; size?: number; mtimeMs?: number }

/**
 * Reads one inbox file: never through a symlink (lstat, then O_NOFOLLOW where the platform has
 * it), only a regular file (fstat on the open descriptor), and only the size fstat gave, capped
 * at `max` bytes.
 */
export function readInboxFile(path: string, max: number): InboxRead {
  if (!inboxStat(path)) return { ok: false, code: 'not-a-file' }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
  } catch (err) {
    const code = errno(err)
    if (code === 'ENOENT') return { ok: false, code: 'gone' }
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'EMLINK')
      return { ok: false, code: 'not-a-file' }
    throw err
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { ok: false, code: 'not-a-file' }
    if (st.size > max) return { ok: false, code: 'too-large', size: st.size, mtimeMs: st.mtimeMs }
    const bytes = new Uint8Array(st.size)
    let at = 0
    while (at < bytes.length) {
      const got = readSync(fd, bytes, at, bytes.length - at, at)
      if (got <= 0) break
      at += got
    }
    const out = at === bytes.length ? bytes : bytes.slice(0, at)
    return { ok: true, bytes: out, size: st.size, mtimeMs: st.mtimeMs }
  } finally {
    closeSync(fd)
  }
}

export function syncDir(dir: string) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Windows can't open a directory for fsync; NTFS journals the rename itself.
  }
}

function writeDurably(file: string, data: string | Uint8Array, flag: 'w' | 'wx', mode: number) {
  const fd = openSync(file, flag, mode)
  try {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    let at = 0
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Windows refuses a rename while a reader has the file open; that clears within moments. */
function renameRetrying(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = errno(err)
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      Bun.sleepSync(25)
    }
  }
}

export class Writer {
  private readonly roots: string[]
  private readonly forbidden: string[]

  /** `roots` may be written; `forbidden` (the inbox) never, even if it sat inside a root. */
  constructor(roots: string[], forbidden: string[]) {
    this.roots = roots.map((r) => resolve(r))
    this.forbidden = forbidden.map((f) => resolve(f))
    for (const f of this.forbidden) {
      for (const r of this.roots) {
        if (isInside(r, f) || isInside(f, r)) {
          throw new Error(`the inbox ${f} must not overlap a folder the agent writes (${r})`)
        }
      }
    }
  }

  /** Throws unless `path` is inside a writable root and outside the inbox. */
  check(path: string): string {
    const p = resolve(path)
    if (this.forbidden.some((f) => isInside(f, p))) throw new Error(`refusing to write ${p}`)
    if (!this.roots.some((r) => isInside(r, p))) throw new Error(`refusing to write ${p}`)
    return p
  }

  mkdir(dir: string) {
    mkdirSync(this.check(dir), { recursive: true })
  }

  /** Temp file next to the target (same folder, so the rename is atomic), then rename. */
  atomic(file: string, data: string | Uint8Array, mode = 0o644) {
    const target = this.check(file)
    const dir = dirname(target)
    mkdirSync(dir, { recursive: true })
    const tmp = this.check(resolve(dir, `${TEMP_PREFIX}${basename(target)}.${process.pid}`))
    try {
      writeDurably(tmp, data, 'w', mode)
      renameRetrying(tmp, target)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {}
      throw err
    }
    syncDir(dir)
  }

  json(file: string, value: unknown, mode?: number) {
    this.atomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
  }

  /** A new file that must not exist yet (unpacking): never replaces anything. */
  create(file: string, data: Uint8Array) {
    const target = this.check(file)
    mkdirSync(dirname(target), { recursive: true })
    writeDurably(target, data, 'wx', 0o644)
  }

  rename(from: string, to: string) {
    renameRetrying(this.check(from), this.check(to))
    syncDir(dirname(this.check(to)))
  }

  remove(path: string) {
    rmSync(this.check(path), { recursive: true, force: true })
  }

  unlink(path: string) {
    unlinkSync(this.check(path))
  }
}
