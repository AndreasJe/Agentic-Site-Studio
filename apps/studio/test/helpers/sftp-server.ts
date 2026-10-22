// A local SFTP server for tests (ssh2 Server). Stands in for production's sshd:
// - ed25519 host key; only the configured client public key is accepted, passwords are refused;
// - SFTP only: shell, exec and pty are refused;
// - `/inbox` and `/outbox` map to two temp folders; any other path is refused (a simulated chroot);
// - the client may write only to inbox and read only outbox.
// Pending the VM: a real sshd chroot, and "production has no route to the app" (a firewall).
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Server, utils } from 'ssh2'
import { fingerprint } from '../../server/transport/keys.ts'

const { STATUS_CODE, flagsToString } = utils.sftp

export interface ServerOp {
  op: 'open-write' | 'open-read' | 'write' | 'rename' | 'mkdir' | 'remove' | 'opendir' | 'refused'
  path?: string
  to?: string
}

export interface TestSftpServer {
  port: number
  host: string
  inboxDir: string
  outboxDir: string
  /** OpenSSH-style fingerprint of the host key. */
  hostFingerprint: string
  /** Everything the client did, in order. */
  ops: ServerOp[]
  /** Called before every write chunk is stored; for atomicity checks. */
  onWrite?: (path: string) => void
  /** Bytes the server has sent in answer to READ requests. */
  bytesRead: number
  /** Tests: the size FSTAT reports instead of the real one (a server that lies). */
  fstatSize?: (path: string) => number | undefined
  close(): Promise<void>
}

export function generateKeyPair(): { private: string; public: string } {
  return utils.generateKeyPairSync('ed25519')
}

export async function startSftpServer(opts: {
  clientPublicKey: string
  hostKey?: { private: string; public: string }
}): Promise<TestSftpServer> {
  const root = mkdtempSync(join(tmpdir(), 'studio-sftp-'))
  const inboxDir = join(root, 'inbox')
  const outboxDir = join(root, 'outbox')
  mkdirSync(inboxDir)
  mkdirSync(outboxDir)
  const hostKey = opts.hostKey ?? generateKeyPair()
  const allowed = utils.parseKey(opts.clientPublicKey)
  if (allowed instanceof Error) throw allowed
  const allowedKey = Array.isArray(allowed) ? allowed[0] : allowed
  const hostPub = utils.parseKey(hostKey.public)
  const hostPubKey = Array.isArray(hostPub) ? hostPub[0] : hostPub
  if (hostPubKey instanceof Error) throw hostPubKey

  const ops: ServerOp[] = []
  const state: TestSftpServer = {
    port: 0,
    host: '127.0.0.1',
    inboxDir,
    outboxDir,
    hostFingerprint: fingerprint(hostPubKey.getPublicSSH()),
    ops,
    bytesRead: 0,
    close: async () => {},
  }

  /** Map a client path to a real one, or refuse. Returns the area it falls in. */
  function resolve(p: string): { area: 'root' | 'inbox' | 'outbox'; real: string } | null {
    if (p.includes('\\') || p.includes('\0') || p.split('/').includes('..')) return null
    const norm = posix.normalize(`/${p}`).replace(/\/+$/, '') || '/'
    if (norm === '/') return { area: 'root', real: root }
    const [, top, ...rest] = norm.split('/')
    if (top !== 'inbox' && top !== 'outbox') return null
    if (rest.some((s) => s === '' || s === '.')) return null
    return { area: top, real: join(top === 'inbox' ? inboxDir : outboxDir, ...rest) }
  }

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      const same =
        ctx.key.algo === allowedKey?.type &&
        Buffer.compare(ctx.key.data, allowedKey.getPublicSSH()) === 0
      if (!same) return ctx.reject(['publickey'])
      if (
        ctx.signature &&
        allowedKey?.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) !== true
      ) {
        return ctx.reject(['publickey'])
      }
      ctx.accept()
    })
    client.on('error', () => {})
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (_a, reject) => reject())
        session.on('shell', (_a, reject) => reject())
        session.on('pty', (_a, reject) => reject())
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const files = new Map<string, { fd: number; path: string; write: boolean }>()
          const dirs = new Map<string, { entries: string[]; real: string; done: boolean }>()
          let n = 0
          const newHandle = () => Buffer.from(String(++n))
          const refuse = (reqid: number, op: ServerOp['op'], path: string) => {
            ops.push({ op: 'refused', path })
            void op
            sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
          }
          const attrsOf = (real: string) => {
            const st = statSync(real)
            return {
              mode: st.mode,
              uid: 0,
              gid: 0,
              size: st.size,
              atime: st.atimeMs / 1000,
              mtime: st.mtimeMs / 1000,
            }
          }

          sftp.on('REALPATH', (reqid, path) => {
            const r = resolve(path === '.' ? '/' : path)
            if (!r) return refuse(reqid, 'refused', path)
            const name = posix.normalize(`/${path === '.' ? '' : path}`)
            sftp.name(reqid, [{ filename: name, longname: name, attrs: {} as never }])
          })
          const stat = (reqid: number, path: string) => {
            const r = resolve(path)
            if (!r) return refuse(reqid, 'refused', path)
            try {
              sftp.attrs(reqid, attrsOf(r.real))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          }
          sftp.on('STAT', stat)
          sftp.on('LSTAT', stat)
          sftp.on('OPEN', (reqid, path, flags) => {
            const r = resolve(path)
            if (!r || r.area === 'root') return refuse(reqid, 'refused', path)
            const mode = flagsToString(flags) ?? 'r'
            const write = mode !== 'r'
            if (write && r.area !== 'inbox') return refuse(reqid, 'refused', path)
            if (!write && r.area !== 'outbox') return refuse(reqid, 'refused', path)
            try {
              const fd = openSync(r.real, mode)
              const h = newHandle()
              files.set(h.toString(), { fd, path, write })
              ops.push({ op: write ? 'open-write' : 'open-read', path })
              sftp.handle(reqid, h)
            } catch (e) {
              sftp.status(
                reqid,
                (e as NodeJS.ErrnoException).code === 'ENOENT'
                  ? STATUS_CODE.NO_SUCH_FILE
                  : STATUS_CODE.FAILURE,
              )
            }
          })
          sftp.on('FSTAT', (reqid, handle) => {
            const f = files.get(handle.toString())
            if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE)
            const st = fstatSync(f.fd)
            const size = state.fstatSize?.(f.path) ?? st.size
            sftp.attrs(reqid, { mode: st.mode, uid: 0, gid: 0, size, atime: 0, mtime: 0 })
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const f = files.get(handle.toString())
            if (!f || f.write) return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            const got = readSync(f.fd, buf, 0, length, offset)
            if (got === 0) return sftp.status(reqid, STATUS_CODE.EOF)
            state.bytesRead += got
            sftp.data(reqid, buf.subarray(0, got))
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const f = files.get(handle.toString())
            if (!f || !f.write) return sftp.status(reqid, STATUS_CODE.FAILURE)
            state.onWrite?.(f.path)
            ops.push({ op: 'write', path: f.path })
            writeSync(f.fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
          sftp.on('CLOSE', (reqid, handle) => {
            const key = handle.toString()
            const f = files.get(key)
            if (f) {
              closeSync(f.fd)
              files.delete(key)
            }
            dirs.delete(key)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('OPENDIR', (reqid, path) => {
            const r = resolve(path)
            if (!r) return refuse(reqid, 'refused', path)
            if (r.area === 'inbox') return refuse(reqid, 'refused', path) // write-only
            try {
              const entries = r.area === 'root' ? ['inbox', 'outbox'] : readdirSync(r.real)
              const h = newHandle()
              dirs.set(h.toString(), { entries, real: r.real, done: false })
              ops.push({ op: 'opendir', path })
              sftp.handle(reqid, h)
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READDIR', (reqid, handle) => {
            const d = dirs.get(handle.toString())
            if (!d || d.done) return sftp.status(reqid, STATUS_CODE.EOF)
            d.done = true
            sftp.name(
              reqid,
              d.entries.map((filename) => {
                const attrs = attrsOf(join(d.real, filename))
                return { filename, longname: filename, attrs }
              }),
            )
          })
          sftp.on('MKDIR', (reqid, path) => {
            const r = resolve(path)
            if (!r || r.area !== 'inbox') return refuse(reqid, 'refused', path)
            if (existsSync(r.real)) return sftp.status(reqid, STATUS_CODE.FAILURE)
            mkdirSync(r.real)
            ops.push({ op: 'mkdir', path })
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('REMOVE', (reqid, path) => {
            const r = resolve(path)
            if (!r || r.area !== 'inbox') return refuse(reqid, 'refused', path)
            try {
              unlinkSync(r.real)
              ops.push({ op: 'remove', path })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('RMDIR', (reqid, path) => {
            const r = resolve(path)
            if (!r || r.area !== 'inbox') return refuse(reqid, 'refused', path)
            try {
              rmdirSync(r.real)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('RENAME', (reqid, from, to) => {
            const a = resolve(from)
            const b = resolve(to)
            if (!a || !b || a.area !== 'inbox' || b.area !== 'inbox')
              return refuse(reqid, 'refused', from)
            if (existsSync(b.real)) return sftp.status(reqid, STATUS_CODE.FAILURE) // like OpenSSH: no replace
            try {
              renameSync(a.real, b.real)
              ops.push({ op: 'rename', path: from, to })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('SETSTAT', (reqid, path) => refuse(reqid, 'refused', path))
          sftp.on('READLINK', (reqid, path) => refuse(reqid, 'refused', path))
          sftp.on('SYMLINK', (reqid, path) => refuse(reqid, 'refused', path))
          sftp.on('error', () => {})
        })
      })
    })
  })

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  state.port = (server.address() as { port: number }).port
  state.close = async () => {
    await new Promise<void>((res) => server.close(() => res()))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  return state
}
