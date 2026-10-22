// M7.2: the transport to production's inbox and outbox (decision #1, plan §13.4).
// Pending the VM: a real sshd chroot, and "production has no route to the app" (a firewall).
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import { FolderTransport } from '../server/transport/folder.ts'
import { FileHostPins, loadOrCreateClientKey, MemoryHostPins } from '../server/transport/keys.ts'
import { SftpTransport } from '../server/transport/sftp.ts'
import { type Transport, TransportError } from '../server/transport/types.ts'
import { generateKeyPair, startSftpServer, type TestSftpServer } from './helpers/sftp-server.ts'

const root = mkdtempSync(join(tmpdir(), 'studio-transport-'))
const cleanups: (() => Promise<void> | void)[] = []
afterAll(async () => {
  for (const c of cleanups.reverse()) await c()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const enc = new TextEncoder()
const dec = new TextDecoder()
const clientKey = loadOrCreateClientKey(join(root, 'data'))

async function sftpEnv() {
  const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
  cleanups.push(() => server.close())
  const t = new SftpTransport({
    host: server.host,
    port: server.port,
    username: 'app',
    privateKey: clientKey.privateKey,
    pins: new MemoryHostPins(),
    connectTimeoutMs: 5000,
    opTimeoutMs: 10000,
  })
  cleanups.push(() => t.close())
  return { t, inboxDir: server.inboxDir, outboxDir: server.outboxDir }
}

function folderEnv() {
  const dir = mkdtempSync(join(root, 'folder-'))
  const inboxDir = join(dir, 'inbox')
  const outboxDir = join(dir, 'outbox')
  mkdirSync(inboxDir)
  mkdirSync(outboxDir)
  return { t: new FolderTransport({ inboxDir, outboxDir }) as Transport, inboxDir, outboxDir }
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    return e instanceof TransportError ? e.code : `other:${(e as Error).message}`
  }
  return 'no-error'
}

type Env = { t: Transport; inboxDir: string; outboxDir: string }

function contract(label: string, make: () => Promise<Env> | Env) {
  describe(`${label}: transport contract`, () => {
    test('putInbox writes the bytes under the final name, with no temp file left', async () => {
      const { t, inboxDir } = await make()
      const bytes = new Uint8Array([0, 1, 2, 255, 254])
      await t.putInbox('release.json', bytes)
      expect(new Uint8Array(readFileSync(join(inboxDir, 'release.json')))).toEqual(bytes)
      expect(readdirSync(inboxDir)).toEqual(['release.json'])
    })

    test('one subfolder level works; a second is refused', async () => {
      const { t, inboxDir } = await make()
      await t.putInbox('cmd/freeze-1.json', enc.encode('{}'))
      expect(readFileSync(join(inboxDir, 'cmd', 'freeze-1.json'), 'utf8')).toBe('{}')
      expect(await code(t.putInbox('a/b/c.json', enc.encode('x')))).toBe('invalid-name')
    })

    test('a name written twice is replaced whole', async () => {
      const { t, inboxDir } = await make()
      await t.putInbox('a.json', enc.encode('one'))
      await t.putInbox('a.json', enc.encode('two'))
      expect(readFileSync(join(inboxDir, 'a.json'), 'utf8')).toBe('two')
      expect(readdirSync(inboxDir)).toEqual(['a.json'])
    })

    test('listOutbox lists files with one subfolder level, filtered by prefix, sorted', async () => {
      const { t, outboxDir } = await make()
      writeFileSync(join(outboxDir, 'heartbeat.json'), '{}')
      writeFileSync(join(outboxDir, '.tmp-half.json'), 'x')
      mkdirSync(join(outboxDir, 'logs'))
      writeFileSync(join(outboxDir, 'logs', 'a.log'), 'a')
      writeFileSync(join(outboxDir, 'logs', 'b.log'), 'b')
      expect(await t.listOutbox()).toEqual(['heartbeat.json', 'logs/a.log', 'logs/b.log'])
      expect(await t.listOutbox('logs/')).toEqual(['logs/a.log', 'logs/b.log'])
      expect(await t.listOutbox('heart')).toEqual(['heartbeat.json'])
      expect(await t.listOutbox('nothing')).toEqual([])
    })

    test('readOutbox returns the bytes; a missing file is not-found', async () => {
      const { t, outboxDir } = await make()
      const bytes = new Uint8Array(70_000).map((_, i) => i % 251)
      writeFileSync(join(outboxDir, 'big.bin'), bytes)
      mkdirSync(join(outboxDir, 'logs'))
      writeFileSync(join(outboxDir, 'logs', 'a.log'), 'hello')
      expect(await t.readOutbox('big.bin', 70_000)).toEqual(bytes)
      expect(dec.decode(await t.readOutbox('logs/a.log', 5))).toBe('hello')
      expect(await code(t.readOutbox('missing.json', 1024))).toBe('not-found')
    })

    test('readOutbox refuses a file over the cap as too-large', async () => {
      const { t, outboxDir } = await make()
      writeFileSync(join(outboxDir, 'big.bin'), new Uint8Array(70_001))
      expect(await code(t.readOutbox('big.bin', 70_000))).toBe('too-large')
      expect(await code(t.readOutbox('big.bin', -1))).toBe(
        'other:maxBytes must be a whole number of bytes',
      )
    })

    test('removeInbox removes one inbox file; a missing one is not an error; the outbox is never touched', async () => {
      const { t, inboxDir, outboxDir } = await make()
      await t.putInbox('cmd-1.json', enc.encode('one'))
      await t.putInbox('cmd-2.json', enc.encode('two'))
      writeFileSync(join(outboxDir, 'cmd-1.json'), 'result')
      await t.removeInbox('cmd-1.json')
      expect(readdirSync(inboxDir)).toEqual(['cmd-2.json'])
      expect(readFileSync(join(outboxDir, 'cmd-1.json'), 'utf8')).toBe('result')
      await t.removeInbox('cmd-1.json') // already gone: fine
      for (const bad of ['../outbox/cmd-1.json', '/abs', '.tmp-cmd-2.json', 'a/../b', '', 'a/b/c'])
        expect(await code(t.removeInbox(bad))).toBe('invalid-name')
      expect(readdirSync(inboxDir)).toEqual(['cmd-2.json'])
      expect(readdirSync(outboxDir)).toEqual(['cmd-1.json'])
    })

    test('names are validated before anything is sent', async () => {
      const { t, inboxDir } = await make()
      for (const bad of [
        '../x',
        'a/../x',
        '/abs',
        'a b',
        'x\\y',
        '',
        '..',
        '.',
        'a/.',
        '.tmp-x',
        'a..b',
        'é.json',
        'a//b',
      ]) {
        expect(await code(t.putInbox(bad, enc.encode('x')))).toBe('invalid-name')
        expect(await code(t.readOutbox(bad, 1024))).toBe('invalid-name')
      }
      expect(await code(t.listOutbox('../'))).toBe('invalid-name')
      expect(readdirSync(inboxDir)).toEqual([])
      await t.putInbox('Ok-1_2.v3.json', enc.encode('x'))
    })
  })
}

contract('FolderTransport', folderEnv)
contract('SftpTransport', sftpEnv)

function rawSftp(
  server: TestSftpServer,
  auth: { privateKey?: string; password?: string },
): Promise<{ sftp: SFTPWrapper; client: Client }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => client.sftp((e, sftp) => (e ? reject(e) : resolve({ sftp, client }))))
    client.on('error', reject)
    client.connect({
      host: server.host,
      port: server.port,
      username: 'app',
      ...auth,
      hostVerifier: () => true,
      readyTimeout: 5000,
      authHandler: auth.password ? ['password'] : ['publickey'],
    })
  })
}
const sftpCode = (fn: (cb: (e?: Error | null) => void) => void) =>
  new Promise<string>((res) =>
    fn((e) => res(e ? String((e as { code?: unknown }).code ?? e.message) : 'ok')),
  )

describe('the client key', () => {
  test('is made at first use, reused after, and kept private', () => {
    const dir = join(root, 'keydata')
    const a = loadOrCreateClientKey(dir)
    const b = loadOrCreateClientKey(dir)
    expect(a).toEqual(b)
    expect(a.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(a.privateKey).toContain('OPENSSH PRIVATE KEY')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'keys', 'app-ssh-ed25519')).mode & 0o077).toBe(0)
    }
    // The key never shows up in an error message.
    expect(new TransportError('failed', 'x').message).not.toContain('OPENSSH')
  })
})

describe('host key pinning (trust on first use)', () => {
  test('the first key is pinned; a different key at the same address is refused', async () => {
    const hostA = generateKeyPair()
    const hostB = generateKeyPair()
    const pinFile = join(root, 'pins', 'known-hosts.json')
    const pins = new FileHostPins(pinFile)
    const mk = (server: TestSftpServer) =>
      new SftpTransport({
        host: server.host,
        port: server.port,
        username: 'app',
        privateKey: clientKey.privateKey,
        pins,
        pinId: 'production',
        connectTimeoutMs: 5000,
      })

    const s1 = await startSftpServer({ clientPublicKey: clientKey.publicKey, hostKey: hostA })
    const t1 = mk(s1)
    expect(pins.get('production')).toBeUndefined()
    await t1.listOutbox()
    expect(pins.get('production')).toBe(s1.hostFingerprint)
    expect(existsSync(pinFile)).toBe(true)
    await t1.close()
    await s1.close()

    // Same key again (new process, same pins): accepted.
    const s1b = await startSftpServer({ clientPublicKey: clientKey.publicKey, hostKey: hostA })
    const t1b = mk(s1b)
    await t1b.listOutbox()
    await t1b.close()
    await s1b.close()

    // Another host key under the same pin: refused, and the pin is unchanged.
    const s2 = await startSftpServer({ clientPublicKey: clientKey.publicKey, hostKey: hostB })
    cleanups.push(() => s2.close())
    const t2 = mk(s2)
    expect(await code(t2.listOutbox())).toBe('host-key-changed')
    expect(await code(t2.putInbox('x.json', enc.encode('x')))).toBe('host-key-changed')
    expect(pins.get('production')).toBe(s1.hostFingerprint)
    expect(readdirSync(s2.inboxDir)).toEqual([])
    await t2.close()
  })

  test('a refused key is not pinned', async () => {
    const other = generateKeyPair()
    const server = await startSftpServer({ clientPublicKey: other.public })
    cleanups.push(() => server.close())
    const pins = new MemoryHostPins()
    const t = new SftpTransport({
      host: server.host,
      port: server.port,
      username: 'app',
      privateKey: clientKey.privateKey,
      pins,
      pinId: 'p',
      connectTimeoutMs: 5000,
    })
    expect(await code(t.listOutbox())).toBe('auth-failed')
    expect(pins.get('p')).toBeUndefined()
  })
})

describe('who may connect', () => {
  test('a wrong client key is refused', async () => {
    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    const wrong = generateKeyPair()
    await expect(rawSftp(server, { privateKey: wrong.private })).rejects.toThrow()
    const t = new SftpTransport({
      host: server.host,
      port: server.port,
      username: 'app',
      privateKey: wrong.private,
      pins: new MemoryHostPins(),
      connectTimeoutMs: 5000,
    })
    expect(await code(t.listOutbox())).toBe('auth-failed')
  })

  test('a password is refused, even for the right user name', async () => {
    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    await expect(rawSftp(server, { password: 'letmein' })).rejects.toThrow()
  })

  test('only SFTP: a shell and an exec are refused', async () => {
    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    const { client } = await rawSftp(server, { privateKey: clientKey.privateKey })
    const exec = await new Promise<string>((res) =>
      client.exec('id', (e) => res(e ? 'refused' : 'allowed')),
    )
    const shell = await new Promise<string>((res) =>
      client.shell((e) => res(e ? 'refused' : 'allowed')),
    )
    client.end()
    expect(exec).toBe('refused')
    expect(shell).toBe('refused')
  })
})

describe('paths and folders', () => {
  test('the client refuses an escaping name before sending; the server refuses one sent anyway', async () => {
    const { t, inboxDir, outboxDir } = await sftpEnv()
    writeFileSync(join(outboxDir, 'ok.json'), '{}')
    expect(await code(t.readOutbox('../inbox/x', 1024))).toBe('invalid-name')
    expect(await code(t.putInbox('../outbox/x', enc.encode('x')))).toBe('invalid-name')

    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    writeFileSync(join(server.outboxDir, 'ok.json'), '{}')
    const { sftp, client } = await rawSftp(server, { privateKey: clientKey.privateKey })
    const read = (p: string) => sftpCode((cb) => sftp.readFile(p, cb as never))
    expect(await read('outbox/ok.json')).toBe('ok')
    expect(await read('outbox/../inbox/x')).toBe('3')
    expect(await read('/etc/passwd')).toBe('3')
    expect(await read('../etc/passwd')).toBe('3')
    expect(await read('outbox/..\\..\\x')).toBe('3')
    expect(await sftpCode((cb) => sftp.writeFile('/escape.txt', 'x', cb))).toBe('3')
    expect(await sftpCode((cb) => sftp.writeFile('inbox/../escape.txt', 'x', cb))).toBe('3')
    expect(await sftpCode((cb) => sftp.readdir('/', cb as never))).toBe('ok')
    expect(await sftpCode((cb) => sftp.readdir('/etc', cb as never))).toBe('3')
    client.end()
    expect(existsSync(join(server.inboxDir, '..', 'escape.txt'))).toBe(false)
    expect(readdirSync(server.inboxDir)).toEqual([])
    void inboxDir
  })

  test('the app may write only to inbox and read only outbox', async () => {
    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    writeFileSync(join(server.outboxDir, 'heartbeat.json'), '{}')
    writeFileSync(join(server.inboxDir, 'seen.json'), '{}')
    const { sftp, client } = await rawSftp(server, { privateKey: clientKey.privateKey })
    // writing to outbox: refused, nothing created, nothing changed
    expect(await sftpCode((cb) => sftp.writeFile('outbox/new.json', 'x', cb))).toBe('3')
    expect(await sftpCode((cb) => sftp.writeFile('outbox/heartbeat.json', 'x', cb))).toBe('3')
    expect(await sftpCode((cb) => sftp.unlink('outbox/heartbeat.json', cb))).toBe('3')
    expect(await sftpCode((cb) => sftp.rename('outbox/heartbeat.json', 'outbox/h2.json', cb))).toBe(
      '3',
    )
    expect(await sftpCode((cb) => sftp.rename('outbox/heartbeat.json', 'inbox/h.json', cb))).toBe(
      '3',
    )
    expect(await sftpCode((cb) => sftp.mkdir('outbox/d', cb))).toBe('3')
    expect(readdirSync(server.outboxDir)).toEqual(['heartbeat.json'])
    expect(readFileSync(join(server.outboxDir, 'heartbeat.json'), 'utf8')).toBe('{}')
    // reading the inbox: refused
    expect(await sftpCode((cb) => sftp.readFile('inbox/seen.json', cb as never))).toBe('3')
    expect(await sftpCode((cb) => sftp.readdir('inbox', cb as never))).toBe('3')
    client.end()

    const t = new SftpTransport({
      host: server.host,
      port: server.port,
      username: 'app',
      privateKey: clientKey.privateKey,
      pins: new MemoryHostPins(),
      connectTimeoutMs: 5000,
    })
    cleanups.push(() => t.close())
    // the transport has no way to write outbox: its only write goes to inbox/
    await t.putInbox('c.json', enc.encode('c'))
    expect(readdirSync(server.outboxDir)).toEqual(['heartbeat.json'])
    expect(
      server.ops.filter((o) => o.op === 'open-write').every((o) => o.path?.startsWith('inbox/')),
    ).toBe(true)
    // Clearing handled files (decision #50, item 10): an unlink in inbox/ only.
    await t.removeInbox('c.json')
    await t.removeInbox('heartbeat.json') // not in the inbox: nothing happens
    expect(readdirSync(server.inboxDir)).toEqual(['seen.json'])
    expect(readdirSync(server.outboxDir)).toEqual(['heartbeat.json'])
    expect(server.ops.filter((o) => o.op === 'remove').map((o) => o.path)).toEqual(['inbox/c.json'])
  })
})

describe('atomic upload', () => {
  test('the final name never exists while bytes are still arriving', async () => {
    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    const t = new SftpTransport({
      host: server.host,
      port: server.port,
      username: 'app',
      privateKey: clientKey.privateKey,
      pins: new MemoryHostPins(),
      connectTimeoutMs: 5000,
    })
    cleanups.push(() => t.close())
    const final = join(server.inboxDir, 'release.tar')
    let writes = 0
    let finalSeenEarly = false
    let tempSeen = false
    server.onWrite = (path) => {
      writes++
      if (existsSync(final)) finalSeenEarly = true
      if (
        readdirSync(server.inboxDir).includes('.tmp-release.tar') &&
        path === 'inbox/.tmp-release.tar'
      )
        tempSeen = true
    }
    const bytes = new Uint8Array(1_000_000).map((_, i) => i % 253)
    await t.putInbox('release.tar', bytes)
    expect(writes).toBeGreaterThan(1) // several chunks, so the check above is meaningful
    expect(finalSeenEarly).toBe(false)
    expect(tempSeen).toBe(true)
    expect(new Uint8Array(readFileSync(final))).toEqual(bytes)
    expect(readdirSync(server.inboxDir)).toEqual(['release.tar'])
    // every write went to the temp name; the final name only appeared through a rename
    const writeOps = server.ops.filter((o) => o.op === 'open-write')
    expect(writeOps.map((o) => o.path)).toEqual(['inbox/.tmp-release.tar'])
    expect(server.ops.filter((o) => o.op === 'rename').map((o) => [o.path, o.to])).toEqual([
      ['inbox/.tmp-release.tar', 'inbox/release.tar'],
    ])
  })

  test('FolderTransport also leaves no temp file behind and no partial final', async () => {
    const { t, inboxDir } = folderEnv()
    await t.putInbox('r.tar', new Uint8Array(100_000))
    expect(readdirSync(inboxDir)).toEqual(['r.tar'])
  })
})

describe('timeouts and retry', () => {
  test('an unreachable host fails with connect-failed after one retry', async () => {
    const t = new SftpTransport({
      host: '127.0.0.1',
      port: 1,
      username: 'app',
      privateKey: clientKey.privateKey,
      pins: new MemoryHostPins(),
      connectTimeoutMs: 1000,
    })
    expect(await code(t.listOutbox())).toBe('connect-failed')
  })

  test('a dropped connection is re-made once', async () => {
    const { t, outboxDir } = await sftpEnv()
    writeFileSync(join(outboxDir, 'a.json'), '{}')
    expect(await t.listOutbox()).toEqual(['a.json'])
    // kill the live connection under the transport
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private connection for the test
    ;(t as any).conn.client.end()
    await new Promise((r) => setTimeout(r, 50))
    expect(await t.listOutbox()).toEqual(['a.json'])
  })
})

describe('outbox reads are capped before they are read in full', () => {
  test('FolderTransport checks the size before reading anything', async () => {
    const { t, outboxDir } = folderEnv()
    writeFileSync(join(outboxDir, 'huge.json'), new Uint8Array(4 * 1024 * 1024))
    const readSync = spyOn(fs, 'readSync')
    const readFile = spyOn(fs, 'readFileSync')
    try {
      expect(await code(t.readOutbox('huge.json', 64 * 1024))).toBe('too-large')
      expect(readSync).not.toHaveBeenCalled()
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      readSync.mockRestore()
      readFile.mockRestore()
    }
  })

  test('SftpTransport: an honest size is refused before any read; a lying one stops at the cap', async () => {
    const server = await startSftpServer({ clientPublicKey: clientKey.publicKey })
    cleanups.push(() => server.close())
    const t = new SftpTransport({
      host: server.host,
      port: server.port,
      username: 'app',
      privateKey: clientKey.privateKey,
      pins: new MemoryHostPins(),
      connectTimeoutMs: 5000,
      opTimeoutMs: 10000,
    })
    cleanups.push(() => t.close())
    const cap = 64 * 1024
    writeFileSync(join(server.outboxDir, 'huge.json'), new Uint8Array(4 * 1024 * 1024))
    expect(await code(t.readOutbox('huge.json', cap))).toBe('too-large')
    expect(server.bytesRead).toBe(0)
    // A server that says the file is small: the read loop still stops one byte past the cap.
    server.fstatSize = () => 10
    expect(await code(t.readOutbox('huge.json', cap))).toBe('too-large')
    expect(server.bytesRead).toBeGreaterThan(cap)
    expect(server.bytesRead).toBeLessThanOrEqual(cap + 1)
    // Within the cap, the bytes come back whole.
    writeFileSync(join(server.outboxDir, 'ok.json'), 'x'.repeat(cap))
    server.fstatSize = undefined
    expect((await t.readOutbox('ok.json', cap)).length).toBe(cap)
  })
})
