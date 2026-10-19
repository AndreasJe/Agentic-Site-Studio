// The app's own data about each revision: where its package is, its sections and its hash.
// The app never takes any of this from the preview or the shell.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const FIXTURES = join(import.meta.dir, '../fixtures')

export type Revision = { dir: string; sections: string[] }
export const REVISIONS: Record<string, Revision> = {
  'rev-clean': { dir: join(FIXTURES, 'clean'), sections: ['hero', 'features', 'contact'] },
  'rev-attack': { dir: join(FIXTURES, 'attack'), sections: ['hero'] },
}

/** Package files, keyed by their relative path with forward slashes. */
export function packageFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const abs = join(entry.parentPath, entry.name)
    files.set(relative(dir, abs).replaceAll('\\', '/'), abs)
  }
  return files
}

/** SHA-256 over the sorted files (path, NUL, bytes, NUL): the package hash the app shows. */
export function packageHash(dir: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  const files = packageFiles(dir)
  for (const path of [...files.keys()].sort()) {
    hasher.update(`${path}\0`)
    hasher.update(readFileSync(files.get(path) as string))
    hasher.update('\0')
  }
  return hasher.digest('hex')
}
