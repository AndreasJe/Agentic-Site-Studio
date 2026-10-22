// A tiny SMTP sink: just enough of the protocol for nodemailer (EHLO, optional AUTH PLAIN or
// LOGIN, MAIL FROM, RCPT TO, DATA, QUIT). It keeps what it was sent. No TLS.
import { createServer, type Socket } from 'node:net'

export type SinkMessage = {
  from: string
  to: string[]
  data: string
  auth: { user: string; pass: string } | null
  /** The bearer token an AUTH XOAUTH2 login presented. */
  token?: string
}

export type SmtpSink = {
  port: number
  messages: SinkMessage[]
  close(): Promise<void>
}

const b64 = (s: string) => Buffer.from(s, 'base64').toString('utf8')

export async function startSmtpSink(
  opts: {
    auth?: { user: string; pass: string }
    /** Accept only AUTH XOAUTH2 with this user and bearer token (Microsoft 365 style). */
    oauth?: { user: string; token: string }
  } = {},
): Promise<SmtpSink> {
  const messages: SinkMessage[] = []
  const sockets = new Set<Socket>()
  const server = createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = ''
    let mode: 'cmd' | 'data' | 'auth-user' | 'auth-pass' | 'auth-plain' | 'auth-xoauth' = 'cmd'
    let cur: SinkMessage = { from: '', to: [], data: '', auth: null }
    let authed: { user: string; pass: string } | null = null
    let loginUser = ''
    let authedToken: string | undefined
    const say = (line: string) => sock.write(`${line}\r\n`)
    const finishOAuth = (b64text: string) => {
      // user=<mailbox>^Aauth=Bearer <token>^A^A
      const parts = b64(b64text).split(String.fromCharCode(1))
      const u = parts[0]?.startsWith('user=') ? parts[0].slice(5) : undefined
      const t = parts[1]?.startsWith('auth=Bearer ') ? parts[1].slice(12) : undefined
      if (!opts.oauth || u !== opts.oauth.user || t !== opts.oauth.token) {
        mode = 'cmd'
        return say('535 5.7.3 bad token')
      }
      authed = { user: u ?? '', pass: '' }
      authedToken = t
      mode = 'cmd'
      say('235 2.7.0 ok')
    }
    const finishAuth = (user: string, pass: string) => {
      if (opts.auth && (user !== opts.auth.user || pass !== opts.auth.pass)) {
        mode = 'cmd'
        return say('535 5.7.8 bad credentials')
      }
      authed = { user, pass }
      mode = 'cmd'
      say('235 2.7.0 ok')
    }
    say('220 sink ESMTP')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.')
          cur.auth = authed
          cur.token = authedToken
          buf = buf.slice(end + 5)
          messages.push(cur)
          cur = { from: '', to: [], data: '', auth: null }
          mode = 'cmd'
          say('250 2.0.0 queued')
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        if (mode === 'auth-user') {
          loginUser = b64(line)
          mode = 'auth-pass'
          say(`334 ${Buffer.from('Password:').toString('base64')}`)
          continue
        }
        if (mode === 'auth-pass') {
          finishAuth(loginUser, b64(line))
          continue
        }
        if (mode === 'auth-xoauth') {
          finishOAuth(line)
          continue
        }
        if (mode === 'auth-plain') {
          const [, user = '', pass = ''] = b64(line).split('\0')
          finishAuth(user, pass)
          continue
        }
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          const offer = `${opts.auth ? '250-AUTH PLAIN LOGIN\r\n' : ''}${opts.oauth ? '250-AUTH XOAUTH2\r\n' : ''}`
          sock.write(`250-sink\r\n${offer}250 8BITMIME\r\n`)
        } else if (upper.startsWith('AUTH XOAUTH2')) {
          const rest = line.slice(12).trim()
          if (rest) finishOAuth(rest)
          else {
            mode = 'auth-xoauth'
            say('334 ')
          }
        } else if (upper.startsWith('AUTH PLAIN')) {
          const rest = line.slice(10).trim()
          if (rest) {
            const [, user = '', pass = ''] = b64(rest).split('\0')
            finishAuth(user, pass)
          } else {
            mode = 'auth-plain'
            say('334 ')
          }
        } else if (upper.startsWith('AUTH LOGIN')) {
          mode = 'auth-user'
          say(`334 ${Buffer.from('Username:').toString('base64')}`)
        } else if (upper.startsWith('MAIL FROM:')) {
          if ((opts.auth || opts.oauth) && !authed) say('530 5.7.0 authentication required')
          else {
            cur.from =
              line
                .slice(10)
                .replace(/[<>\s]/g, '')
                .split(' ')[0] ?? ''
            say('250 ok')
          }
        } else if (upper.startsWith('RCPT TO:')) {
          cur.to.push(line.slice(8).replace(/[<>\s]/g, ''))
          say('250 ok')
        } else if (upper === 'DATA') {
          mode = 'data'
          say('354 go ahead')
        } else if (upper === 'QUIT') {
          say('221 bye')
          sock.end()
        } else if (upper === 'RSET' || upper === 'NOOP') {
          say('250 ok')
        } else {
          say('502 not implemented')
        }
      }
    })
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as { port: number }).port
  return {
    port,
    messages,
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy()
        server.close(() => res())
      }),
  }
}

/** Quoted-printable and header-folding undone, so a test can read what a person would. */
export function decodeBody(data: string): string {
  return data
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
}

export function subjectOf(data: string): string {
  const m = /^Subject: (.*(?:\r?\n[ \t].*)*)/im.exec(data)
  const raw = (m?.[1] ?? '').replace(/\?=\r?\n[ \t]+=\?/g, '?==?').replace(/\r?\n[ \t]/g, ' ')
  return raw.replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_x, enc: string, t: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(t, 'base64').toString('utf8')
      : Buffer.from(
          t
            .replace(/_/g, ' ')
            .replace(/=([0-9A-F]{2})/g, (_m, h: string) =>
              String.fromCharCode(Number.parseInt(h, 16)),
            ),
          'latin1',
        ).toString('utf8'),
  )
}
