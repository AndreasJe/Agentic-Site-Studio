<script lang="ts">
// The Media library (plan §6.8; design/prototype/Media.dc.html): the organisation's library and
// each project's, a grid, upload, and a detail panel. Alt text is written by a person.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import TopBar from '../components/TopBar.svelte'
import { api, upload } from '../lib/api.ts'
import { CATEGORY_KEYS, mfill, mm } from '../lib/media-strings.ts'
import { session } from '../lib/session.svelte.ts'

type Item = {
  id: number
  title: string
  alt: string
  category: string
  subject: string
  rights: string
  allowedUse: string
  licenceExpires: string | null
  expiry: 'expired' | 'expiring' | null
  hash: string
  mime: string
  size: number
  filename: string
  blocked: boolean
  archived: boolean
  usedIn?: string[]
  versions?: { hash: string; filename: string; at: string; by: string }[]
}
type Project = { id: string; name: string }

const s = $derived(mm())
let level = $state<'org' | 'project'>('org')
let projects = $state<Project[]>([])
let project = $state('')
let items = $state<Item[]>([])
let loaded = $state(false)
let failed = $state(false)
let category = $state('all')
let showArchived = $state(false)
let selectedId = $state<number | null>(null)
let detail = $state<Item | null>(null)
let form = $state({
  title: '',
  alt: '',
  category: 'free',
  subject: '',
  rights: '',
  allowedUse: '',
  licenceExpires: '',
})
let message = $state<{ text: string; ok: boolean } | null>(null)
let busy = $state(false)
let over = $state(false)
let fileInput: HTMLInputElement | undefined = $state()
let replaceInput: HTMLInputElement | undefined = $state()

const isAdmin = $derived(session.user?.role === 'admin')
const base = $derived(level === 'org' ? '/api/media' : `/api/p/${project}/media`)
const canWrite = $derived(level === 'project' ? !!project : isAdmin)
const active = $derived(level === 'org' || !!project)
const shown = $derived(items.filter((i) => category === 'all' || i.category === category))
const count = (c: string) => items.filter((i) => c === 'all' || i.category === c).length
const fileUrl = (i: Item) => `${base}/${i.id}/file?v=${i.hash.slice(7, 19)}`

$effect(() => {
  api<{ projects: Project[] }>('GET', '/api/projects').then((r) => {
    projects = r.body.projects ?? []
    if (!project && projects[0]) project = projects[0].id
  })
})

async function load() {
  if (!active) {
    items = []
    loaded = true
    return
  }
  const r = await api<{ items: Item[] }>('GET', `${base}${showArchived ? '?archived=1' : ''}`)
  failed = !r.ok
  items = r.body.items ?? []
  loaded = true
  if (selectedId !== null && !items.some((i) => i.id === selectedId)) pick(null)
}

$effect(() => {
  void base
  void showArchived
  loaded = false
  load()
})

function fill(i: Item) {
  form = {
    title: i.title,
    alt: i.alt,
    category: i.category,
    subject: i.subject,
    rights: i.rights,
    allowedUse: i.allowedUse,
    licenceExpires: i.licenceExpires ?? '',
  }
}

async function pick(id: number | null) {
  selectedId = id
  detail = null
  if (id === null) return
  const r = await api<{ item: Item }>('GET', `${base}/${id}`)
  if (r.ok && selectedId === id) {
    detail = r.body.item
    fill(detail)
  }
}

function say(text: string, ok = true) {
  message = { text, ok }
}
const problem = (code: unknown) => {
  const key = `err.${String(code)}` as keyof typeof s
  return typeof s[key] === 'string' ? (s[key] as string) : s['err.other']
}

function merge(i: Item) {
  items = items.map((x) => (x.id === i.id ? i : x))
  if (!showArchived && i.archived) items = items.filter((x) => x.id !== i.id)
  detail = i
  fill(i)
}

async function send(files: FileList | File[] | null) {
  if (!files || !canWrite || busy) return
  busy = true
  message = null
  for (const file of Array.from(files)) {
    const f = new FormData()
    f.append('file', file)
    const r = await upload<{ item?: Item; code?: string }>(base, f)
    if (r.ok && r.body.item) {
      items = [r.body.item, ...items]
      say(mfill(s.uploaded, { name: file.name }))
      await pick(r.body.item.id)
    } else say(`${file.name}: ${problem(r.body.code)}`, false)
  }
  busy = false
  if (fileInput) fileInput.value = ''
}

async function replaceWith(files: FileList | null) {
  const file = files?.[0]
  if (!file || !detail || busy) return
  busy = true
  const f = new FormData()
  f.append('file', file)
  const r = await upload<{ item?: Item; code?: string }>(`${base}/${detail.id}/replace`, f)
  busy = false
  if (replaceInput) replaceInput.value = ''
  if (r.ok && r.body.item) {
    merge(r.body.item)
    say(mfill(s.replaced, { name: file.name }))
  } else say(problem(r.body.code), false)
}

async function save(e: Event) {
  e.preventDefault()
  if (!detail || busy) return
  busy = true
  const r = await api<{ item?: Item; code?: string }>('PUT', `${base}/${detail.id}`, {
    ...form,
    licenceExpires: form.licenceExpires || null,
  })
  busy = false
  if (r.ok && r.body.item) {
    merge(r.body.item)
    say(s.saved)
  } else say(problem(r.body.code), false)
}

async function act(name: 'block' | 'unblock' | 'archive' | 'unarchive') {
  if (!detail || busy) return
  busy = true
  const r = await api<{ item?: Item; code?: string }>('POST', `${base}/${detail.id}/${name}`, {})
  busy = false
  if (r.ok && r.body.item) {
    merge(r.body.item)
    say(
      { block: s.blocked, unblock: s.unblocked, archive: s.archived, unarchive: s.restored }[name],
    )
  } else say(problem(r.body.code), false)
}

const dateOf = (d: string | null) => d ?? ''
const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
</script>

<div class="app">
  <TopBar />
  <main class="main" style="border-top: 1px solid var(--rule-strong)">
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{s.title}</h1>
        <p class="muted">{s.sub}</p>
      </div>
      <div class="row">
        <div class="seg" role="group" aria-label={s.levels}>
          <button type="button" class:on={level === 'org'} aria-pressed={level === 'org'} onclick={() => (level = 'org')}>{s.org}</button>
          <button type="button" class:on={level === 'project'} aria-pressed={level === 'project'} onclick={() => (level = 'project')}>{s.project}</button>
        </div>
        {#if level === 'project' && projects.length}
          <label class="sr" for="m-project">{s.pickProject}</label>
          <select id="m-project" class="input" style="width: auto" bind:value={project}>
            {#each projects as p (p.id)}<option value={p.id}>{p.name} · {p.id}</option>{/each}
          </select>
        {/if}
      </div>
    </div>

    {#if level === 'project' && !projects.length && loaded}
      <p class="muted">{s.noProjects}</p>
    {:else}
      <div class="split">
        <section class="grow stack" style="gap: 20px" aria-label={s.items}>
          {#if canWrite}
            <div
              class="drop"
              class:over
              role="group"
              aria-label={s.drop}
              ondragover={(e) => { e.preventDefault(); over = true }}
              ondragleave={() => (over = false)}
              ondrop={(e) => { e.preventDefault(); over = false; send(e.dataTransfer?.files ?? null) }}
            >
              <Icon name="upload" />
              <span class="stack" style="gap: 2px; flex: 1 1 320px">
                <b style="font-weight: 600">{s.drop}</b>
                <span class="small muted">{s.dropNote}</span>
              </span>
              <input
                bind:this={fileInput}
                class="sr"
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                aria-label={s.uploadInput}
                tabindex="-1"
                onchange={() => send(fileInput?.files ?? null)}
              />
              <button class="btn" type="button" disabled={busy} onclick={() => fileInput?.click()}>{s.choose}</button>
            </div>
          {:else}
            <p class="small muted">{s.readOnlyOrg}</p>
          {/if}

          {#if message}<p role="alert" class="msg" class:okmsg={message.ok}>{message.text}</p>{/if}

          <div class="row" style="justify-content: space-between">
            <div class="filt" role="group" aria-label={s.category}>
              {#each ['all', ...CATEGORY_KEYS] as c (c)}
                <button type="button" class:on={category === c} aria-pressed={category === c} onclick={() => (category = c)}
                  >{c === 'all' ? s.all : s.cat[c]}<span class="ct">{count(c)}</span></button
                >
              {/each}
            </div>
            <label class="small row" style="gap: 8px; min-height: 44px"
              ><input type="checkbox" bind:checked={showArchived} />{s.showArchived}</label
            >
          </div>
          <p class="small muted">{s.restricted}</p>

          {#if failed}
            <p role="alert" class="msg">{s.loadError}</p>
          {:else if loaded && shown.length === 0}
            <p class="muted">{s.empty}</p>
          {/if}
          <div class="tiles">
            {#each shown as it (it.id)}
              <button type="button" class="tile" class:sel={it.id === selectedId} aria-pressed={it.id === selectedId} onclick={() => pick(it.id)}>
                <span class="thumb"><img src={fileUrl(it)} alt="" loading="lazy" /></span>
                <span class="tt">{it.title}</span>
                <span class="row" style="gap: 6px">
                  <span class="chip">{s.cat[it.category] ?? it.category}</span>
                  {#if it.blocked}<span class="chip sig">{s.blockedChip}</span>{/if}
                  {#if it.archived}<span class="chip">{s.archivedChip}</span>{/if}
                  {#if it.expiry}<span class="chip warn">{it.expiry === 'expired' ? s.expired : s.expiring}</span>{/if}
                </span>
              </button>
            {/each}
          </div>
        </section>

        <aside class="side" aria-label={s.selected}>
          {#if detail}
            <form class="card ink rise" aria-labelledby="sel-h" onsubmit={save}>
              <div class="preview"><img src={fileUrl(detail)} alt={detail.alt} /></div>
              <div class="card-b">
                <div class="stack" style="gap: 4px">
                  <h2 id="sel-h" class="h2s">{detail.title}</h2>
                  <span class="mono small muted">{detail.filename} · {detail.mime} · {sizeOf(detail.size)}</span>
                </div>
                {#if detail.expiry}
                  <div class="chip warn callout">
                    <Icon name="warn" small />{mfill(detail.expiry === 'expired' ? s.expiredNote : s.expiringNote, { date: dateOf(detail.licenceExpires) })}
                  </div>
                {/if}
                {#if detail.blocked}<div class="chip sig callout">{s.blockedNote}</div>{/if}
                <fieldset disabled={!canWrite || detail.archived} class="fs">
                  <div class="field"><label for="m-title">{s.fTitle}</label><input id="m-title" class="input" bind:value={form.title} /></div>
                  <div class="field">
                    <label for="m-alt">{s.fAlt}</label>
                    <textarea id="m-alt" class="input" aria-describedby="m-alt-h" bind:value={form.alt}></textarea>
                    <span id="m-alt-h" class="small muted">{s.altHelp}</span>
                  </div>
                  <div class="field">
                    <label for="m-cat">{s.fCategory}</label>
                    <select id="m-cat" class="input" bind:value={form.category}>
                      {#each CATEGORY_KEYS as c (c)}<option value={c}>{s.cat[c]}</option>{/each}
                    </select>
                  </div>
                  <div class="field">
                    <label for="m-subject">{s.fSubject}</label>
                    <input id="m-subject" class="input" aria-describedby="m-subject-h" bind:value={form.subject} />
                    <span id="m-subject-h" class="small muted">{s.subjectHelp}</span>
                  </div>
                  <div class="field">
                    <label for="m-rights">{s.fRights}</label>
                    <input id="m-rights" class="input" aria-describedby="m-rights-h" bind:value={form.rights} />
                    <span id="m-rights-h" class="small muted">{s.rightsHelp}</span>
                  </div>
                  <div class="field">
                    <label for="m-allowed">{s.fAllowed}</label>
                    <input id="m-allowed" class="input" aria-describedby="m-allowed-h" bind:value={form.allowedUse} />
                    <span id="m-allowed-h" class="small muted">{s.allowedHelp}</span>
                  </div>
                  <div class="field">
                    <label for="m-expires">{s.fExpires}</label>
                    <input id="m-expires" class="input" type="date" bind:value={form.licenceExpires} />
                  </div>
                </fieldset>
                <div class="stack" style="gap: 6px">
                  <span class="label">{s.usedIn}</span>
                  <div class="rows small">
                    {#each detail.usedIn ?? [] as u (u)}<div class="r"><span class="mono" style="font-size: 12.5px">{u}</span></div>{:else}<div class="r muted">{s.usedNone}</div>{/each}
                  </div>
                </div>
                <div class="stack" style="gap: 6px">
                  <span class="label">{s.versions}</span>
                  <div class="rows small">
                    {#each detail.versions ?? [] as v (v.hash + v.at)}<div class="r"><span class="mono" style="font-size: 12.5px">{v.filename} · {v.by} · {v.at.slice(0, 10)}</span></div>{/each}
                  </div>
                  <span class="small muted">{s.versionsNote}</span>
                </div>
              </div>
              <div class="card-f">
                <span class="note">{s.archiveNote}</span>
                {#if canWrite}
                  {#if detail.archived}
                    <button type="button" class="btn quiet" disabled={busy} onclick={() => act('unarchive')}>{s.unarchive}</button>
                  {:else}
                    <button type="button" class="btn quiet" disabled={busy} onclick={() => act(detail?.blocked ? 'unblock' : 'block')}>{detail.blocked ? s.unblock : s.block}</button>
                    <input
                      bind:this={replaceInput}
                      class="sr"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      aria-label={s.replaceInput}
                      tabindex="-1"
                      onchange={() => replaceWith(replaceInput?.files ?? null)}
                    />
                    <button type="button" class="btn" disabled={busy} onclick={() => replaceInput?.click()}>{s.replace}</button>
                    <button type="button" class="btn danger" disabled={busy} onclick={() => act('archive')}>{s.archive}</button>
                  {/if}
                {/if}
              </div>
            </form>
          {:else}
            <p class="muted">{s.pick}</p>
          {/if}
        </aside>
      </div>
    {/if}
  </main>
  <DecisionBar did={s.did}>
    <span class="conseq">{s.saveNote}</span>
    <button class="btn primary" type="button" disabled={!detail || !canWrite || detail.archived || busy} onclick={save}>{s.save}</button>
  </DecisionBar>
</div>

<style>
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 20px; }
.tile { display: flex; flex-direction: column; gap: 8px; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; min-width: 0; }
.tile:focus-visible { outline: var(--focus); outline-offset: var(--focus-offset); }
.thumb { aspect-ratio: 4 / 3; background: var(--mat); display: grid; place-items: center; overflow: hidden; outline: 1px solid transparent; outline-offset: 3px; transition: outline-color var(--t-ui); }
.tile.sel .thumb { outline: 2px solid var(--ink); }
.thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.tt { font-size: 13.5px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.filt { display: flex; flex-wrap: wrap; gap: 6px; }
.filt button { min-height: 40px; padding: 0 12px; border: 1px solid var(--rule-strong); background: var(--sheet); cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.filt button.on { background: var(--ink); color: var(--sheet); border-color: var(--ink); }
.filt .ct { font-family: var(--font-mono); font-size: 11px; }
.drop { border: 1px dashed var(--caption); background: var(--sheet); padding: 18px 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; transition: background var(--t-ui); }
.drop.over { background: var(--fill); }
.preview { background: var(--mat); padding: 20px; display: grid; place-items: center; aspect-ratio: 16 / 9; }
.preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
.fs { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.callout { white-space: normal; line-height: 1.4; padding: 8px 10px; }
.msg { border: 1px solid var(--signal); color: var(--signal-ink); padding: 8px 12px; margin: 0; }
.okmsg { border-color: var(--rule-strong); color: var(--ink); }
</style>
