// Test helpers: a ustar writer, archives from fixture folders, and job builders.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixture = (n) => fileURLToPath(new URL(`../fixtures/${n}/`, import.meta.url))
export const guide = JSON.parse(readFileSync(fixture('guide.json'), 'utf8').replace(/^﻿/, ''))
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const octal = (n, len) => n.toString(8).padStart(len - 1, '0')

function header({ path, size, type = '0' }) {
  const h = Buffer.alloc(512)
  let name = path
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155)
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
  }
  h.write(name, 0, 100)
  h.write('0000644', 100)
  h.write('0000000', 108)
  h.write('0000000', 116)
  h.write(octal(size, 12), 124)
  h.write('00000000000', 136)
  h.fill(0x20, 148, 156)
  h.write(type, 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  h.write(prefix, 345)
  let sum = 0
  for (const b of h) sum += b
  h.write(`${octal(sum, 7)}\0 `, 148)
  return h
}

/** entries: [{ path, data, type? }] -> ustar bytes, in the order given. */
export function tarOf(entries) {
  const parts = []
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '')
    parts.push(header({ path: e.path, size: data.length, type: e.type }), data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export function filesOf(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name)
    if (statSync(f).isDirectory()) out.push(...filesOf(f, base))
    else out.push({ path: relative(base, f).split(sep).join('/'), data: readFileSync(f) })
  }
  return out
}

/** Pack a folder, sorted by path, and store it as <dir>/<hash>.tar. Returns { path, hash, bytes }. */
export function archiveOf(folder, outDir, extra = []) {
  const entries = [...filesOf(folder), ...extra].sort((a, b) => (a.path < b.path ? -1 : 1))
  return storeArchive(tarOf(entries), outDir)
}

export function storeArchive(bytes, outDir) {
  mkdirSync(outDir, { recursive: true })
  const hash = sha256(bytes)
  const path = join(outDir, `${hash}.tar`)
  writeFileSync(path, bytes)
  return { path, hash, bytes }
}

/** Every .js in the folder pinned with its real checksum. */
export const pinsOf = (folder) =>
  filesOf(folder)
    .filter((f) => f.path.endsWith('.js'))
    .map((f) => ({ path: f.path, sha256: sha256(f.data) }))

/** A package job for a fixture folder. Over = fields to replace. */
export function jobOf(id, folder, outDir, over = {}) {
  const a = archiveOf(folder, outDir, over.extraFiles)
  const { extraFiles: _drop, ...rest } = over
  return {
    id,
    kind: 'package',
    project: 'go',
    rev: 'go-r1',
    archivePath: a.path,
    hash: a.hash,
    settings: { performance: 'off' }, // Lighthouse is slow; test/performance.node.js covers it
    acceptances: [],
    guide,
    pinned: pinsOf(folder),
    ...rest,
  }
}

export const failedIds = (r) =>
  r.checks
    .filter((c) => c.status === 'fail')
    .map((c) => c.id)
    .sort()
