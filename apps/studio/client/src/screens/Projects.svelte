<script lang="ts">
import { toSlug } from '@site-studio/shared/slug'
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import TopBar from '../components/TopBar.svelte'
import { api } from '../lib/api.ts'
import { t } from '../lib/i18n.svelte.ts'
import { link, navigate } from '../lib/router.svelte.ts'

type Project = { id: string; name: string }
let projects = $state<Project[]>([])
let loaded = $state(false)
let name = $state('')
let taken = $state<{ slug: string; suggested: string; reserved?: boolean } | null>(null)
let failed = $state(false)
let busy = $state(false)
const slug = $derived(toSlug(name))
const createNote = $derived(t('pr.createNote', { slug: '\u0001' }).split('\u0001'))

$effect(() => {
  api<{ projects: Project[] }>('GET', '/api/projects').then((res) => {
    projects = res.body.projects ?? []
    loaded = true
  })
})

async function create(e: SubmitEvent) {
  e.preventDefault()
  if (!slug || busy) return
  busy = true
  failed = false
  const res = await api<{ id?: string; slug?: string; suggested?: string }>(
    'POST',
    '/api/projects',
    { name: name.trim() },
  )
  busy = false
  if (res.status === 201 && res.body.id) navigate(`/p/${res.body.id}`)
  else if (res.status === 409 && res.body.slug && res.body.suggested)
    taken = { slug: res.body.slug, suggested: res.body.suggested, reserved: res.body.reserved === true }
  else failed = true
}
</script>

<div class="app">
  <TopBar />
  <main class="main" style="border-top: 1px solid var(--rule-strong)">
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{t('pr.title')}</h1>
        <p class="muted">{t('pr.sub', { n: projects.length })}</p>
      </div>
    </div>

    <div class="split">
      <section class="card grow" aria-label={t('pr.title')}>
        {#if loaded && projects.length === 0}
          <div class="card-b"><p class="muted">{t('pr.none')}</p></div>
        {:else}
          <ul class="plist" style="padding: 0 18px">
            {#each projects as p (p.id)}
              <li>
                <a href="/p/{p.id}" use:link>
                  <span class="h2s">{p.name}</span><span class="id">{p.id}</span>
                  <span style="margin-left: auto"><Icon name="arrow-right" small /></span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="card side" aria-labelledby="n-h">
        <div class="card-h">
          <Icon name="plus" /><h2 id="n-h" class="h2s" style="font-size: 22px">{t('pr.newTitle')}</h2>
        </div>
        <form id="new-project" class="card-b" onsubmit={create}>
          <div class="field">
            <label for="pname">{t('pr.name')}</label>
            <input
              id="pname"
              class="input"
              type="text"
              autocomplete="off"
              bind:value={name}
              oninput={() => {
                taken = null
                failed = false
              }}
            />
          </div>
          <div class="slugbox" aria-live="polite">
            <span class="label">{t('pr.id')}</span>
            <span class="slug">{slug || '—'}</span>
            <span class="small muted">{t('pr.idHelp')}</span>
          </div>
          {#if taken}
            <div class="row small rise" style="gap: 8px; align-items: flex-start" role="alert">
              <span class="chip warn">{t(taken.reserved ? 'pr.reserved' : 'pr.taken', { slug: taken.slug })}</span>
              <span>{t('pr.suggested')} <span class="id">{taken.suggested}</span></span>
            </div>
          {/if}
          {#if failed}<p class="chip warn" role="alert">{t('err.generic')}</p>{/if}
        </form>
        <div class="card-f">
          {#if slug}<span class="note">{createNote[0]}<span class="mono">{slug}</span>{createNote[1]}</span>{/if}
        </div>
      </section>
    </div>
  </main>

  <DecisionBar did={t('pr.decideDid')}>
    <span class="conseq">{t('pr.decideConseq')}</span>
    <button class="btn primary" type="submit" form="new-project" disabled={!slug || busy}
      >{t('pr.create')}</button
    >
  </DecisionBar>
</div>
