// The smoke test after every switch, and the automatic switch-back with no signature (#6).
import { afterEach, describe, expect, test } from 'bun:test'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { utf8 } from '@site-studio/shared/bytes'
import { pageUrl } from '../src/smoke.ts'
import { bundleOf, type Harness, harness, page, site } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.cleanup()
})

const body = async (path: string) => await (await h.get(path)).text()

describe('smoke test', () => {
  test('a package whose index 404s switches back to the previous release and says so', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    const broken = [
      { path: 'about/index.html', bytes: page('About broken') },
      { path: 'style.css', bytes: utf8.encode('p{color:#2b675b}') },
    ]
    const r = await h.sendRelease(2, await bundleOf(broken))
    // Accepted (the number is used up), but not live.
    expect(r).toMatchObject({
      ok: true,
      release: 2,
      smoke: { passed: false, outcome: 'switched-back', switchedBack: true, activeAfter: 1 },
    })
    expect(await body('/')).toContain('Home one')
    expect(h.agent.snapshot()).toMatchObject({ active: 1, kept: [1, 2] })
    expect(h.agent.snapshot().trust.highestRelease).toBe(2)

    const smoke = h.out('smoke/2.json') as {
      outcome: string
      pages: { url: string; problems: string[] }[]
    }
    expect(smoke.outcome).toBe('switched-back')
    expect(smoke.pages.find((p) => p.url === '/')?.problems).toContain('status 404')
    expect(smoke.pages.find((p) => p.url === '/about/')?.problems).toEqual([])
    const log = await Bun.file(join(h.outbox, 'log.jsonl')).text()
    expect(log).toContain('"event":"switched-back"')
    h.agent.heartbeat()
    expect(h.out('heartbeat.json')).toMatchObject({
      activeRelease: 1,
      lastSmokeTest: { release: 2, passed: false, switchedBack: true },
    })
  })

  test('missing security headers switch back too', async () => {
    const faults: { dropHeader?: string } = {}
    h = await harness({ faults })
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    faults.dropHeader = 'content-security-policy'
    const r = await h.sendRelease(2, await bundleOf(site('two')))
    expect(r).toMatchObject({ ok: true, smoke: { outcome: 'switched-back', activeAfter: 1 } })
    const smoke = h.out('smoke/2.json') as { pages: { problems: string[] }[] }
    expect(smoke.pages.every((p) => p.problems.includes('missing content-security-policy'))).toBe(
      true,
    )
    faults.dropHeader = undefined
    expect(await body('/')).toContain('Home one')
  })

  test('with nothing to go back to, a failing first release is taken offline', async () => {
    const faults: { dropHeader?: string } = { dropHeader: 'x-frame-options' }
    h = await harness({ faults })
    const r = await h.sendRelease(1, await bundleOf(site('one')))
    expect(r).toMatchObject({ ok: true, smoke: { outcome: 'taken-offline', activeAfter: 0 } })
    expect(h.agent.snapshot().active).toBe(0)
    expect((await h.get('/')).status).toBe(503)
    const link = join(h.root, 'agent', 'current')
    expect(() => lstatSync(link)).toThrow()
  })

  test('an activate whose smoke test fails goes back to where it was', async () => {
    const faults: { dropHeader?: string } = {}
    h = await harness({ faults })
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendRelease(2, await bundleOf(site('two')))).ok).toBe(true)
    faults.dropHeader = 'referrer-policy'
    const r = await h.sendCommand({ command: 'activate', args: { release: 1 } })
    expect(r).toMatchObject({ ok: true, smoke: { outcome: 'switched-back', activeAfter: 2 } })
    faults.dropHeader = undefined
    expect(await body('/')).toContain('Home two')
  })

  test('page addresses', () => {
    expect(pageUrl('', 'index.html')).toBe('/')
    expect(pageUrl('', 'about/index.html')).toBe('/about/')
    expect(pageUrl('', 'contact.html')).toBe('/contact.html')
    expect(pageUrl('/campaigns/go', 'index.html')).toBe('/campaigns/go/')
  })

  test('a site under a path is served under its prefix', async () => {
    h = await harness({ site: 'example.com/campaigns/go' })
    const r = await h.sendRelease(
      1,
      await bundleOf(site('one'), { site: 'example.com/campaigns/go' }),
    )
    expect(r).toMatchObject({ ok: true, smoke: { outcome: 'passed' } })
    expect(await body('/campaigns/go/')).toContain('Home one')
    expect((await h.get('/')).status).toBe(404)
  })
})
