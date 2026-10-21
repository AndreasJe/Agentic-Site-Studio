// Visual comparison (plan 13.5): the package against the last staged one, per page and breakpoint.
import { readFileSync } from 'node:fs'
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
