// A paired agent on temp folders, driven through its inbox the way the app's transport writes it
// (`.tmp-<name>`, then rename). Passkey assertions come from the shared software authenticator.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Bytes, utf8 } from '@site-studio/shared/bytes'
import {
  genesisFingerprint,
  type Manifest,
  writeArchive,
  writeReleaseBundle,
} from '@site-studio/shared/release'
import {
  type Admin,
  admin,
  appKey,
  command,
  NOW,
  pairingFor,
  release,
} from '../../../packages/shared/test/release-helpers.ts'
import { Agent, type AgentOptions } from '../src/agent.ts'

export type { Admin }
export { NOW }

export const SITE = 'example.com'

export const MANIFEST: Manifest = {
  project: 'qualiwarego',
  site: SITE,
  target: 'production',
  revision: 'qualiwarego-r7',
  validUntil: new Date(NOW.getTime() + 6 * 24 * 3600_000).toISOString(),
}

export type File = { path: string; bytes: Bytes }

export const page = (text: string) =>
  utf8.encode(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${text}</title><link rel="stylesheet" href="style.css"></head><body><p data-section="s-abc123">${text}</p></body></html>`,
  )

export function site(label: string): File[] {
  return [
    { path: 'index.html', bytes: page(`Home ${label}`) },
    { path: 'about/index.html', bytes: page(`About ${label}`) },
    { path: 'style.css', bytes: utf8.encode('p{color:#2b675b}') },
  ]
}

export const bundleOf = (files: File[], over: Partial<Manifest> = {}) =>
  writeReleaseBundle({ ...MANIFEST, ...over }, writeArchive(files))

export type Result = { ok: boolean; code?: string } & Record<string, unknown>

export type Harness = Awaited<ReturnType<typeof harness>>

export async function harness(
  opts: Partial<AgentOptions> = {},
  setup: { pair?: boolean; root?: string } = {},
) {
  const root = setup.root ?? mkdtempSync(join(tmpdir(), 'agent-test-'))
  const inbox = join(root, 'inbox')
  const outbox = join(root, 'outbox')
  mkdirSync(inbox, { recursive: true })
  const clock = { now: NOW }
  const lines: string[] = []
  const make = () =>
    new Agent({
      home: join(root, 'agent'),
      inbox,
      outbox,
      site: SITE,
      hostname: '127.0.0.1',
      port: 0,
      heartbeatMs: 0,
      pollMs: 0,
      keep: 3,
      now: () => clock.now,
      print: (line) => lines.push(line),
      ...opts,
    })
  const h = {
    root,
    inbox,
    outbox,
    clock,
    lines,
    agent: make(),
    alex: await admin('alex'),
    sam: await admin('sam'),
    app: await appKey(),
    sequence: 0,
    async restart(): Promise<void> {
      await h.agent.stop()
      h.agent = make()
      await h.agent.start()
    },
    /** Like the transport: a temp name, then a rename, so the agent never sees half a file. */
    put(name: string, data: string | Uint8Array) {
      const tmp = join(inbox, `.tmp-${name}`)
      writeFileSync(tmp, data)
      renameSync(tmp, join(inbox, name))
    },
    out(name: string): Record<string, unknown> {
      return JSON.parse(readFileSync(join(outbox, name), 'utf8'))
    },
    result(name: string): Result {
      return h.out(`results/${name}`) as Result
    },
    async scan(): Promise<void> {
      await h.agent.scan()
    },
    /** Signs and sends release `n`; returns its result from the outbox. */
    async sendRelease(
      n: number,
      bundle: Bytes,
      signers?: Admin[],
      extra: Record<string, unknown> = {},
    ): Promise<Result> {
      h.put(`release-${n}.tar`, bundle)
      h.put(
        `release-${n}.json`,
        JSON.stringify(await release(bundle, n, signers ?? [h.alex], extra)),
      )
      await h.scan()
      return h.result(`release-${n}.json`)
    },
    /** A passkey-signed command with the next sequence number. */
    async sendCommand(body: Record<string, unknown>, signers?: Admin[]): Promise<Result> {
      const sequence = ++h.sequence
      const cmd = await command({ sequence, ...body }, signers ?? [h.alex])
      h.put(`cmd-${sequence}.json`, JSON.stringify(cmd))
      await h.scan()
      return h.result(`cmd-${sequence}.json`)
    },
    /** A command signed by the app's own key alone (freeze, cert, csr). */
    async sendAppCommand(body: Record<string, unknown>): Promise<Result> {
      const sequence = ++h.sequence
      const cmd = await h.app.sign({ sequence, ...body })
      h.put(`cmd-${sequence}.json`, JSON.stringify(cmd))
      await h.scan()
      return h.result(`cmd-${sequence}.json`)
    },
    /** Pairing (decisions #25, #31): the genesis file, the fingerprint confirmed at the server. */
    async pair(
      policy?: Record<string, number>,
    ): Promise<{ waiting: Result; accepted: Result; fingerprint: string }> {
      const sequence = ++h.sequence
      const genesis = await command(
        {
          command: 'trust-keys',
          sequence,
          args: {
            genesis: true,
            add: [h.alex.key, h.sam.key],
            pairing: pairingFor(h.app.publicKey),
            ...(policy ? { policy } : {}),
          },
        },
        [h.alex],
      )
      const name = `cmd-${sequence}.json`
      h.put(name, JSON.stringify(genesis))
      await h.scan()
      const waiting = h.result(name)
      const fingerprint = await genesisFingerprint(genesis)
      h.agent.confirmFingerprint(fingerprint)
      await h.scan()
      return { waiting, accepted: h.result(name), fingerprint }
    },
    async get(path: string, init?: RequestInit): Promise<Response> {
      const scheme = h.agent.secure ? 'https' : 'http'
      return await fetch(`${scheme}://127.0.0.1:${h.agent.port}${path}`, {
        ...init,
        tls: { rejectUnauthorized: false },
      })
    },
    async cleanup(): Promise<void> {
      await h.agent.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
  await h.agent.start()
  if (setup.pair !== false) {
    const p = await h.pair()
    if (!p.accepted.ok) throw new Error(`pairing refused: ${p.accepted.code}`)
  }
  return h
}
