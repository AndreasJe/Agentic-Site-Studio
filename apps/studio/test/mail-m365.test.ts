// Decisions 14 and 16: "sent back" mail to the Creator, and Microsoft 365 (OAuth) as a mail
// transport, tested against a mock token endpoint and the local SMTP sink (AUTH XOAUTH2).
import { afterEach, describe, expect, test } from 'bun:test'
import { clearTokenCache } from '../server/mail/oauth.ts'
import { type MailDeps, sendMail } from '../server/mail/send.ts'
import { type MailMessage, renderMail } from '../server/mail/templates.ts'
import { openItems } from '../server/release/inbox.ts'
import { APP, type World, world } from './helpers/deploy-world.ts'
import { type Fixture, releaseFixture } from './helpers/release-fixture.ts'
import { decodeBody, type SmtpSink, startSmtpSink, subjectOf } from './helpers/smtp-sink.ts'

let w: World | undefined
let f: Fixture | undefined
let sink: SmtpSink | undefined
let tokens: ReturnType<typeof Bun.serve> | undefined
afterEach(async () => {
  await w?.cleanup()
  await f?.cleanup()
  await sink?.close()
  tokens?.stop(true)
  w = f = sink = tokens = undefined
  clearTokenCache()
})

const SMTP = {
  host: '127.0.0.1',
  security: 'none',
  user: '',
  from: 's@example.test',
  fromName: 'S',
}

describe('sent back to the Creator', () => {
  test('the template links to Staging only and carries the note as plain text', () => {
    const m: MailMessage = {
      kind: 'sent-back',
      project: 'go',
      by: 'Admin <b>A</b>',
      note: '<a href="http://evil.example">x</a> www.evil.example',
    }
    for (const lang of ['en', 'da'] as const) {
      const r = renderMail(m, lang, APP)
      expect(r.links).toEqual([`${APP}/p/go/staging`])
      expect(r.html).not.toContain('<a href="http://evil')
      expect(r.html).not.toContain('<b>')
      expect(r.text).not.toContain('www.evil')
      expect(r.html.match(/<a /g)).toHaveLength(1)
    }
    expect(renderMail(m, 'en', APP).subject).toBe('Sent back: go')
    expect(renderMail(m, 'da', APP).subject).toBe('Sendt tilbage: go')
    // A hostile project id never becomes a path.
    const bad = renderMail({ ...m, project: 'go/../api?x=1' }, 'en', APP)
    expect(bad.links).toEqual([`${APP}/admin/inbox`])
  })

  test('send back emails the Creator who asked, with the note, and adds an inbox item', async () => {
    f = await releaseFixture()
    sink = await startSmtpSink()
    const admin = f.as('admina')
    expect((await admin('PUT', '/api/mail/settings', { ...SMTP, port: sink.port })).status).toBe(
      200,
    )
    // A Creator sets their own address; they cannot set anyone else's.
    const own = await f.alex('PUT', '/api/mail/me/address', { email: 'alex@example.test' })
    expect(own.status).toBe(200)
    const bad = await f.alex('PUT', '/api/mail/me/address', { email: 'not an address' })
    expect(bad.status).toBe(400)
    const other = await f.alex('PUT', '/api/mail/addresses/admina', { email: 'x@example.test' })
    expect(other.status).toBe(403)
    const { requestId } = await f.stageAndRequest()
    const r = await admin('POST', `/api/admin/review/${requestId}/send-back`, {
      note: 'The hero image is wrong. See http://evil.example/login',
    })
    expect(r.status).toBe(200)
    for (let i = 0; i < 50 && !sink.messages.length; i++) await Bun.sleep(40)
    expect(sink.messages).toHaveLength(1)
    const m = sink.messages[0]
    expect(m?.to).toEqual(['alex@example.test'])
    const body = decodeBody(m?.data ?? '')
    expect(body).toContain('The hero image is wrong')
    expect(body).toContain(`${f.APP}/p/go/staging`)
    expect(body).not.toContain('http://evil')
    expect(openItems(f.ctx).find((i) => i.kind === 'sent-back')?.ref).toContain('alex')
  })

  test('a Creator without an address still gets the inbox item, and nothing breaks', async () => {
    f = await releaseFixture()
    sink = await startSmtpSink()
    const admin = f.as('admina')
    await admin('PUT', '/api/mail/settings', { ...SMTP, port: sink.port })
    const { requestId } = await f.stageAndRequest()
    const r = await admin('POST', `/api/admin/review/${requestId}/send-back`, { note: 'No' })
    expect(r.status).toBe(200)
    await Bun.sleep(150)
    expect(sink.messages).toHaveLength(0)
    expect(openItems(f.ctx).some((i) => i.kind === 'sent-back')).toBe(true)
  })
})

describe('Microsoft 365 (OAuth)', () => {
  const MAILBOX = 'studio@contoso.test'
  const M365 = {
    transport: 'm365',
    tenantId: 'contoso.test',
    clientId: '11111111-2222-3333-4444-555555555555',
    clientSecret: 'client-secret-xyz-123',
    from: MAILBOX,
    fromName: 'Site Studio',
  }

  /** A mock token endpoint; counts calls and records what it was asked. */
  function mockTokens(o: { ttl?: number; status?: number } = {}) {
    const seen: { path: string; form: URLSearchParams }[] = []
    let n = 0
    tokens = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ path: new URL(req.url).pathname, form: new URLSearchParams(await req.text()) })
        if (o.status)
          return Response.json(
            { error: 'invalid_client', error_description: 'x' },
            { status: o.status },
          )
        n++
        return Response.json({ access_token: `tok-${n}`, expires_in: o.ttl ?? 3600 })
      },
    })
    return { seen, base: `http://127.0.0.1:${tokens.port}`, count: () => n }
  }

  const depsFor = (base: string, port: number, now?: () => number): MailDeps => ({
    appOrigin: APP,
    m365: {
      tokenUrl: (t) => `${base}/${t}/oauth2/v2.0/token`,
      smtp: { host: '127.0.0.1', port, security: 'none' },
      now,
    },
  })
  const content = { subject: 'Hi', text: 'There' }

  test('settings: the secret is sealed and never returned; empty fields are refused', async () => {
    w = await world({ agent: false })
    const admin = w.as('admina')
    expect((await admin.call('PUT', '/api/mail/settings', { ...M365, tenantId: '' })).status).toBe(
      400,
    )
    expect((await admin.call('PUT', '/api/mail/settings', { ...M365, clientId: '' })).status).toBe(
      400,
    )
    expect((await admin.call('PUT', '/api/mail/settings', { ...M365, from: 'nope' })).status).toBe(
      400,
    )
    const put = await admin.call('PUT', '/api/mail/settings', M365)
    expect(put.status).toBe(200)
    expect(put.body.settings).toMatchObject({
      transport: 'm365',
      tenantId: 'contoso.test',
      host: 'smtp.office365.com',
      port: 587,
      security: 'starttls',
      user: MAILBOX,
      clientSecretSet: true,
    })
    expect(JSON.stringify(put.body)).not.toContain(M365.clientSecret)
    const stored = (w.db.query('select value from settings').all() as { value: string }[])
      .map((r) => r.value)
      .join('\n')
    expect(stored).not.toContain(M365.clientSecret)
    const audit = JSON.stringify(w.db.query('select * from audit_log').all())
    expect(audit).not.toContain(M365.clientSecret)
    // Saving without a secret keeps it; null removes it.
    const { clientSecret: _s, ...noSecret } = M365
    const keep = await admin.call('PUT', '/api/mail/settings', noSecret)
    expect(keep.body.settings.clientSecretSet).toBe(true)
    const gone = await admin.call('PUT', '/api/mail/settings', { ...noSecret, clientSecret: null })
    expect(gone.body.settings.clientSecretSet).toBe(false)
  })

  test('a token from the endpoint signs in with XOAUTH2; it is cached until it expires', async () => {
    w = await world({ agent: false })
    const t = mockTokens({ ttl: 3600 })
    sink = await startSmtpSink({ oauth: { user: MAILBOX, token: 'tok-1' } })
    await w.as('admina').call('PUT', '/api/mail/settings', M365)
    let clock = 1_000_000
    const deps = depsFor(t.base, sink.port, () => clock)
    expect((await sendMail(w.ctx, deps, 'a@example.test', 'test', content)).ok).toBe(true)
    expect(sink.messages[0]?.token).toBe('tok-1')
    expect(t.seen[0]?.path).toBe('/contoso.test/oauth2/v2.0/token')
    expect(Object.fromEntries(t.seen[0]?.form ?? [])).toEqual({
      grant_type: 'client_credentials',
      client_id: M365.clientId,
      client_secret: M365.clientSecret,
      scope: 'https://outlook.office365.com/.default',
    })
    // Within the lifetime: no second call.
    clock += 3000 * 1000
    expect((await sendMail(w.ctx, deps, 'a@example.test', 'test', content)).ok).toBe(true)
    expect(t.count()).toBe(1)
    // Past it (with a minute's margin): a fresh token, which this sink refuses (it wants tok-1).
    clock += 600 * 1000
    const again = await sendMail(w.ctx, deps, 'a@example.test', 'test', content)
    expect(t.count()).toBe(2)
    expect(again.ok).toBe(false)
  })

  test('a refused sign-in is a failure in the log that never shows the secret', async () => {
    w = await world({ agent: false })
    const t = mockTokens({ status: 401 })
    sink = await startSmtpSink({ oauth: { user: MAILBOX, token: 'tok-1' } })
    await w.as('admina').call('PUT', '/api/mail/settings', M365)
    const r = await sendMail(w.ctx, depsFor(t.base, sink.port), 'a@example.test', 'test', content)
    expect(r).toMatchObject({ ok: false, reason: 'failed' })
    expect(sink.messages).toHaveLength(0)
    const log = JSON.stringify(w.db.query('select * from mail_log').all())
    expect(log).toContain('invalid_client')
    expect(log).not.toContain(M365.clientSecret)
  })

  test('without a secret nothing is requested', async () => {
    w = await world({ agent: false })
    const t = mockTokens()
    sink = await startSmtpSink({ oauth: { user: MAILBOX, token: 'tok-1' } })
    const { clientSecret: _s, ...noSecret } = M365
    await w.as('admina').call('PUT', '/api/mail/settings', noSecret)
    const r = await sendMail(w.ctx, depsFor(t.base, sink.port), 'a@example.test', 'test', content)
    expect(r.ok).toBe(false)
    expect(t.count()).toBe(0)
  })

  test('"Send test email" works over Microsoft 365', async () => {
    const t = mockTokens()
    sink = await startSmtpSink({ oauth: { user: MAILBOX, token: 'tok-1' } })
    w = await world({ agent: false, mail: depsFor(t.base, sink.port) })
    const admin = w.as('admina')
    expect((await admin.call('PUT', '/api/mail/settings', M365)).status).toBe(200)
    await admin.call('PUT', '/api/mail/addresses/admina', { email: 'a@example.test' })
    expect((await admin.call('POST', '/api/mail/test')).status).toBe(200)
    expect(sink.messages[0]?.to).toEqual(['a@example.test'])
    expect(sink.messages[0]?.token).toBe('tok-1')
    expect(subjectOf(sink.messages[0]?.data ?? '')).toBe('Test email')
  })
})
