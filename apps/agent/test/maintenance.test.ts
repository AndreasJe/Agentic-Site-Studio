// Decision #50 (22 Oct, item 2): the maintenance page is its own command. It needs an Admin's
// passkey, like unfreeze, under the one sequence counter (#26), and works while frozen. While it is
// on, every path answers 503 with a small built-in page and the same security headers; freeze
// alone keeps the site serving.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { command, validCommand } from '../../../packages/shared/test/release-helpers.ts'
import { securityHeaders } from '../src/server.ts'
import { bundleOf, type Harness, harness, site } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.cleanup()
})

const heartbeat = () =>
  JSON.parse(readFileSync(join(h.outbox, 'heartbeat.json'), 'utf8')) as Record<string, unknown>

/** The page a visitor gets now, with the headers that matter here. */
async function visit(path: string, init?: RequestInit) {
  const r = await h.get(path, init)
  return { status: r.status, headers: r.headers, body: await r.text() }
}

describe('maintenance page', () => {
  test('on: every path answers 503 with the built-in page and the same security headers', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect(await h.sendCommand({ command: 'maintenance', args: { on: true } })).toMatchObject({
      ok: true,
      command: 'maintenance',
      maintenance: true,
    })
    expect(h.agent.snapshot().trust.maintenance).toBe(true)
    for (const path of ['/', '/about/', '/style.css', '/missing', '/../etc/passwd']) {
      const r = await visit(path)
      expect({ path, status: r.status }).toEqual({ path, status: 503 })
      expect(r.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/)
      expect(r.headers.get('content-type')).toStartWith('text/html')
      for (const [name, value] of Object.entries(securityHeaders(h.agent.csp)))
        expect([name, r.headers.get(name)]).toEqual([name, value])
      expect(r.headers.has('set-cookie')).toBe(false)
      expect(r.body).not.toContain('Home one')
    }
    const page = (await visit('/')).body
    expect(page).toContain('<!doctype html>')
    // No external assets and nothing to run: no scripts, no links, no images, no fonts.
    expect(page).not.toMatch(/<script|<link|<img|<iframe|src=|href=|url\(|@import/i)
    // HEAD and other methods get the same answer.
    expect((await visit('/', { method: 'HEAD' })).status).toBe(503)
    expect((await visit('/', { method: 'POST' })).status).toBe(503)
    // The heartbeat reports it.
    h.agent.heartbeat()
    expect(heartbeat()).toMatchObject({ maintenance: true, frozen: false, activeRelease: 1 })
  })

  test('off: the active release is served again; it survives a restart', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendCommand({ command: 'maintenance', args: { on: true } })).ok).toBe(true)
    await h.restart()
    expect((await visit('/')).status).toBe(503)
    expect(await h.sendCommand({ command: 'maintenance', args: { on: false } })).toMatchObject({
      ok: true,
      maintenance: false,
    })
    const r = await visit('/')
    expect(r.status).toBe(200)
    expect(r.body).toContain('Home one')
    h.agent.heartbeat()
    expect(heartbeat()).toMatchObject({ maintenance: false })
  })

  test('freeze alone keeps the site serving; maintenance works while frozen', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendAppCommand({ command: 'freeze' })).ok).toBe(true)
    // Frozen: changes stop, visitors still get the site (#33).
    expect((await visit('/')).body).toContain('Home one')
    h.agent.heartbeat()
    expect(heartbeat()).toMatchObject({ frozen: true, maintenance: false })

    expect(await h.sendCommand({ command: 'maintenance', args: { on: true } })).toMatchObject({
      ok: true,
      frozen: true,
      maintenance: true,
    })
    expect((await visit('/')).status).toBe(503)
    expect((await h.sendCommand({ command: 'maintenance', args: { on: false } })).ok).toBe(true)
    expect((await visit('/')).body).toContain('Home one')
    expect(h.agent.snapshot().trust.frozen).toBe(true)
  })

  test('the app key alone cannot turn it on; a passkey is needed', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect(await h.sendAppCommand({ command: 'maintenance', args: { on: true } })).toMatchObject({
      ok: false,
      code: 'passkey-required',
    })
    expect(h.agent.snapshot().trust.maintenance ?? false).toBe(false)
    expect((await visit('/')).status).toBe(200)
  })

  test('the arguments are exactly { on: boolean }; the sequence counter is shared (#26)', async () => {
    h = await harness()
    for (const args of [undefined, {}, { on: 'yes' }, { on: 1 }, { on: true, extra: 1 }]) {
      expect(
        await h.sendCommand({ command: 'maintenance', ...(args ? { args } : {}) }),
      ).toMatchObject({ ok: false, code: 'malformed' })
    }
    expect(h.agent.snapshot().trust.maintenance ?? false).toBe(false)
    // A replayed maintenance command is refused like any other.
    const sequence = h.agent.snapshot().trust.lastSequence
    const old = await command({ command: 'maintenance', sequence, args: { on: true } }, [h.alex])
    h.put('cmd-replay.json', JSON.stringify(old))
    await h.scan()
    expect(h.result('cmd-replay.json')).toMatchObject({ ok: false, code: 'replayed' })
  })

  test('a release while maintenance is on is still accepted and smoke-tested; visitors see the page', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendCommand({ command: 'maintenance', args: { on: true } })).ok).toBe(true)
    const r = await h.sendRelease(2, await bundleOf(site('two')))
    expect(r).toMatchObject({ ok: true, smoke: { passed: true, outcome: 'passed' } })
    expect(h.agent.snapshot().active).toBe(2)
    expect((await visit('/')).status).toBe(503)
    expect((await h.sendCommand({ command: 'maintenance', args: { on: false } })).ok).toBe(true)
    expect((await visit('/')).body).toContain('Home two')
  })

  test('the command file matches contracts/command.schema.json', async () => {
    h = await harness({}, { pair: false })
    const on = await command({ command: 'maintenance', sequence: 9, args: { on: true } }, [h.alex])
    expect(validCommand(on)).toBe(true)
    const bad = await command({ command: 'maintenance', sequence: 9, args: { on: 'x' } }, [h.alex])
    expect(validCommand(bad)).toBe(false)
    const none = await command({ command: 'maintenance', sequence: 9 }, [h.alex])
    expect(validCommand(none)).toBe(false)
    const app = await h.app.sign({ command: 'maintenance', sequence: 9, args: { on: true } })
    expect(validCommand(app)).toBe(false)
  })
})
