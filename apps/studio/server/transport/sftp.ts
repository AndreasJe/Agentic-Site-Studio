// SftpTransport (decision #1, plan §13.4): the app connects to production with its own ed25519
// key, key-only, with the host key pinned on first use. Two remote folders: inbox/ and outbox/.
// Pending the VM: a real sshd chroot, and "production has no route to the app" (a firewall).
import { Client, type SFTPWrapper } from 'ssh2'
import { fingerprint, type HostPins } from './keys.ts'
import {
  checkCap,
  readCapped,
  TEMP_PREFIX,
  type Transport,
  TransportError,
  type TransportErrorCode,
  tooLarge,
  validateName,
  validatePrefix,
} from './types.ts'

export interface SftpOptions {
  host: string
  port?: number
  username: string
  /** OpenSSH PEM of the app's key. */
  privateKey: string
  pins: HostPins
  /** Key in the pin store. Default `host:port`. */
  pinId?: string
  connectTimeoutMs?: number
  opTimeoutMs?: number
}

const RETRIABLE: TransportErrorCode[] = ['connect-failed', 'timeout', 'connection-lost']
// SFTP status codes
const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3

type Entry = { filename: string; attrs: { isDirectory(): boolean } }

function sftpError(e: unknown, what: string): TransportError {
  if (e instanceof TransportError) return e
  const code = (e as { code?: unknown }).code
  if (code === NO_SUCH_FILE) return new TransportError('not-found', `${what}: not found`)
  if (code === PERMISSION_DENIED)
    return new TransportError('refused', `${what}: refused by the server`)
  const msg = (e as Error)?.message ?? String(e)
  if (/not connected|closed|ECONNRESET|EPIPE/i.test(msg)) {
    return new TransportError('connection-lost', `${what}: ${msg}`)
  }
  return new TransportError('failed', `${what}: ${msg}`)
}

function call<T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))))
}

export class SftpTransport implements Transport {
  private conn: { client: Client; sftp: SFTPWrapper } | undefined
  private connecting: Promise<SFTPWrapper> | undefined
  private readonly pinId: string
  private readonly connectTimeoutMs: number
  private readonly opTimeoutMs: number

  constructor(private readonly o: SftpOptions) {
    this.pinId = o.pinId ?? `${o.host}:${o.port ?? 22}`
    this.connectTimeoutMs = o.connectTimeoutMs ?? 10_000
    this.opTimeoutMs = o.opTimeoutMs ?? 30_000
  }

  private connect(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let seenFp: string | undefined
      let changed: { pinned: string; got: string } | undefined
      let settled = false
      const fail = (e: TransportError) => {
        if (settled) return
        settled = true
        client.end()
        reject(e)
      }
      client.on('error', (err: Error & { level?: string }) => {
        if (changed) {
          return fail(
            new TransportError(
              'host-key-changed',
              `the host key for ${this.pinId} changed (pinned ${changed.pinned}, got ${changed.got}); connection refused`,
            ),
          )
        }
        if (err.level === 'client-authentication') {
          return fail(new TransportError('auth-failed', 'the server refused the app key'))
        }
        if (err.level === 'client-timeout')
          return fail(new TransportError('timeout', 'connecting timed out'))
        fail(new TransportError('connect-failed', `could not connect: ${err.message}`))
      })
      client.on('close', () => {
        if (this.conn?.client === client) this.conn = undefined
        fail(new TransportError('connection-lost', 'the connection closed'))
      })
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err || settled)
            return fail(new TransportError('connect-failed', `no sftp subsystem: ${err?.message}`))
          // Trust on first use: pin only after the server accepted our key.
          if (seenFp && !this.o.pins.get(this.pinId)) this.o.pins.set(this.pinId, seenFp)
          settled = true
          this.conn = { client, sftp }
          resolve(sftp)
        })
      })
      client.connect({
        host: this.o.host,
        port: this.o.port ?? 22,
        username: this.o.username,
        privateKey: this.o.privateKey,
        authHandler: ['publickey'],
        readyTimeout: this.connectTimeoutMs,
        hostVerifier: (key: Buffer) => {
          const got = fingerprint(key)
          const pinned = this.o.pins.get(this.pinId)
          if (pinned && pinned !== got) {
            changed = { pinned, got }
            return false
          }
          seenFp = got
          return true
        },
      })
    })
  }

  private getSftp(): Promise<SFTPWrapper> {
    if (this.conn) return Promise.resolve(this.conn.sftp)
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private drop() {
    this.conn?.client.end()
    this.conn = undefined
  }

  /** Run an operation with a timeout and one retry for connection-level failures. */
  private async run<T>(what: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    let last: TransportError | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const sftp = await this.getSftp()
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new TransportError('timeout', `${what} timed out`)),
            this.opTimeoutMs,
          )
        })
        try {
          return await Promise.race([fn(sftp), timeout])
        } finally {
          clearTimeout(timer)
        }
      } catch (e) {
        last = sftpError(e, what)
        if (!RETRIABLE.includes(last.code)) throw last
        this.drop()
      }
    }
    throw last as TransportError
  }

  async putInbox(name: string, bytes: Uint8Array): Promise<void> {
    const { dir, base } = validateName(name)
    const folder = dir ? `inbox/${dir}` : 'inbox'
    const tmp = `${folder}/${TEMP_PREFIX}${base}`
    const final = `${folder}/${base}`
    await this.run(`put ${name}`, async (sftp) => {
      if (dir) await call((cb) => sftp.mkdir(folder, cb)).catch(() => {}) // exists, or the write reports it
      await call((cb) => sftp.writeFile(tmp, Buffer.from(bytes), cb))
      try {
        await call((cb) => sftp.rename(tmp, final, cb))
      } catch {
        // A plain SFTP rename refuses to replace; the name is ours, so clear it and rename again.
        try {
          await call((cb) => sftp.unlink(final, cb)).catch(() => {})
          await call((cb) => sftp.rename(tmp, final, cb))
        } catch (e) {
          await call((cb) => sftp.unlink(tmp, cb)).catch(() => {})
          throw e
        }
      }
    })
  }

  async listOutbox(prefix?: string): Promise<string[]> {
    const p = validatePrefix(prefix)
    return this.run('list outbox', async (sftp) => {
      const out: string[] = []
      const top = await call<Entry[]>((cb) => sftp.readdir('outbox', cb as never))
      for (const e of top) {
        if (e.filename.startsWith(TEMP_PREFIX)) continue
        if (e.attrs.isDirectory()) {
          const sub = await call<Entry[]>((cb) => sftp.readdir(`outbox/${e.filename}`, cb as never))
          for (const f of sub) {
            if (!f.attrs.isDirectory() && !f.filename.startsWith(TEMP_PREFIX))
              out.push(`${e.filename}/${f.filename}`)
          }
        } else out.push(e.filename)
      }
      return out.filter((n) => n.startsWith(p)).sort()
    })
  }

  async readOutbox(name: string, maxBytes: number): Promise<Uint8Array> {
    validateName(name)
    const cap = checkCap(maxBytes)
    return this.run(`read ${name}`, async (sftp) => {
      const handle = await call<Buffer>((cb) => sftp.open(`outbox/${name}`, 'r', cb as never))
      try {
        const st = await call<{ size?: number }>((cb) => sftp.fstat(handle, cb as never))
        // The size first; then a read loop that stops one byte past the cap whatever it said.
        if (typeof st.size === 'number' && st.size > cap) throw tooLarge(name, cap)
        return await readCapped(name, cap, (buf, length, position) =>
          call<number>((cb) =>
            sftp.read(handle, buf, 0, length, position, (err, got) => cb(err, got)),
          ),
        )
      } finally {
        await call((cb) => sftp.close(handle, cb)).catch(() => {})
      }
    })
  }

  async removeInbox(name: string): Promise<void> {
    validateName(name)
    try {
      // Only under inbox/: the VM's SFTP account may delete there and nowhere else.
      await this.run(`remove ${name}`, (sftp) => call((cb) => sftp.unlink(`inbox/${name}`, cb)))
    } catch (e) {
      if (e instanceof TransportError && e.code === 'not-found') return
      throw e
    }
  }

  async close(): Promise<void> {
    this.drop()
  }
}
