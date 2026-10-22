<script lang="ts">
// Users and keys (plan §13.8; design/prototype/AdminUsers.dc.html; M7.10). Admin only. The Admin
// passkeys production trusts: add your own device (with a step-up by one of your approved keys),
// approve a new key, remove one. Each approval or removal is a signing request under the key rule.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { registerAnotherPasskey } from '../lib/passkey.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'
import { type SignOptions, signAndSend, when } from '../lib/signing.ts'

type Key = {
  keyId: string
  adminId: string
  name: string
  createdAt: string
  approvedAt: string | null
  removedAt: string | null
  status: 'approved' | 'waiting' | 'removed'
}

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let keys = $state<Key[]>([])
let keyRule = $state(1)
let newAdminNeeds = $state(1)
let busy = $state<string | null>(null)
let msg = $state<{ text: string; ok: boolean } | null>(null)

async function load() {
  const r = await api<{ keys: Key[]; keyRule: number; newAdminNeeds: number }>('GET', '/api/admin/keys')
  if (!r.ok) {
    view = 'failed'
    return
  }
  keys = r.body.keys
  keyRule = r.body.keyRule
  newAdminNeeds = r.body.newAdminNeeds
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

async function addDevice() {
  if (busy) return
  busy = 'add'
  msg = { text: s.usAdding, ok: true }
  const r = await registerAnotherPasskey()
  busy = null
  msg = r.ok ? { text: s.usAdded, ok: true } : { text: codeText(r.code), ok: false }
  await load()
}

async function act(k: Key, what: 'approve' | 'remove') {
  if (busy) return
  busy = `${what}-${k.keyId}`
  msg = { text: s.usSigning, ok: true }
  const r = await api<SignOptions & { code?: string }>(
    'POST',
    `/api/admin/keys/${encodeURIComponent(k.keyId)}/${what}`,
    {},
  )
  if (!r.ok) {
    busy = null
    msg = { text: codeText(r.body.code), ok: false }
    return
  }
  const done = await signAndSend(r.body)
  busy = null
  if (!done.ok) msg = { text: codeText(done.code), ok: false }
  else if (done.reply.body.complete) msg = { text: s.usComplete, ok: true }
  else {
    const sg = done.reply.body.signing
    msg = { text: sg ? afill(s.usSigned, { n: sg.signers.length, m: sg.needed }) : s.usHalf, ok: true }
  }
  await load()
}

const waiting = $derived(keys.filter((k) => k.status === 'waiting').length)
const keyName = (k: Key) => afill(s.usKey, { id: `${k.keyId.slice(0, 8)}…` })
</script>

<AdminShell
  heading={s.usHeading}
  kicker={s.kicker}
  sub={s.usSub}
  active="users"
  did={s.usDid}
  state={view}
>
  <section class="sec" aria-labelledby="h-keys">
    <div class="sec-h">
      <h2 id="h-keys" class="h2s">{s.usKeysH}</h2>
      <span class="small muted">{afill(s.usKeysSub, { n: keyRule })}</span>
    </div>
    {#if keys.length === 0}<p class="small muted">{s.usNone}</p>{/if}
    <div data-testid="keys">
      {#each keys as k (k.keyId)}
        <div class="keyrow">
          <span class="who">
            <Icon name="passkey" />
            <span class="stack" style="gap: 2px">
              <b>{k.adminId} · {keyName(k)}</b>
              <span class="small muted">{afill(s.usAddedAt, { at: when(k.createdAt) })}</span>
            </span>
          </span>
          <span class="row">
            <span class="chip" class:ok={k.status === 'approved'} class:warn={k.status === 'waiting'}>{s.usStatus[k.status]}</span>
            {#if k.status === 'waiting'}
              <button type="button" class="btn" disabled={!!busy} aria-label={afill(s.usApproveFor, { who: k.adminId })} onclick={() => act(k, 'approve')}><Icon name="passkey" small />{s.usApprove}</button>
            {/if}
            {#if k.status !== 'removed'}
              <button type="button" class="btn quiet" disabled={!!busy} aria-label={afill(s.usRemoveFor, { who: k.adminId })} onclick={() => act(k, 'remove')}>{s.usRemove}</button>
            {/if}
          </span>
        </div>
      {/each}
    </div>
    <p class="small muted">{s.usRemoveNote} {afill(s.usRule, { n: newAdminNeeds })}</p>
    {#if msg}<p class="amsg" class:okmsg={msg.ok} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>{/if}
  </section>

  <section class="card" aria-labelledby="h-add">
    <div class="card-h"><Icon name="plus" /><h2 id="h-add" style="font-size: 16px">{s.usAddH}</h2></div>
    <div class="card-b"><p class="small">{s.usAddText}</p></div>
    <div class="card-f">
      <span class="note">{waiting ? s.usStatus.waiting : ''}</span>
      <button type="button" class="btn" disabled={!!busy} onclick={addDevice}>{busy === 'add' ? s.usAdding : s.usAdd}</button>
    </div>
  </section>

  <p class="small muted offbox">{s.usNoTokenNote}</p>

  {#snippet bar()}
    <span class="conseq">{s.usConseq}</span>
    <a class="btn primary" href="/admin/governance" use:link>{s.usOpenGov}</a>
  {/snippet}
</AdminShell>
