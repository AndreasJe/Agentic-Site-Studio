<script lang="ts">
// Notifications and mail (plan §13.7; design/prototype/AdminMail.dc.html; M7.11). Admin only.
// SMTP settings with a write-only password, a test email to your own address, who gets mail and
// the mail log. Without a mail server the in-app inbox is all there is.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { session } from '../lib/session.svelte.ts'
import { when } from '../lib/signing.ts'

type Settings = {
  host: string
  port: number
  security: 'starttls' | 'tls' | 'none'
  user: string
  from: string
  fromName: string
  passwordSet: boolean
}
type Person = { handle: string; name: string; role: string; email: string | null }
type LogRow = { at: string; recipient: string; kind: string; ok: number; error: string | null }

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let host = $state('')
let port = $state('587')
let security = $state<'starttls' | 'tls' | 'none'>('starttls')
let user = $state('')
let from = $state('')
let fromName = $state('')
let password = $state('')
let passwordSet = $state(false)
let removePassword = $state(false)
let people = $state<Person[]>([])
let emails = $state<Record<string, string>>({})
let log = $state<LogRow[]>([])
let msg = $state<{ text: string; ok: boolean } | null>(null)
let busy = $state(false)
let peopleMsg = $state<Record<string, { text: string; ok: boolean }>>({})

async function load() {
  const [m, p, l] = await Promise.all([
    api<{ settings: Settings | null }>('GET', '/api/mail/settings'),
    api<{ people: Person[] }>('GET', '/api/mail/addresses'),
    api<{ log: LogRow[] }>('GET', '/api/mail/log'),
  ])
  if (!m.ok) {
    view = 'failed'
    return
  }
  const st = m.body.settings
  if (st) {
    host = st.host
    port = String(st.port)
    security = st.security
    user = st.user
    from = st.from
    fromName = st.fromName
    passwordSet = st.passwordSet
  }
  people = p.ok ? (p.body.people ?? []) : []
  emails = Object.fromEntries(people.map((x) => [x.handle, x.email ?? '']))
  log = l.ok ? (l.body.log ?? []) : []
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

async function save() {
  if (busy) return
  busy = true
  const r = await api<{ settings?: Settings; code?: string; message?: string }>('PUT', '/api/mail/settings', {
    host,
    port: Number(port),
    security,
    user,
    from,
    fromName,
    ...(removePassword ? { password: null } : password ? { password } : {}),
  })
  busy = false
  if (r.ok) {
    password = ''
    removePassword = false
    msg = { text: s.mlSaved, ok: true }
    await load()
  } else msg = { text: r.body.message ?? codeText(r.body.code), ok: false }
}

async function test() {
  if (busy) return
  busy = true
  msg = { text: s.mlTestSending, ok: true }
  const r = await api<{ code?: string; message?: string }>('POST', '/api/mail/test', {})
  busy = false
  msg = r.ok ? { text: s.mlTestOk, ok: true } : { text: r.body.message ?? codeText(r.body.code), ok: false }
  await load()
}

async function saveEmail(p: Person) {
  const v = (emails[p.handle] ?? '').trim()
  const r = await api<{ code?: string; message?: string }>('PUT', `/api/mail/addresses/${encodeURIComponent(p.handle)}`, {
    email: v === '' ? null : v,
  })
  peopleMsg[p.handle] = r.ok ? { text: s.mlEmailSaved, ok: true } : { text: r.body.message ?? codeText(r.body.code), ok: false }
}
</script>

<AdminShell
  heading={s.mlHeading}
  kicker={s.kicker}
  sub={s.mlSub}
  active="mail"
  did={s.mlDid}
  state={view}
>
  <section class="card" aria-labelledby="inbox-h">
    <div class="card-h"><Icon name="inbox" /><h2 id="inbox-h" class="h2s" style="font-size: 22px">{s.mlInboxH}</h2><span class="chip ok" style="margin-left: auto">{s.mlInboxOn}</span></div>
    <div class="card-b"><p class="small">{s.mlInboxText}</p></div>
  </section>

  <section class="card" aria-labelledby="mail-h">
    <div class="card-h"><Icon name="mail" /><h2 id="mail-h" class="h2s" style="font-size: 22px">{s.mlServerH}</h2><span class="small muted">{s.mlServerText}</span></div>
    <div class="card-b" style="gap: 18px">
      <div class="fgrid">
        <div class="field"><label for="host">{s.mlHost}</label><input class="input" id="host" bind:value={host} autocomplete="off" /></div>
        <div class="field"><label for="port">{s.mlPort}</label><input class="input mono" id="port" bind:value={port} inputmode="numeric" /></div>
        <div class="field">
          <span class="flabel" id="enc-l">{s.mlSecurity}</span>
          <div class="seg" role="group" aria-labelledby="enc-l" style="align-self: flex-start">
            <button type="button" aria-pressed={security === 'starttls'} onclick={() => (security = 'starttls')}>{s.mlStarttls}</button>
            <button type="button" aria-pressed={security === 'tls'} onclick={() => (security = 'tls')}>{s.mlTls}</button>
            <button type="button" aria-pressed={security === 'none'} onclick={() => (security = 'none')}>{s.mlNone}</button>
          </div>
        </div>
        <div class="field"><label for="user">{s.mlUser}</label><input class="input" id="user" bind:value={user} autocomplete="off" /></div>
        <div class="field">
          <label for="pw">{s.mlPassword}</label>
          <input class="input" id="pw" type="password" bind:value={password} autocomplete="new-password" placeholder={passwordSet ? s.mlPasswordSet : s.mlPasswordEmpty} disabled={removePassword} />
          {#if passwordSet}
            <label class="cb"><input type="checkbox" bind:checked={removePassword} /><span class="small">{s.mlPasswordRemove}</span></label>
            {#if removePassword}<span class="small muted">{s.mlPasswordRemoved}</span>{/if}
          {/if}
        </div>
        <div class="field"><label for="from">{s.mlFrom}</label><input class="input" id="from" bind:value={from} autocomplete="off" /></div>
        <div class="field"><label for="fromname">{s.mlFromName}</label><input class="input" id="fromname" bind:value={fromName} autocomplete="off" /></div>
      </div>
      <p class="small muted row" style="flex-wrap: nowrap; align-items: flex-start"><Icon name="lock" small />{s.mlStored}</p>
      {#if msg}<p class="amsg" class:okmsg={msg.ok} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>{/if}
    </div>
    <div class="card-f">
      <span class="note">{s.mlTestNote}</span>
      <button type="button" class="btn" disabled={busy} onclick={test}>{s.mlTest}</button>
    </div>
  </section>

  <section class="card" aria-labelledby="rcp-h">
    <div class="card-h"><h2 id="rcp-h" class="h2s" style="font-size: 22px">{s.mlPeopleH}</h2><span class="small muted">{s.mlPeopleSub}</span></div>
    <div class="card-b tblwrap">
      <table class="tbl">
        <thead><tr><th scope="col">{s.mlColPerson}</th><th scope="col">{s.mlColRole}</th><th scope="col">{s.mlColEmail}</th></tr></thead>
        <tbody>
          {#each people as p (p.handle)}
            <tr>
              <td><b>{p.name}</b><br /><span class="small muted mono">{p.handle}</span></td>
              <td><span class="chip">{s.mlRole[p.role] ?? p.role}</span></td>
              <td style="min-width: 260px">
                <div class="row" style="flex-wrap: nowrap">
                  <input class="input" type="email" aria-label={afill(s.mlEmailFor, { name: p.name })} bind:value={emails[p.handle]} autocomplete="off" />
                  <button type="button" class="btn" onclick={() => saveEmail(p)}>{s.mlEmailSave}</button>
                </div>
                {#if peopleMsg[p.handle]}<span class="small" role={peopleMsg[p.handle]?.ok ? 'status' : 'alert'}>{peopleMsg[p.handle]?.text}</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="stack" style="gap: 8px" aria-labelledby="log-h">
    <h2 id="log-h" class="h2s">{s.mlLogH}</h2>
    <p class="small muted">{s.mlLogSub}</p>
    {#if log.length === 0}<p class="small muted">{s.mlLogNone}</p>{:else}
      <div class="tblwrap">
        <table class="tbl">
          <thead><tr><th>{s.mlColWhen}</th><th>{s.mlColTo}</th><th>{s.mlColKind}</th><th>{s.mlColResult}</th></tr></thead>
          <tbody>
            {#each log.slice(0, 50) as l, i (i)}
              <tr><td class="mono small">{when(l.at)}</td><td>{l.recipient}</td><td class="mono small">{l.kind}</td><td><span class="chip" class:warn={!l.ok}>{l.ok ? s.mlLogOk : s.mlLogFailed}</span>{#if l.error}<br /><span class="small muted">{l.error}</span>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="walllabel" aria-labelledby="sec-h">
    <h2 id="sec-h" class="label">{s.mlSecurityH}</h2>
    <p class="small">{s.mlSecurityText}</p>
  </section>

  {#snippet bar()}
    <span class="conseq">{s.mlConseq}</span>
    <button type="button" class="btn primary" disabled={busy} onclick={save}>{s.mlSave}</button>
  {/snippet}
</AdminShell>
