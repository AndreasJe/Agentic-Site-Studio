// Atomic writes (CLAUDE.md rule 2). Revisions and blobs are write-once: the final step is a hard
// link, which fails if the name exists, unlike rename, which would silently replace it.
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export class ImmutableError extends Error {
  constructor(path: string) {
    super(`refusing to overwrite ${basename(path)}: saved files never change`)
    this.name = 'ImmutableError'
  }
}

let counter = 0

function tempFor(path: string): string {
  return `${path}.${process.pid}-${++counter}.tmp`
}

function writeDurably(file: string, bytes: Uint8Array) {
  const fd = openSync(file, 'wx')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDir(dir: string) {
  try {
    const fd = openSync(dir, 'r')
    fsyncSync(fd)
    closeSync(fd)
  } catch {
    // Windows can't open a directory for fsync; NTFS journals the link and rename itself.
  }
}

/** Write a file that must never change: a revision or a blob. Fails if it already exists. */
export function writeNew(path: string, bytes: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tempFor(path)
  writeDurably(tmp, bytes)
  try {
    linkSync(tmp, path)
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') throw new ImmutableError(path)
    throw err
  } finally {
    unlinkSync(tmp)
  }
  syncDir(dirname(path))
}

/** Write an index that may be replaced (project.json): whole old file or whole new file. */
export function writeReplace(path: string, bytes: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tempFor(path)
  writeDurably(tmp, bytes)
  renameWithRetry(tmp, path)
  syncDir(dirname(path))
}

/** Remove temp files a crash left behind. Run at start, before anything reads the folder. */
export function cleanTemps(dir: string) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) unlinkSync(join(dir, name))
  }
}

/**
 * On Windows a rename can fail for a moment while another process (often the virus scanner)
 * holds the target open. Retry briefly on those errors only; anything else is real.
 */
function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw err
      Bun.sleepSync(10 + attempt * 5)
    }
  }
}
