import { readFileSync } from 'node:fs'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

// Diff ratio = differing pixels / total pixels. Different sizes count as 1.
export function diffRatio(fileA, fileB) {
  const a = PNG.sync.read(readFileSync(fileA))
  const b = PNG.sync.read(readFileSync(fileB))
  if (a.width !== b.width || a.height !== b.height) return 1
  const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
  return diff / (a.width * a.height)
}

// shotsA/shotsB: { 'page|width': path }
export function compareRuns(shotsA, shotsB) {
  const out = {}
  for (const k of Object.keys(shotsA)) out[k] = shotsB[k] ? diffRatio(shotsA[k], shotsB[k]) : 1
  return out
}
