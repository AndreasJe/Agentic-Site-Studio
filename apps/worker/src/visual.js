// Visual comparison (plan 13.5): the package against the last staged one, per page and breakpoint.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

// Above this share of differing pixels a page counts as changed. Same-machine runs give 0.
export const CHANGED = 0.001

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

/** Findings for the pages that changed or disappeared; new pages have nothing to compare. */
export function visualFindings(current, baseline) {
  const findings = []
  for (const [k, file] of Object.entries(current)) {
    if (!baseline[k]) continue
    const ratio = diffRatio(baseline[k], file)
    const [page, width] = k.split('|')
    if (ratio > CHANGED)
      findings.push({
        message: `${(ratio * 100).toFixed(1)}% of the pixels changed at ${width}px.`,
        file: page,
        rule: 'visual-diff',
      })
  }
  for (const k of Object.keys(baseline)) {
    const [page, width] = k.split('|')
    if (!current[k])
      findings.push({
        message: `The page is gone since the last staged package (${width}px).`,
        file: page,
        rule: 'page-removed',
      })
  }
  return findings
}

// Stored review images (decision #50). Per page and breakpoint that changed: baseline, current and
// diff PNGs, written next to the result as results/<id>.images/. Names are relative and fixed in form.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_ENTRIES = 60
export const IMAGE_NAME = /^[A-Za-z0-9_]{1,80}-\d{3,4}-(baseline|current|diff)\.png$/

function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
}

/** Writes the images for the changed pages into `dir`. Returns the list for the result. */
export function writeImages(current, baseline, dir) {
  const list = []
  mkdirSync(dir, { recursive: true })
  for (const [k, cur] of Object.entries(current)) {
    if (list.length >= MAX_IMAGE_ENTRIES) break
    if (!baseline[k] || diffRatio(baseline[k], cur) <= CHANGED) continue
    const [page, width] = k.split('|')
    const stem = `${page.replace(/\W+/g, '_').slice(0, 80)}-${width}`
    const a = readFileSync(baseline[k])
    const b = readFileSync(cur)
    if (a.length > MAX_IMAGE_BYTES || b.length > MAX_IMAGE_BYTES) continue
    const pa = PNG.sync.read(a)
    const pb = PNG.sync.read(b)
    const entry = {
      page,
      width: Number(width),
      baseline: `${stem}-baseline.png`,
      current: `${stem}-current.png`,
    }
    writeAtomic(join(dir, entry.baseline), a)
    writeAtomic(join(dir, entry.current), b)
    if (pa.width === pb.width && pa.height === pb.height) {
      const out = new PNG({ width: pa.width, height: pa.height })
      pixelmatch(pa.data, pb.data, out.data, pa.width, pa.height, { threshold: 0.1 })
      const buf = PNG.sync.write(out)
      if (buf.length <= MAX_IMAGE_BYTES) {
        entry.diff = `${stem}-diff.png`
        writeAtomic(join(dir, entry.diff), buf)
      }
    }
    list.push(entry)
  }
  return list
}
