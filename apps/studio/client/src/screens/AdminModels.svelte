<script lang="ts">
// Models (plan §15; design/prototype/AdminModels.dc.html; M8.5). Admin only. Endpoints with
// write-only keys, roles to endpoints, Test connection with the detected capability, and the
// Admin's override of it.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { errText, fmtAt } from '../lib/admin-format.ts'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { i18n } from '../lib/i18n.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Endpoint = {
  id: number
  name: string
  baseUrl: string
  model: string
  capability: string
  capabilityOverride: boolean
  keySet: boolean
  testedAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
}
type Fallback = { name: string; baseUrl: string; model: string; capability: string; keySet: boolean }
type Test = { ok: boolean; detected: string | null; capability: string; override: boolean; error: string | null; latencyMs: number }
type Msg = { text: string; ok: boolean } | null

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let endpoints = $state<Endpoint[]>([])
let roles = $state<Record<string, number | null>>({})
let roleNames = $state<string[]>([])
let fallback = $state<Fallback | null>(null)
let tests = $state<Record<number, Test | 'running'>>({})
let msg = $state<Msg>(null)
let rolesMsg = $state<Msg>(null)

let adding = $state(false)
let nName = $state('')
let nUrl = $state('')
let nKey = $state('')
let nModel = $state('')
let addMsg = $state<Msg>(null)

let editing = $state<number | null>(null)
let eName = $state('')
let eUrl = $state('')
let eModel = $state('')
let eKey = $state('')
let eRemoveKey = $state(false)
let eCap = $state('auto')
let editMsg = $state<Msg>(null)

async function load() {
  const r = await api<{ endpoints: Endpoint[]; roles: Record<string, number | null>; roleNames: string[]; fallback: Fallback | null }>(
    'GET',
    '/api/admin/models',
  )
  if (!r.ok) {
    view = 'failed'
    return
  }
  endpoints = r.body.endpoints
  roles = r.body.roles
  roleNames = r.body.roleNames
  fallback = r.body.fallback
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

async function add() {
  addMsg = null
  const r = await api<{ code?: string }>('POST', '/api/admin/models', {
    name: nName,
    baseUrl: nUrl,
    model: nModel,
    ...(nKey ? { apiKey: nKey } : {}),
  })
  nKey = ''
  if (!r.ok) {
    addMsg = { text: errText(r.body.code, s.mdCode), ok: false }
    return
  }
  nName = nUrl = nModel = ''
  adding = false
  msg = { text: s.mdEndpointAdded, ok: true }
  await load()
}

function startEdit(e: Endpoint) {
  editing = e.id
  eName = e.name
  eUrl = e.baseUrl
  eModel = e.model
  eKey = ''
  eRemoveKey = false
  eCap = e.capabilityOverride ? e.capability : 'auto'
  editMsg = null
}

async function saveEdit(e: Endpoint) {
  editMsg = null
  const body: Record<string, unknown> = { name: eName, baseUrl: eUrl, model: eModel }
  if (eRemoveKey) body.apiKey = null
  else if (eKey) body.apiKey = eKey
  if (eCap === 'auto') {
    if (e.capabilityOverride) body.capabilityOverride = false
  } else body.capability = eCap
  const r = await api<{ code?: string }>('PUT', `/api/admin/models/${e.id}`, body)
  eKey = ''
  if (!r.ok) {
    editMsg = { text: errText(r.body.code, s.mdCode), ok: false }
    return
  }
  editing = null
  msg = { text: s.mdEndpointSaved, ok: true }
  await load()
}

async function remove(e: Endpoint) {
  const r = await api<{ code?: string }>('DELETE', `/api/admin/models/${e.id}`)
  msg = r.ok ? { text: s.mdRemoved, ok: true } : { text: errText(r.body.code, s.mdCode), ok: false }
  await load()
}

async function test(e: Endpoint) {
  tests[e.id] = 'running'
  const r = await api<{ result?: Test; code?: string }>('POST', `/api/admin/models/${e.id}/test`)
  if (r.ok && r.body.result) tests[e.id] = r.body.result
  else {
    delete tests[e.id]
    msg = { text: errText(r.body.code, s.mdCode), ok: false }
  }
  await load()
}

async function saveRoles() {
  rolesMsg = null
  const r = await api<{ code?: string }>('PUT', '/api/admin/models/roles', roles)
  rolesMsg = r.ok ? { text: s.mdRolesSaved, ok: true } : { text: errText(r.body.code, s.mdCode), ok: false }
}

const capName = (c: string | null) => (c ? (s.mdCapNames[c] ?? c) : '')
const testText = (t: Test) =>
  t.ok
    ? t.override
      ? afill(s.mdTestOkOverride, { cap: capName(t.detected), ms: Math.round(t.latencyMs), used: capName(t.capability) })
      : afill(s.mdTestOk, { cap: capName(t.detected), ms: Math.round(t.latencyMs) })
    : afill(s.mdTestFail, { ms: Math.round(t.latencyMs) })
</script>

<AdminShell
  heading={s.mdHeading}
  kicker={s.kicker}
  sub={s.mdSub}
  active="models"
  did={s.mdDid}
  state={view}
>
  <section class="card" aria-labelledby="md-ep">
    <div class="card-h">
      <Icon name="model" />
      <h2 id="md-ep" class="h2s" style="font-size: 22px">{s.mdEndpointsH}</h2>
      <span class="m8-sub">{s.mdEndpointsSub}</span>
    </div>
    <div class="card-b" style="gap: 0">
      {#if fallback && endpoints.length === 0}
        <div class="m8-ep" data-testid="md-fallback">
          <div><span class="label">{s.mdFallback}</span><b>{fallback.name}</b></div>
          <div><span class="label">{s.mdUrl}</span><span class="mono small">{fallback.baseUrl}</span></div>
          <div><span class="label">{s.mdKey}</span><span><span class="chip">{fallback.keySet ? s.mdKeySet : s.mdKeyNone}</span></span></div>
          <div><span class="label">{s.mdModel}</span><span class="mono small">{fallback.model}</span></div>
          <div><span class="m8-sub">{s.mdFallbackNote}</span></div>
        </div>
      {/if}
      {#if endpoints.length === 0 && !fallback}<p class="small muted">{s.mdNone}</p>{/if}
      {#each endpoints as e (e.id)}
        {@const t = tests[e.id]}
        <div class="m8-ep" data-testid="md-endpoint">
          <div><span class="label">{s.mdName}</span><b>{e.name}</b></div>
          <div><span class="label">{s.mdUrl}</span><span class="mono small">{e.baseUrl}</span></div>
          <div><span class="label">{s.mdKey}</span><span><span class="chip" class:warn={!e.keySet}>{e.keySet ? s.mdKeySet : s.mdKeyNone}</span></span></div>
          <div>
            <span class="label">{s.mdModel}</span><span class="mono small">{e.model}</span>
            <span class="small"><span class="muted">{s.mdCapability}:</span> {capName(e.capability)}{e.capabilityOverride ? ` · ${s.mdCapOverride}` : ''}</span>
          </div>
          <div class="m8-acts">
            <button type="button" class="btn" disabled={t === 'running'} aria-label={afill(s.mdTestAria, { name: e.name })} onclick={() => test(e)}>{t === 'running' ? s.mdTesting : s.mdTest}</button>
            <button type="button" class="btn quiet" aria-label={afill(s.mdEditAria, { name: e.name })} onclick={() => (editing === e.id ? (editing = null) : startEdit(e))}>{s.m8Edit}</button>
            <button type="button" class="btn quiet" aria-label={afill(s.mdRemoveAria, { name: e.name })} onclick={() => remove(e)}>{s.m8Remove}</button>
          </div>
          <p class="small" style="grid-column: 1 / -1" role="status" data-testid="md-test-result">
            {#if t && t !== 'running'}
              <span class="chip" class:ok={t.ok} class:warn={!t.ok}>{testText(t)}</span>
              {#if !t.ok && t.error}<span class="muted"> {t.error}</span>{/if}
            {:else if e.testedAt}
              <span class="muted">{afill(e.lastTestOk ? s.mdTestedOk : s.mdTestedFail, { at: fmtAt(e.testedAt, i18n.lang) })}</span>
            {:else}
              <span class="muted">{s.mdNeverTested}</span>
            {/if}
          </p>
          {#if editing === e.id}
            <div class="m8-edit rise">
              <div class="fgrid">
                <div class="field"><label for="ed-n">{s.mdName}</label><input id="ed-n" class="input" bind:value={eName} autocomplete="off" /></div>
                <div class="field"><label for="ed-u">{s.mdUrl}</label><input id="ed-u" class="input mono" bind:value={eUrl} autocomplete="off" /></div>
                <div class="field"><label for="ed-m">{s.mdModel}</label><input id="ed-m" class="input mono" bind:value={eModel} autocomplete="off" /></div>
                <div class="field">
                  <label for="ed-k">{s.mdKeyNew}</label>
                  <input id="ed-k" class="input" type="password" bind:value={eKey} autocomplete="new-password" disabled={eRemoveKey} aria-describedby="ed-kh" />
                  <span id="ed-kh" class="m8-sub">{s.mdKeyKeep}</span>
                </div>
                <div class="field">
                  <label for="ed-c">{s.mdCapability}</label>
                  <select id="ed-c" class="input" bind:value={eCap} aria-describedby="ed-ch">
                    <option value="auto">{s.mdCapAuto}</option>
                    {#each Object.keys(s.mdCapNames) as c (c)}<option value={c}>{capName(c)}</option>{/each}
                  </select>
                  <span id="ed-ch" class="m8-sub">{s.mdCapNote}</span>
                </div>
              </div>
              {#if e.keySet}
                <label class="cb"><input type="checkbox" bind:checked={eRemoveKey} /><span>{s.mdKeyRemove}</span></label>
              {/if}
              {#if editMsg}<p class="amsg" role="alert">{editMsg.text}</p>{/if}
              <div class="row" style="justify-content: flex-end">
                <button type="button" class="btn quiet" aria-label={afill(s.mdCancelAria, { name: e.name })} onclick={() => (editing = null)}>{s.cancel}</button>
                <button type="button" class="btn" aria-label={afill(s.mdSaveAria, { name: e.name })} onclick={() => saveEdit(e)}>{s.mdSaveEndpoint}</button>
              </div>
            </div>
          {/if}
        </div>
      {/each}

      {#if adding}
        <div class="m8-edit rise" style="padding: 16px 0">
          <span class="label">{s.mdAddH}</span>
          <div class="fgrid">
            <div class="field"><label for="nw-n">{s.mdName}</label><input id="nw-n" class="input" bind:value={nName} autocomplete="off" /></div>
            <div class="field"><label for="nw-u">{s.mdUrl}</label><input id="nw-u" class="input mono" bind:value={nUrl} placeholder="https://[host]/v1" autocomplete="off" /></div>
            <div class="field">
              <label for="nw-k">{s.mdKey}</label>
              <input id="nw-k" class="input" type="password" bind:value={nKey} autocomplete="new-password" aria-describedby="nw-kh" />
              <span id="nw-kh" class="m8-sub">{s.mdKeyHelp}</span>
            </div>
            <div class="field"><label for="nw-m">{s.mdModel}</label><input id="nw-m" class="input mono" bind:value={nModel} autocomplete="off" /></div>
          </div>
          {#if addMsg}<p class="amsg" role="alert">{addMsg.text}</p>{/if}
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn quiet" onclick={() => (adding = false)}>{s.cancel}</button>
            <button type="button" class="btn" onclick={add}>{s.mdAddGo}</button>
          </div>
        </div>
      {/if}
      {#if msg}<p class="amsg" class:okmsg={msg.ok} role={msg.ok ? 'status' : 'alert'} style="margin-top: 12px">{msg.text}</p>{/if}
    </div>
    <div class="card-f">
      <span class="note">{s.mdAddConseq}</span>
      {#if !adding}<button type="button" class="btn" onclick={() => (adding = true)}>{s.mdAddGo}</button>{/if}
    </div>
  </section>

  <section class="card" aria-labelledby="md-roles">
    <div class="card-h">
      <h2 id="md-roles" class="h2s" style="font-size: 22px">{s.mdRolesH}</h2>
      <span class="m8-sub">{s.mdRolesSub}</span>
    </div>
    <div class="card-b tblwrap">
      <table class="tbl">
        <thead><tr><th scope="col">{s.mdColRole}</th><th scope="col">{s.mdColWhat}</th><th scope="col">{s.mdColEndpoint}</th></tr></thead>
        <tbody>
          {#each roleNames as r (r)}
            <tr>
              <td><span class="mono">{r}</span></td>
              <td class="small muted">{s.mdRoles[r] ?? ''}</td>
              <td style="min-width: 170px">
                <label class="sr-only" for="role-{r}">{afill(s.mdRoleFor, { role: r })}</label>
                <select id="role-{r}" class="input" bind:value={roles[r]}>
                  <option value={null}>{s.mdDefault}</option>
                  {#each endpoints as e (e.id)}<option value={e.id}>{e.name}</option>{/each}
                </select>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if rolesMsg}<p class="amsg" class:okmsg={rolesMsg.ok} role={rolesMsg.ok ? 'status' : 'alert'} style="margin-top: 12px">{rolesMsg.text}</p>{/if}
    </div>
  </section>

  {#snippet bar()}
    <span class="conseq">{s.mdConseq}</span>
    <button type="button" class="btn primary" onclick={saveRoles}>{s.mdSaveRoles}</button>
  {/snippet}
</AdminShell>
