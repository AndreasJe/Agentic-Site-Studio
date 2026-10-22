// What the agent may touch (decisions #1, rule 5): no client connections at all, writes only to
// its outbox, state and releases, never to the inbox; and the heartbeat the app reads health from.
import 'reflect-metadata'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509CertificateGenerator } from '@peculiar/x509'
import { ajv } from '../../../packages/shared/test/release-helpers.ts'
import { Agent } from '../src/agent.ts'
import { Writer } from '../src/fsx.ts'
import { bundleOf, type Harness, harness, NOW, page, site } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

const SRC = join(import.meta.dir, '../src')
const sources = () => readdirSync(SRC).filter((f) => f.endsWith('.ts'))

describe('no network', () => {
  test('the source opens no client connection and starts no process', () => {
    expect(sources().length).toBeGreaterThan(5)
    for (const file of sources()) {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect(text).not.toMatch(
        /from ['"](node:)?(net|http|https|http2|dgram|dns|tls|child_process|worker_threads|cluster)['"]/,
      )
      // A global fetch (not the server's own in-process `server.fetch`), sockets, processes,
      // dynamic code loading.
      expect(text).not.toMatch(/(^|[^.\w])fetch\s*\(|globalThis\.fetch|XMLHttpRequest|WebSocket/m)
      expect(text).not.toMatch(/Bun\.(connect|udpSocket|spawn|spawnSync|\$)|\bimport\(|\brequire\(/)
      expect(text).not.toMatch(/\beval\(|new Function\(/)
      // Only the web server listens.
      if (file !== 'server.ts') expect(text).not.toContain('Bun.serve')
    }
    // Imports: the file system, paths, the shared release code, x509, and its own files.
    const imports = new Set(
      sources().flatMap((f) =>
        [...readFileSync(join(SRC, f), 'utf8').matchAll(/from '([^']+)'|^import '([^']+)'/gm)].map(
          (m) => m[1] ?? m[2],
        ),
      ),
    )
    for (const i of imports) {
      expect(i).toMatch(
        /^(node:fs|node:path|bun|reflect-metadata|@peculiar\/x509|@site-studio\/shared\/(release|bytes)|\.\/[a-z]+\.ts)$/,
      )
    }
  })

  test('a whole run (pairing, releases, smoke, switch-back, activate, cert) makes no outgoing call', async () => {
    const calls: string[] = []
    const realFetch = globalThis.fetch
    const realConnect = net.Socket.prototype.connect
    const bun = Bun as unknown as Record<string, unknown>
    const realBunConnect = bun.connect
    globalThis.fetch = Object.assign(
      async (input: unknown) => {
        calls.push(`fetch ${String(input)}`)
        throw new Error('no network')
      },
      { preconnect: () => {} },
    ) as typeof fetch
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      calls.push(`net.connect ${JSON.stringify(args[0])}`)
      throw new Error('no network')
    } as typeof realConnect
    let patchedBun = false
    try {
      bun.connect = () => {
        calls.push('Bun.connect')
        throw new Error('no network')
      }
      patchedBun = bun.connect !== realBunConnect
    } catch {}
    const faults: { dropHeader?: string } = {}
    try {
      h = await harness({ faults })
      expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
      faults.dropHeader = 'x-frame-options'
      expect((await h.sendRelease(2, await bundleOf(site('two')))).smoke).toMatchObject({
        outcome: 'switched-back',
      })
      faults.dropHeader = undefined
      expect((await h.sendRelease(3, await bundleOf(site('three')))).ok).toBe(true)
      expect((await h.sendCommand({ command: 'activate', args: { release: 1 } })).ok).toBe(true)
      expect((await h.sendAppCommand({ command: 'freeze' })).ok).toBe(true)
      expect((await h.sendAppCommand({ command: 'csr' })).ok).toBe(true)
      const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair
      const selfSigned = await X509CertificateGenerator.createSelfSigned({
        name: 'CN=example.com',
        keys,
        notAfter: new Date(NOW.getTime() + 86400_000),
        signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      })
      expect(
        (
          await h.sendAppCommand({
            command: 'cert',
            args: { certificate: selfSigned.toString('pem') },
          })
        ).code,
      ).toBe('cert-wrong-key')
      h.agent.heartbeat()
    } finally {
      globalThis.fetch = realFetch
      net.Socket.prototype.connect = realConnect
      if (patchedBun) bun.connect = realBunConnect
    }
    expect(calls).toEqual([])
  })
})

describe('writes', () => {
  test('the agent never writes inside its inbox', async () => {
    h = await harness()
    const snapshot = () =>
      readdirSync(h?.inbox ?? '')
        .sort()
        .map((name) => {
          const st = statSync(join(h?.inbox ?? '', name))
          return `${name} ${st.size} ${st.mtimeMs}`
        })
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(false)
    await h.sendCommand({ command: 'activate', args: { release: 9 } })
    await h.sendAppCommand({ command: 'freeze' })
    h.put('junk.bin', page('junk'))
    const before = snapshot()
    // Everything in the inbox has been handled; scanning again changes nothing there.
    await h.scan()
    await h.restart()
    await h.scan()
    expect(snapshot()).toEqual(before)
    // Nothing the agent made is in the inbox: only what the test put there.
    expect(
      readdirSync(h.inbox).every((n) =>
        /^(release-\d+\.(json|tar)|cmd-\d+\.json|junk\.bin)$/.test(n),
      ),
    ).toBe(true)
    // Results are in the outbox, one per inbox item.
    expect(readdirSync(join(h.outbox, 'results')).sort()).toEqual(
      ['cmd-1.json', 'cmd-2.json', 'cmd-3.json', 'junk.bin.json', 'release-1.json'].sort(),
    )
  })

  test('the writer refuses any path outside its folders, and an inbox overlapping them', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-writer-'))
    try {
      const inbox = join(root, 'inbox')
      const w = new Writer([join(root, 'outbox'), join(root, 'state')], [inbox])
      expect(() => w.check(join(inbox, 'x.json'))).toThrow('refusing')
      expect(() => w.check(join(root, 'outbox', '..', 'inbox', 'x'))).toThrow('refusing')
      expect(() => w.check(join(root, 'elsewhere'))).toThrow('refusing')
      expect(w.check(join(root, 'outbox', 'results', 'a.json'))).toContain('results')
      expect(() => w.atomic(join(inbox, 'planted.json'), '{}')).toThrow('refusing')
      expect(() => new Writer([root], [inbox])).toThrow('must not overlap')
      expect(() => new Writer([join(root, 'outbox')], [root])).toThrow('must not overlap')
      mkdirSync(inbox)
      expect(
        () => new Agent({ home: join(root, 'agent'), inbox: root, site: 'example.com' }),
      ).toThrow()
      expect(
        () =>
          new Agent({
            home: join(root, 'agent'),
            inbox,
            outbox: join(inbox, 'out'),
            site: 'example.com',
          }),
      ).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a second agent on the same home is refused while the first runs', async () => {
    h = await harness()
    const second = new Agent({
      home: join(h.root, 'agent'),
      inbox: h.inbox,
      outbox: h.outbox,
      site: 'example.com',
      hostname: '127.0.0.1',
      port: 0,
      heartbeatMs: 0,
      pollMs: 0,
      print: () => {},
    })
    await expect(second.start()).rejects.toThrow('another agent')
  })

  test('folders left by a crash are cleaned up at start', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    const releases = join(h.root, 'agent', 'releases')
    mkdirSync(join(releases, '.tmp-2'))
    mkdirSync(join(releases, '7'))
    await h.restart()
    expect(readdirSync(releases).sort()).toEqual(['1'])
    expect((await h.get('/')).status).toBe(200)
  })
})

describe('heartbeat', () => {
  test('a heartbeat is written on its interval, in the contract shape', async () => {
    h = await harness({ heartbeatMs: 20 })
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    const validHeartbeat = ajv.compile(
      JSON.parse(
        readFileSync(join(import.meta.dir, '../../../contracts/heartbeat.schema.json'), 'utf8'),
      ),
    )
    const first = h.out('heartbeat.json')
    expect(validHeartbeat(first)).toBe(true)
    h.clock.now = new Date(NOW.getTime() + 1000)
    const deadline = Date.now() + 3000
    while (h.out('heartbeat.json').at === first.at && Date.now() < deadline) await Bun.sleep(10)
    const beat = h.out('heartbeat.json')
    expect(beat.at).toBe(new Date(NOW.getTime() + 1000).toISOString())
    expect(validHeartbeat(beat)).toBe(true)
    expect(beat).toMatchObject({
      agentVersion: '0.1.0',
      target: 'production',
      paired: true,
      activeRelease: 1,
      frozen: false,
      highestRelease: 1,
      lastSequence: 1,
      lastSmokeTest: { release: 1, passed: true, switchedBack: false },
    })
    const disk = beat.disk as { usedBytes: number; totalBytes?: number }
    expect(disk.usedBytes).toBeGreaterThan(0)
    // The log is in the outbox too, one JSON object per line.
    const log = readFileSync(join(h.outbox, 'log.jsonl'), 'utf8').trim().split('\n')
    expect(log.every((l) => typeof JSON.parse(l).event === 'string')).toBe(true)
    // No temp files are left in the outbox.
    expect(readdirSync(h.outbox).some((n) => n.startsWith('.tmp-'))).toBe(false)
  })
})
