// Runs one job (docs/m6-interfaces.md): verifies the archive hash, unpacks it, runs the checks and
// returns the result object. Node, playwright-core, installed Edge.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import * as C from './checks.js'
import { edgeProcesses, sampler } from './memory.js'
import { performanceCheck } from './performance.js'
import { servePackage } from './server.js'
import { ADVISORY_CHECKS, FLOOR_CHECKS, resolveLevel } from './settings.js'
import { smokeCheck } from './smoke.js'
import * as S from './static-checks.js'
import { readTar, unpack } from './tar.js'
import { visualFindings, writeImages } from './visual.js'

const BROWSER_CHECKS = new Set(['csp', 'csp-console', 'axe', 'heavy-profile', 'visual', 'smoke'])
// Needs the package server but runs its own Edge (through Lighthouse), not the shared browser.
const SERVER_CHECKS = new Set([...BROWSER_CHECKS, 'performance'])
const mb = (b) => Math.round(b / 1048576)

const IMPL = {
  html: C.htmlCheck,
  links: C.linksCheck,
  csp: C.cspCheck,
  'inline-code': C.inlineCodeCheck,
  validators: S.validatorsCheck,
  svg: S.svgCheck,
  pinned: S.pinnedCheck,
  secrets: S.secretsCheck,
  axe: C.axeCheck,
  'heavy-profile': C.heavyProfileCheck,
  'csp-console': C.cspConsoleCheck,
  visual: visualCheck,
  navigation: S.navigationCheck,
  seo: S.seoCheck,
  performance: performanceCheck,
  smoke: smokeCheck,
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function unpackArchive(buf, tmp) {
  const dir = mkdtempSync(join(tmp, 'pkg-'))
  unpack(readTar(buf), dir)
  return dir
}

// The last staged package, if the job names one, screenshotted the same way as this one.
async function visualCheck({ browser, baseUrl, root, job, tmp, imagesStage }) {
  if (!job.baselineArchivePath) return { findings: [], note: 'no baseline yet' }
  let baseRoot
  try {
    const buf = readFileSync(job.baselineArchivePath)
    // The baseline gets the same hash check as the package before it is unpacked (review of M6).
    if (createHash('sha256').update(buf).digest('hex') !== job.baselineHash)
      throw new Error('the baseline does not match its hash')
    baseRoot = unpackArchive(buf, tmp)
  } catch (e) {
    return {
      findings: [
        { message: `The baseline package could not be read: ${e.message}`, rule: 'baseline' },
      ],
    }
  }
  const baseServer = await servePackage(baseRoot)
  try {
    const outDir = join(tmp, 'shots')
    const current = await C.takeShots({ browser, baseUrl, root, outDir, tag: 'current' })
    const baseline = await C.takeShots({
      browser,
      baseUrl: baseServer.url,
      root: baseRoot,
      outDir,
      tag: 'baseline',
    })
    const findings = visualFindings(current, baseline)
    let images = []
    try {
      if (imagesStage) images = writeImages(current, baseline, imagesStage)
    } catch (e) {
      findings.push({
        message: `The review images could not be stored: ${e.message}`,
        rule: 'images',
      })
    }
    return { findings, images }
  } finally {
    await baseServer.close()
  }
}

async function runChecks(job, root, tmp, ids, imagesStage) {
  const levels = Object.fromEntries(ids.map((id) => [id, resolveLevel(id, job.settings)]))
  const active = ids.filter((id) => levels[id]?.level !== 'off')
  const needsBrowser = active.some((id) => BROWSER_CHECKS.has(id))
  const server = active.some((id) => id !== 'smoke' && SERVER_CHECKS.has(id))
    ? await servePackage(root)
    : null
  const browser = needsBrowser ? await chromium.launch({ channel: 'msedge', headless: true }) : null
  const cache = {}
  const out = []
  try {
    for (const id of ids) {
      const lv = levels[id]
      const base = { id, floor: lv.floor, level: lv.level, lowered: lv.lowered }
      if (lv.level === 'off') {
        out.push({ ...base, status: 'off', findings: [] })
        continue
      }
      let r
      try {
        r = await IMPL[id]({ root, baseUrl: server?.url, browser, job, tmp, cache, imagesStage })
      } catch (e) {
        r = { findings: [{ message: `The check crashed: ${e.message}`, rule: 'check-crashed' }] }
      }
      const status =
        r.status ?? (r.findings.length === 0 ? 'pass' : lv.level === 'block' ? 'fail' : 'warn')
      out.push({
        ...base,
        status,
        findings: r.findings,
        ...(r.accepted?.length ? { accepted: r.accepted } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.images?.length ? { images: r.images } : {}),
      })
    }
  } finally {
    await browser?.close()
    await server?.close()
  }
  return out
}

// opts.imagesDir: where the stored review images go (results/<id>.images). Without it none are kept.
export async function runJob(job, opts = {}) {
  const result = {
    id: job.id,
    kind: job.kind,
    hash: job.hash,
    startedAt: new Date().toISOString(),
    hashOk: false,
    checks: [],
    blocked: true,
  }
  let tmp
  const before = new Set((await edgeProcesses()).keys())
  const mem = sampler(before)
  const timer = setInterval(() => mem.sample(), 500)
  try {
    // 1. Hash first. Nothing is unpacked unless the bytes are the ones that were meant.
    let bytes
    try {
      bytes = readFileSync(job.archivePath)
    } catch (e) {
      result.error = `The archive could not be read: ${e.message}`
      return result
    }
    if (sha256(bytes) !== String(job.hash).toLowerCase()) {
      result.error = 'The archive does not hash to the job hash. Nothing was unpacked.'
      return result
    }
    result.hashOk = true

    // 2. Unpack into a temp dir, run, clean up.
    tmp = mkdtempSync(join(tmpdir(), 'check-job-'))
    let root
    try {
      root = unpackArchive(bytes, tmp)
    } catch (e) {
      result.error = `The archive was refused: ${e.message}`
      return result
    }
    await mem.sample()
    const ids = job.kind === 'smoke' ? ['smoke'] : [...FLOOR_CHECKS, ...ADVISORY_CHECKS]
    const stage = opts.imagesDir ? `${opts.imagesDir}.${process.pid}.tmp` : null
    if (stage) rmSync(stage, { recursive: true, force: true })
    result.checks = await runChecks(job, root, tmp, ids, stage)
    if (stage) {
      if (result.checks.some((c) => c.images?.length)) {
        rmSync(opts.imagesDir, { recursive: true, force: true })
        renameSync(stage, opts.imagesDir)
      } else rmSync(stage, { recursive: true, force: true })
    }
    result.blocked = result.checks.some((c) => c.status === 'fail')
    return result
  } finally {
    clearInterval(timer)
    await mem.sample()
    result.memory = {
      workerPeakMB: mb(mem.peak.worker),
      browserPeakMB: mb(mem.peak.browser),
      note: 'informational; the browser figure is a Windows working set only',
    }
    result.finishedAt = new Date().toISOString()
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}
