import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { HtmlValidate } from 'html-validate'
import { brokenLinks, hasReducedMotionSupport, inlineCode, pages } from './package.js'

export const BREAKPOINTS = [1280, 768, 375]

const ctxOf = async (browser, opts) => {
  const c = await browser.newContext(opts)
  c.setDefaultTimeout(20000)
  return c
}

const result = (findings = []) => ({ status: findings.length ? 'fail' : 'pass', findings })

export async function htmlCheck({ root }) {
  const hv = new HtmlValidate({
    extends: ['html-validate:recommended'],
    rules: {
      // Inline styles are allowed by the contract CSP; inline scripts are the inline-code check.
      'no-inline-style': 'off',
      'no-trailing-whitespace': 'off',
      'doctype-style': 'off',
      'void-style': 'off',
      'prefer-native-element': 'off',
    },
  })
  const findings = []
  for (const page of pages(root)) {
    const report = await hv.validateString(readFileSync(join(root, page), 'utf8'), page)
    for (const r of report.results)
      for (const m of r.messages)
        findings.push({ page, rule: m.ruleId, line: m.line, msg: m.message })
  }
  return result(findings)
}

export async function linksCheck({ root }) {
  return result(brokenLinks(root).map((b) => ({ ...b, rule: 'broken-link' })))
}

export async function inlineCodeCheck({ root }) {
  return result(inlineCode(root).map((f) => ({ ...f, rule: f.kind })))
}

export async function cspCheck({ browser, baseUrl, root }) {
  const findings = []
  const ctx = await ctxOf(browser)
  for (const page of pages(root)) {
    const p = await ctx.newPage()
    p.on('console', (m) => {
      if (/Content Security Policy|violates the following|Refused to/i.test(m.text()))
        findings.push({ page, rule: 'csp-console', msg: m.text().slice(0, 200) })
    })
    await p.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp = window.__csp ?? []
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
      })
    })
    await p.goto(`${baseUrl}/${page}`, { waitUntil: 'load' })
    await p.waitForTimeout(300)
    for (const v of await p.evaluate(() => window.__csp ?? []))
      findings.push({ page, rule: 'csp-violation', msg: v })
    await p.close()
  }
  await ctx.close()
  return result(findings)
}

export async function axeCheck({ browser, baseUrl, root }) {
  const findings = []
  const ctx = await ctxOf(browser, { bypassCSP: true })
  for (const page of pages(root)) {
    const p = await ctx.newPage()
    await p.goto(`${baseUrl}/${page}`, { waitUntil: 'load' })
    const r = await new AxeBuilder({ page: p }).analyze()
    for (const v of r.violations)
      findings.push({ page, rule: v.id, impact: v.impact, nodes: v.nodes.length })
    await p.close()
  }
  await ctx.close()
  return result(findings)
}

// 3D and heavy-animation profile (8.1, decision 12): only what is cheap and reliable.
// Checked: video poster, canvas not the largest element, reduced-motion support.
// Not checked here (need thresholds from Design setup): model/texture size, Draco/KTX2,
// lazy scene, DPR cap, DOM controls for 3D.
export async function heavyProfileCheck({ browser, baseUrl, root }) {
  const findings = []
  const ctx = await ctxOf(browser)
  for (const page of pages(root)) {
    const p = await ctx.newPage()
    await p.addInitScript(() => {
      window.__lcp = null
      new PerformanceObserver((list) => {
        const e = list.getEntries().at(-1)
        window.__lcp = { tag: e.element?.tagName ?? null, size: e.size }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    })
    await p.goto(`${baseUrl}/${page}`, { waitUntil: 'load' })
    await p.waitForTimeout(500)
    const info = await p.evaluate(() => ({
      lcp: window.__lcp,
      noPoster: [...document.querySelectorAll('video')].filter((v) => !v.getAttribute('poster'))
        .length,
      videos: document.querySelectorAll('video').length,
      canvasArea: Math.max(
        0,
        ...[...document.querySelectorAll('canvas')].map((c) => {
          const r = c.getBoundingClientRect()
          return r.width * r.height
        }),
      ),
      canvases: document.querySelectorAll('canvas').length,
    }))
    if (info.noPoster) findings.push({ page, rule: 'video-no-poster', count: info.noPoster })
    // Chrome never reports <canvas> as an LCP candidate, so a canvas at least as large as the
    // reported LCP element counts as the largest element.
    if (info.canvases && (info.lcp?.tag === 'CANVAS' || info.canvasArea >= (info.lcp?.size ?? 0)))
      findings.push({ page, rule: 'canvas-is-lcp', canvasArea: info.canvasArea, lcp: info.lcp })
    if ((info.canvases || info.videos) && !hasReducedMotionSupport(root))
      findings.push({ page, rule: 'no-reduced-motion' })
    await p.close()
  }
  await ctx.close()
  return result(findings)
}

// Screenshots (decision 15): reduced motion, animations off, videos at frame 0, canvases masked.
// Package bytes are untouched; the style is added by Playwright.
export async function screenshotsCheck({ browser, baseUrl, root, outDir, tag = 'run' }) {
  const shots = {}
  const dir = join(outDir, tag)
  mkdirSync(dir, { recursive: true })
  for (const width of BREAKPOINTS) {
    const ctx = await ctxOf(browser, {
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
    })
    for (const page of pages(root)) {
      const p = await ctx.newPage()
      await p.addInitScript(() => {
        let s = 42 // fixed seed
        Math.random = () => {
          s = (s * 1664525 + 1013904223) % 4294967296
          return s / 4294967296
        }
      })
      await p.goto(`${baseUrl}/${page}`, { waitUntil: 'load' })
      await p.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
      })
      await p.evaluate(() => {
        for (const v of document.querySelectorAll('video')) {
          v.pause()
          v.currentTime = 0
        }
      })
      await p.evaluate(async () => {
        await document.fonts.ready
      })
      const file = join(dir, `${page.replace(/\W+/g, '_')}-${width}.png`)
      await p.screenshot({
        path: file,
        fullPage: true,
        mask: [p.locator('canvas')],
        animations: 'disabled',
      })
      shots[`${page}|${width}`] = file
      await p.close()
    }
    await ctx.close()
  }
  return { status: 'pass', findings: [], shots }
}

export async function performanceCheck() {
  return {
    status: 'skipped',
    findings: [],
    note: 'not run (needs sitespeed.io, pending approval)',
  }
}
