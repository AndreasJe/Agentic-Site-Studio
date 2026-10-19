// Content-addressed blob store per project: <project>/blobs/sha256/<2 hex>/<62 hex>. A blob is
// written once; storing the same bytes again is a no-op, and reads verify the hash.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@site-studio/shared/bytes'
import { hex } from '@site-studio/shared/release'
import { ImmutableError, writeNew } from './atomic.ts'

const HASH = /^sha256:([0-9a-f]{64})$/

function pathOf(projectDir: string, hash: string): string {
  const m = HASH.exec(hash)
  if (!m?.[1]) throw new Error(`not a blob hash: ${hash}`)
  return join(projectDir, 'blobs', 'sha256', m[1].slice(0, 2), m[1].slice(2))
}

export async function putBlob(projectDir: string, bytes: Uint8Array): Promise<string> {
  const hash = `sha256:${hex(await sha256(new Uint8Array(bytes)))}`
  const path = pathOf(projectDir, hash)
  if (existsSync(path)) return hash
  try {
    writeNew(path, bytes)
  } catch (err) {
    // Another writer stored the same bytes first: same name, same content.
    if (!(err instanceof ImmutableError)) throw err
  }
  return hash
}

export async function getBlob(projectDir: string, hash: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(readFileSync(pathOf(projectDir, hash)))
  if (`sha256:${hex(await sha256(bytes))}` !== hash)
    throw new Error(`blob ${hash} fails its hash check`)
  return bytes
}
