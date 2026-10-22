<script lang="ts">
// Site settings · Languages (decisions #9; design/prototype/AdminLanguages.dc.html; M7.11). Admin
// only. Which languages a site is published in: off by default; the default language is served at
// the root and every other language under its own subpath.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { session } from '../lib/session.svelte.ts'

type Lang = { code: string; name: string }
type Site = { id: string; name: string }
type Langs = { project: string; enabled: boolean; default: string | null; languages: Lang[]; subpaths: Record<string, string> }

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let sites = $state<Site[]>([])
let project = $state('')
let enabled = $state(false)
let languages = $state<Lang[]>([])
let def = $state<string | null>(null)
let newCode = $state('')
let newName = $state('')
let msg = $state<{ text: string; ok: boolean } | null>(null)
let busy = $state(false)

async function loadSite(id: string) {
  const r = await api<Langs>('GET', `/api/admin/languages/${encodeURIComponent(id)}`)
  if (!r.ok) {
    msg = { text: codeText((r.body as { code?: string }).code), ok: false }
    return
  }
  enabled = r.body.enabled
  languages = r.body.languages
  def = r.body.default
}

async function load() {
  const r = await api<{ projects: Site[] }>('GET', '/api/projects')
  if (!r.ok) {
    view = 'failed'
    return
  }
  sites = r.body.projects ?? []
  project = sites[0]?.id ?? ''
  if (project) await loadSite(project)
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

function add() {
  const code = newCode.trim().toLowerCase()
  if (!/^[a-z]{2,3}$/.test(code)) {
    msg = { text: s.code['bad-code'] ?? '', ok: false }
    return
  }
  if (languages.some((l) => l.code === code)) {
    msg = { text: s.code['duplicate-language'] ?? '', ok: false }
    return
  }
  languages = [...languages, { code, name: newName.trim() || code }]
  if (!def) def = code
  newCode = ''
  newName = ''
  msg = null
}
function remove(code: string) {
  languages = languages.filter((l) => l.code !== code)
  if (def === code) def = languages[0]?.code ?? null
}

async function save() {
  if (busy || !project) return
  busy = true
  const r = await api<Langs & { code?: string; message?: string }>('PUT', `/api/admin/languages/${encodeURIComponent(project)}`, {
    enabled,
    languages,
    default: def,
  })
  busy = false
  if (r.ok) {
    languages = r.body.languages
    def = r.body.default
    msg = { text: s.lgSaved, ok: true }
  } else msg = { text: r.body.message ?? codeText(r.body.code), ok: false }
}

const pathOf = (code: string) => (code === def ? s.lgRoot : `/${code}/`)
</script>

<AdminShell
  heading={s.lgHeading}
  kicker={s.lgKicker}
  sub={s.lgSub}
  active="languages"
  did={s.lgDid}
  state={view}
>
  {#if sites.length === 0}
    <p class="muted">{s.lgNoSites}</p>
  {:else}
    <section class="card ink" aria-labelledby="site-h">
      <div class="card-h">
        <Icon name="globe" />
        <h2 id="site-h" class="h2s" style="font-size: 22px">{s.lgSite}</h2>
        <label class="sr-only" for="site-pick">{s.lgSitePick}</label>
        <select id="site-pick" class="input" style="width: auto; min-width: 200px" bind:value={project} onchange={() => loadSite(project)}>
          {#each sites as x (x.id)}<option value={x.id}>{x.name} · {x.id}</option>{/each}
        </select>
        <button type="button" class="tgl" style="margin-left: auto" aria-pressed={enabled} onclick={() => (enabled = !enabled)}><span class="sw"></span><span class="small">{s.lgMulti}</span></button>
      </div>
      <div class="card-b">
        {#if !enabled}
          <p class="small">{s.lgSingle}</p>
        {/if}
        <div class="stack rise" style="gap: 14px">
          {#if languages.length === 0}<p class="small muted">{s.lgListEmpty}</p>{/if}
          <div class="rows small" data-testid="languages">
            {#each languages as l (l.code)}
              <div class="r lrow">
                <span><b>{l.name}</b> <span class="mono muted">{l.code}</span> {#if l.code === def}<span class="chip">{s.lgDefault}</span>{/if}</span>
                <span class="mono muted">{pathOf(l.code)}</span>
                <span class="row">
                  {#if l.code !== def}<button type="button" class="btn quiet" aria-label={afill(s.lgMakeDefault, { name: l.name })} onclick={() => (def = l.code)}>{s.lgMakeDefaultShort}</button>{/if}
                </span>
                <button type="button" class="btn quiet" aria-label={afill(s.lgRemove, { name: l.name })} onclick={() => remove(l.code)}>{s.lgRemoveShort}</button>
              </div>
            {/each}
          </div>
          <h3 class="label">{s.lgAddH}</h3>
          <div class="row" style="gap: 8px; align-items: flex-end">
            <div class="field" style="width: 120px"><label for="lc">{s.lgCode}</label><input id="lc" class="input mono" bind:value={newCode} maxlength="3" autocomplete="off" /></div>
            <div class="field" style="width: 220px"><label for="ln">{s.lgName}</label><input id="ln" class="input" bind:value={newName} placeholder={s.lgNameHelp} autocomplete="off" /></div>
            <button type="button" class="btn" onclick={add}>{s.lgAdd}</button>
          </div>
          <span class="small muted">{s.lgCodeHelp}</span>
        </div>
        {#if msg}<p class="amsg" class:okmsg={msg.ok} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>{/if}
      </div>
      <div class="card-f"><span class="note">{s.lgConseq}</span></div>
    </section>
  {/if}

  <div class="cols3">
    <section class="walllabel"><h2 class="label">{s.lgAddressH}</h2><p class="small">{s.lgAddressText}</p></section>
    <section class="walllabel"><h2 class="label">{s.lgSeoH}</h2><p class="small">{s.lgSeoText}</p></section>
    <section class="walllabel"><h2 class="label">{s.lgTranslatedH}</h2><p class="small">{s.lgTranslatedText}</p></section>
  </div>

  {#snippet bar()}
    <span class="conseq">{s.lgConseq}</span>
    <button type="button" class="btn primary" disabled={busy || !project} onclick={save}>{s.lgSave}</button>
  {/snippet}
</AdminShell>
