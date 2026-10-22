// M7.7: mail and notifications (plan §13.7). SMTP settings with a write-only password, nodemailer
// against a local sink, templates whose links open pages only, and the smoke switch-back mail.
import { afterEach, describe, expect, test } from 'bun:test'
import { onOutboxEvent } from '../server/deploy/events.ts'
import { mailAdmins } from '../server/mail/send.ts'
import {
  MAIL_KINDS,
  MAIL_PAGE_PATH,
  type MailMessage,
  renderMail,
} from '../server/mail/templates.ts'
import { openItems } from '../server/release/inbox.ts'
import { APP, type World, world } from './helpers/deploy-world.ts'
import { decodeBody, type SmtpSink, startSmtpSink, subjectOf } from './helpers/smtp-sink.ts'

let w: World
let sink: SmtpSink | undefined
afterEach(async () => {
  await w?.cleanup()
  await sink?.close()
  sink = undefined
})

const SETTINGS = {
  host: '127.0.0.1',
  security: 'none',
  user: '',
  from: 'studio@example.test',
  fromName: 'Site Studio',
}

async function ready(opts: { auth?: { user: string; pass: string } } = {}) {
  w = await world({ agent: false })
  sink = await startSmtpSink(opts)
  const admin = w.as('admina')
  const put = await admin.call('PUT', '/api/mail/settings', {
    ...SETTINGS,
    port: sink.port,
    ...(opts.auth ? { user: opts.auth.user, password: opts.auth.pass } : {}),
  })
  expect(put.status).toBe(200)
  await admin.call('PUT', '/api/mail/addresses/admina', { email: 'a@example.test' })
  await admin.call('PUT', '/api/mail/addresses/adminb', { email: 'b@example.test' })
  return admin
}

const MESSAGES: MailMessage[] = [
  {
    kind: 'publication-requested',
    project: 'go',
    revision: 'go-r4',
    by: 'Alex',
    note: 'Ready. See http://evil.example/login now',
  },
  { kind: 'release-accepted', target: 'production', release: 7 },
  { kind: 'release-refused', target: 'production', release: 7, code: 'hash-mismatch' },
  { kind: 'release-refused', target: 'production', code: 'some-unknown-code <script>' },
  { kind: 'smoke-switched-back', target: 'production', release: 8, switchedBack: true },
  { kind: 'smoke-switched-back', target: 'production', release: 8, switchedBack: false },
  {
    kind: 'certificate-expiry',
    target: 'production',
    names: ['example.com'],
    notAfter: '2027-01-01T00:00:00Z',
    daysLeft: 12,
  },
  { kind: 'admin-key-added', admin: 'adminb', by: 'admina' },
  { kind: 'sent-back', project: 'go', by: 'Admin A', note: 'Fix the hero https://evil.example/x' },
]

describe('templates', () => {
  test('every template, in both languages, links to a page of the app and nothing else', () => {
    // One example per kind at least.
    expect(new Set(MESSAGES.map((m) => m.kind))).toEqual(new Set(MAIL_KINDS))
    for (const m of MESSAGES) {
      for (const lang of ['en', 'da'] as const) {
        const r = renderMail(m, lang, APP)
        const urls = [
          ...[...r.html.matchAll(/href="([^"]*)"/g)].map((x) =>
            (x[1] ?? '').replaceAll('&amp;', '&'),
          ),
          ...(r.text.match(/\bhttps?:\/\/\S+/g) ?? []),
        ].filter((u) => !u.includes('[:]//'))
        expect(urls.length).toBeGreaterThan(0)
        for (const u of urls) {
          const url = new URL(u)
          expect(url.origin).toBe(APP)
          expect(url.pathname).toMatch(MAIL_PAGE_PATH)
          expect(url.search).toBe('')
          expect(url.hash).toBe('')
          expect(url.username + url.password).toBe('')
          expect(url.pathname).not.toStartWith('/api')
        }
        // Every href is also the declared link.
        expect(new Set(urls)).toEqual(new Set(r.links))
        expect(r.html.match(/<a /g)).toHaveLength(1)
        expect(r.subject.length).toBeGreaterThan(5)
      }
    }
  })

  test('the review link names the revision and nothing more; a hostile revision falls back to the inbox', () => {
    const ok = renderMail(MESSAGES[0] as MailMessage, 'en', APP)
    expect(ok.links).toEqual([`${APP}/admin/review/go-r4`])
    for (const revision of ['../api/release', 'go-r4?token=abc', 'go-r4#x', 'GO-r4', '']) {
      const r = renderMail(
        { kind: 'publication-requested', project: 'go', revision, by: 'a' },
        'en',
        APP,
      )
      expect(r.links).toEqual([`${APP}/admin/inbox`])
    }
  })

  test("a Creator's note is plain text: escaped in HTML, links defused, never an anchor", () => {
    const r = renderMail(
      {
        kind: 'publication-requested',
        project: 'go',
        revision: 'go-r4',
        by: 'Alex <b>x</b>',
        note: '<a href="http://evil.example">click</a> https://evil.example/x www.evil.example',
      },
      'en',
      APP,
    )
    expect(r.html).not.toContain('<a href="http://evil')
    expect(r.html).not.toContain('<b>')
    expect(r.html).toContain('&lt;a href=')
    expect(r.text).not.toMatch(/https?:\/\/evil/)
    expect(r.text).not.toContain('www.evil')
    expect(r.html.match(/<a /g)).toHaveLength(1)
  })

  test('text that came from production is never shown raw', () => {
    const r = renderMail(
      { kind: 'release-refused', target: 'production', code: 'x <script>alert(1)</script>' },
      'en',
      APP,
    )
    expect(r.text + r.html).not.toContain('script')
    expect(r.text).not.toContain('alert')
  })

  test('Danish is a real translation, not the English text', () => {
    const en = renderMail(MESSAGES[4] as MailMessage, 'en', APP)
    const da = renderMail(MESSAGES[4] as MailMessage, 'da', APP)
    expect(da.subject).not.toBe(en.subject)
    expect(da.text).toContain('røgtest')
  })
})

describe('settings', () => {
  test('the password is stored encrypted and never returned', async () => {
    w = await world({ agent: false })
    const admin = w.as('admina')
    const secret = 'correct horse battery staple 9f3'
    const put = await admin.call('PUT', '/api/mail/settings', {
      ...SETTINGS,
      port: 2525,
      user: 'mailer',
      password: secret,
    })
    expect(put.status).toBe(200)
    expect(put.body.settings).toMatchObject({
      host: '127.0.0.1',
      port: 2525,
      user: 'mailer',
      passwordSet: true,
    })
    expect(JSON.stringify(put.body)).not.toContain(secret)
    const get = await admin.call('GET', '/api/mail/settings')
    expect(JSON.stringify(get.body)).not.toContain(secret)
    expect(get.body.settings.password).toBeUndefined()
    const stored = (
      w.db.query('select key, value from settings').all() as { key: string; value: string }[]
    )
      .map((r) => r.value)
      .join('\n')
    expect(stored).not.toContain(secret)
    // Saving again without a password keeps it; null removes it.
    const keep = await admin.call('PUT', '/api/mail/settings', {
      ...SETTINGS,
      port: 2525,
      user: 'mailer',
    })
    expect(keep.body.settings.passwordSet).toBe(true)
    const gone = await admin.call('PUT', '/api/mail/settings', {
      ...SETTINGS,
      port: 2525,
      user: 'mailer',
      password: null,
    })
    expect(gone.body.settings.passwordSet).toBe(false)
    // The audit log has the change, without the password.
    const log = JSON.stringify(w.db.query('select * from audit_log').all())
    expect(log).toContain('mail-settings.changed')
    expect(log).not.toContain(secret)
  })

  test('only Admins read or change mail settings and addresses; bad input is refused', async () => {
    w = await world({ agent: false })
    const alex = w.as('alex')
    expect((await alex.call('GET', '/api/mail/settings')).status).toBe(403)
    expect((await alex.call('PUT', '/api/mail/settings', { ...SETTINGS, port: 25 })).status).toBe(
      403,
    )
    expect(
      (await alex.call('PUT', '/api/mail/addresses/alex', { email: 'x@example.test' })).status,
    ).toBe(403)
    expect((await alex.call('POST', '/api/mail/test')).status).toBe(403)
    const admin = w.as('admina')
    for (const bad of [
      { ...SETTINGS, port: 0 },
      { ...SETTINGS, port: 25, host: 'bad host' },
      { ...SETTINGS, port: 25, security: 'ssl' },
      { ...SETTINGS, port: 25, from: 'not-an-address' },
      { ...SETTINGS, port: 25, fromName: 'a\r\nBcc: x@y.z' },
    ]) {
      expect((await admin.call('PUT', '/api/mail/settings', bad)).status).toBe(400)
    }
    expect((await admin.call('PUT', '/api/mail/addresses/alex', { email: 'a b@x' })).status).toBe(
      400,
    )
    expect(
      (await admin.call('PUT', '/api/mail/addresses/nobody', { email: 'a@example.test' })).status,
    ).toBe(404)
  })
})

describe('sending', () => {
  test('"Send test email" reaches the sink, with the saved sender', async () => {
    const admin = await ready()
    const r = await admin.call('POST', '/api/mail/test')
    expect(r.status).toBe(200)
    expect(sink?.messages).toHaveLength(1)
    const m = sink?.messages[0]
    expect(m?.to).toEqual(['a@example.test'])
    expect(m?.from).toBe('studio@example.test')
    expect(m?.data).toContain('Site Studio')
    expect(subjectOf(m?.data ?? '')).toBe('Test email')
    const log = await admin.call('GET', '/api/mail/log')
    expect(log.body.log[0]).toMatchObject({ recipient: 'a@example.test', kind: 'test', ok: 1 })
  })

  test('the SMTP user and password are used to sign in', async () => {
    const admin = await ready({ auth: { user: 'mailer', pass: 'pw-123' } })
    expect((await admin.call('POST', '/api/mail/test')).status).toBe(200)
    expect(sink?.messages[0]?.auth).toEqual({ user: 'mailer', pass: 'pw-123' })
  })

  test('a wrong password is a failure in the log, not a crash', async () => {
    w = await world({ agent: false })
    sink = await startSmtpSink({ auth: { user: 'mailer', pass: 'right' } })
    const admin = w.as('admina')
    await admin.call('PUT', '/api/mail/settings', {
      ...SETTINGS,
      port: sink.port,
      user: 'mailer',
      password: 'wrong',
    })
    await admin.call('PUT', '/api/mail/addresses/admina', { email: 'a@example.test' })
    const r = await admin.call('POST', '/api/mail/test')
    expect(r.status).toBe(502)
    expect(sink.messages).toHaveLength(0)
    const log = await admin.call('GET', '/api/mail/log')
    expect(log.body.log[0]).toMatchObject({ ok: 0 })
  })

  test('without mail settings nothing is sent and nothing breaks (the in-app inbox is the floor)', async () => {
    w = await world({ agent: false })
    const res = await mailAdmins(w.ctx, { appOrigin: APP }, MESSAGES[1] as MailMessage)
    expect(res.every((r) => !r.ok && r.reason !== 'failed')).toBe(true)
    const admin = w.as('admina')
    expect((await admin.call('POST', '/api/mail/test')).status).toBe(409) // no address yet
  })

  test('mail goes to Admins in their own language', async () => {
    await ready()
    w.db.query("update users set language = 'da' where handle = 'adminb'").run()
    await mailAdmins(w.ctx, { appOrigin: APP }, MESSAGES[1] as MailMessage)
    const bySubject = Object.fromEntries(
      (sink?.messages ?? []).map((m) => [m.to[0], subjectOf(m.data)]),
    )
    expect(bySubject['a@example.test']).toBe('Release 7 is live on production')
    expect(bySubject['b@example.test']).toBe('Udgivelse 7 er i luften på production')
  })
})

describe('smoke test switch-back', () => {
  test('a failed smoke test that switched production back emails every Admin and notifies', async () => {
    await ready()
    await onOutboxEvent(
      { ctx: w.ctx, issuer: null, mail: { appOrigin: APP } },
      { kind: 'smoke', target: 'production', release: 9, ok: false, switchedBack: true, body: {} },
    )
    expect(sink?.messages.map((m) => m.to[0]).sort()).toEqual(['a@example.test', 'b@example.test'])
    for (const m of sink?.messages ?? []) {
      expect(subjectOf(m.data)).toBe('Smoke test failed: production switched back')
      const body = decodeBody(m.data)
      expect(body).toContain('switched back')
      expect(body).toContain(`${APP}/admin/inbox`)
      expect(body).not.toMatch(/token|\?/i.test('') ? /$^/ : /\/api\//)
    }
    const items = openItems(w.ctx).filter((i) => i.kind === 'smoke-failed')
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toContain('switched back')
  })

  test('with nothing to switch back to, the mail says the site is offline', async () => {
    await ready()
    await onOutboxEvent(
      { ctx: w.ctx, issuer: null, mail: { appOrigin: APP } },
      { kind: 'smoke', target: 'production', release: 1, ok: false, switchedBack: false, body: {} },
    )
    expect(subjectOf(sink?.messages[0]?.data ?? '')).toBe(
      'Smoke test failed: production is offline',
    )
  })

  test('a passing smoke test sends nothing from here', async () => {
    await ready()
    await onOutboxEvent(
      { ctx: w.ctx, issuer: null, mail: { appOrigin: APP } },
      { kind: 'smoke', target: 'production', release: 9, ok: true, switchedBack: false, body: {} },
    )
    expect(sink?.messages).toHaveLength(0)
    expect(openItems(w.ctx).filter((i) => i.kind === 'smoke-failed')).toHaveLength(0)
  })
})
