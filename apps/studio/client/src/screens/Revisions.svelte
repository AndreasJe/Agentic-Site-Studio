<script lang="ts">
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { t } from '../lib/i18n.svelte.ts'
import { session } from '../lib/session.svelte.ts'

let { id, current, onchange }: { id: string; current: string | null; onchange: () => void } =
  $props()

type Entry = { id: string; parent: string | null; by: string; msg: string; archived: boolean }
type Detail = {
  id: string
  parent: string | null
  by: string
  at: string
  msg?: string
  phase: string
  files: Record<string, string>
}
type Draft = { base: string | null; files: Record<string, string> }

let entries = $state<Entry[]>([])
let selected = $state<string | null>(null)
let detail = $state<Detail | null>(null)
let readOnly = $state(false)
let draft = $state<Draft | null>(null)
let message = $state('')
let confirming = $state(false)
let note = $state<string | null>(null)
let loadFailed = $state(false)
let busy = $state(false)

const short = (rev: string) => rev.slice(id.length + 1)
const sel = $derived(entries.find((e) => e.id === selected) ?? null)
const canSave = $derived(message.trim().length > 2 && !busy)
const isCurrent = $derived(selected !== null && selected === current)

async function loadTimeline(select?: string) {
  const res = await api<{ revisions: Entry[]; current: string | null }>(
    'GET',
    `/api/p/${id}/revisions`,
  )
  if (!res.ok) {
    loadFailed = true
    return
  }
  entries = res.body.revisions
  selected = select ?? (entries.some((e) => e.id === selected) ? selected : res.body.current)
}

async function loadDraft() {
  const res = await api<Draft>('GET', `/api/p/${id}/draft`)
  if (res.ok) draft = res.body
}

$effect(() => {
  loadTimeline()
  loadDraft()
})

// The selected revision's files (read-only; there is no route that changes a revision).
$effect(() => {
  const rev = selected
  detail = null
  if (!rev) return
  api<Detail>('GET', `/api/p/${id}/revisions/${rev}`).then((res) => {
    if (res.ok && selected === rev) detail = res.body
  })
})

async function run(fn: () => Promise<void>) {
  busy = true
  note = null
  await fn()
  busy = false
}

const pick = (rev: string) => {
  selected = rev
  readOnly = false
}

const continueFrom = () =>
  run(async () => {
    if (!selected) return
    const res = await api<{ revision?: string }>(
      'POST',
      `/api/p/${id}/revisions/${selected}/continue`,
    )
    if (!res.ok || !res.body.revision) {
      note = t('err.generic')
      return
    }
    readOnly = false
    await Promise.all([loadTimeline(res.body.revision), loadDraft()])
    note = t('rv.continued', { id: res.body.revision })
    onchange()
  })

const toggleArchive = () =>
  run(async () => {
    if (!sel) return
    const res = await api('POST', `/api/p/${id}/revisions/${sel.id}/archive`, {
      archived: !sel.archived,
    })
    if (!res.ok) note = t('err.generic')
    else await loadTimeline()
  })

const saveDraft = () =>
  run(async () => {
    const res = await api<{ revision?: string; warning?: string }>(
      'POST',
      `/api/p/${id}/draft/save`,
      { msg: message.trim() },
    )
    if (!res.ok || !res.body.revision) {
      note = t('err.generic')
      return
    }
    message = ''
    await Promise.all([loadTimeline(res.body.revision), loadDraft()])
    note =
      t('rv.saved', { id: res.body.revision }) +
      (res.body.warning === 'base-not-current' ? ` ${t('rv.baseWarn')}` : '')
    onchange()
  })

const discardDraft = () =>
  run(async () => {
    const res = await api('DELETE', `/api/p/${id}/draft`)
    confirming = false
    if (!res.ok) {
      note = t('err.generic')
      return
    }
    await loadDraft()
    note = t('rv.discarded')
  })
</script>

<main class="main">
  <div class="pagehead">
    <div class="stack" style="gap: 6px; max-width: 760px">
      <h1>{t('rv.title')}</h1>
      <p class="muted">{t('rv.intro')}</p>
    </div>
    <div class="legend">
      <span><i class="dot" aria-hidden="true"></i>{t('rv.legendRevision')}</span>
      <span><i class="dot" style="background: var(--signal); border-color: var(--signal)" aria-hidden="true"></i>{t('rv.legendCurrent')}</span>
      <span>{t('rv.legendNothing')}</span>
    </div>
  </div>

  {#if loadFailed}<p role="alert">{t('rv.loadError')}</p>{/if}

  {#if readOnly && detail}
    <div class="ro rise" role="status">
      <Icon name="review" />
      <span>{t('rv.roBanner', { id: detail.id })}</span>
      <button class="btn quiet" style="margin-left: auto" type="button" onclick={() => (readOnly = false)}
        >{t('rv.closeRo')}</button
      >
    </div>
    <section class="card" aria-label={t('rv.files')}>
      {#each Object.entries(detail.files) as [path, content] (path)}
        <div class="card-b">
          <span class="id" style="align-self: flex-start">{path}</span>
          <pre class="fileview">{content}</pre>
        </div>
      {:else}
        <div class="card-b"><p class="muted">{t('rv.noFiles')}</p></div>
      {/each}
    </section>
  {/if}

  <section class="card" aria-labelledby="dr-h">
    <div class="card-h">
      <h2 id="dr-h" class="label">{t('rv.draftTitle')}</h2>
      <span class="small muted" style="margin-left: auto">{t('rv.draftNoLocks')}</span>
    </div>
    <div class="card-b" style="gap: 0; padding-top: 4px; padding-bottom: 4px">
      <div class="rows small" style="border-top: 0">
        <div class="r">
          <span class="avatar" aria-hidden="true">{(session.user?.name ?? '').slice(0, 2).toUpperCase()}</span>
          <b>{t('rv.draftTitle')}</b>
          <span class="muted">{t('rv.basedOn')}</span>
          {#if draft?.base}<span class="id">{draft.base}</span>{:else}<span class="muted"
              >{t('rv.noBase')}</span
            >{/if}
          <span class="muted">· {Object.keys(draft?.files ?? {}).length === 1 ? t('rv.changedOne') : t('rv.changed', { n: Object.keys(draft?.files ?? {}).length })}</span>
          <span class="chip" style="margin-left: auto">{t('rv.onlyYou')}</span>
        </div>
      </div>
      {#if confirming}
        <div class="stack rise" style="gap: 8px; padding: 12px 0" role="alertdialog" aria-labelledby="dc-h">
          <b id="dc-h">{t('rv.discardAsk')}</b>
          <p class="small muted">{t('rv.discardConseq')}</p>
          <div class="row">
            <button class="btn danger" type="button" disabled={busy} onclick={discardDraft}
              >{t('rv.discardYes')}</button
            >
            <button class="btn" type="button" onclick={() => (confirming = false)}
              >{t('rv.discardKeep')}</button
            >
          </div>
        </div>
      {/if}
    </div>
    <div class="card-f">
      <span class="note" role="status">{note ?? ''}</span>
      {#if !confirming}
        <button class="btn" type="button" onclick={() => (confirming = true)}
          >{t('rv.discard')}</button
        >
      {/if}
    </div>
  </section>

  <div class="split">
    <section class="grow card" aria-labelledby="tl-h">
      <div class="card-h"><h2 id="tl-h" class="label">{t('rv.timeline')}</h2></div>
      <div class="tl">
        {#each entries as e (e.id)}
          <button
            type="button"
            class="rv"
            class:cur={e.id === current}
            class:arch={e.archived}
            aria-pressed={e.id === selected}
            onclick={() => pick(e.id)}
          >
            <span class="stack" style="gap: 2px; min-width: 0">
              <span class="row" style="gap: 10px"
                ><span class="id">{e.id}</span><span class="meta">{e.by}</span></span
              >
              <span class="msg">{e.msg || '—'}</span>
            </span>
            <span class="chips">
              {#if e.id === current}<span class="chip sig">{t('rv.current')}</span>{/if}
              {#if e.archived}<span class="chip">{t('rv.archived')}</span>{/if}
            </span>
          </button>
        {/each}
      </div>
    </section>

    <aside class="side stack" style="gap: 20px" aria-label={t('rv.selected')}>
      {#if sel}
        <section class="card ink">
          <div class="card-b">
            <span class="id" style="align-self: flex-start">{sel.id}</span>
            <h2 class="h2s">{sel.msg || '—'}</h2>
            <div class="small muted">
              {sel.by}{detail ? ` · ${detail.at.slice(0, 16).replace('T', ' ')} · ${detail.phase}` : ''}
              · {sel.parent ? t('rv.parent', { id: sel.parent }) : t('rv.noParent')}
            </div>
            <span class="label" style="margin-top: 4px">{t('rv.files')}</span>
            <div class="files">
              {#each Object.keys(detail?.files ?? {}) as path (path)}
                <span class="f">{path}</span>
              {:else}
                {#if detail}<span class="f">{t('rv.noFiles')}</span>{/if}
              {/each}
            </div>
          </div>
          <div class="card-f">
            <span class="note"
              >{isCurrent
                ? t('rv.contNoteCurrent', { id: short(sel.id) })
                : t('rv.contNote', { id: sel.id })}</span
            >
            <button class="btn" type="button" disabled={!detail} onclick={() => (readOnly = true)}
              >{t('rv.openRo')}</button
            >
            <button class="btn primary" type="button" disabled={isCurrent || busy} onclick={continueFrom}
              >{t('rv.continue')}</button
            >
          </div>
        </section>

        <section class="walllabel" aria-labelledby="arch-h">
          <h2 id="arch-h" class="label">{t('rv.archiveTitle')}</h2>
          <div class="row" style="justify-content: space-between">
            <p class="small muted" style="flex: 1 1 200px">{t('rv.archiveNote')}</p>
            <button class="btn quiet" type="button" disabled={busy} onclick={toggleArchive}
              >{sel.archived
                ? t('rv.unarchive', { id: short(sel.id) })
                : t('rv.archive', { id: short(sel.id) })}</button
            >
          </div>
        </section>
      {/if}
    </aside>
  </div>
</main>

<DecisionBar did={t('rv.decideDid')}>
  <label class="small" for="msg" style="font-weight: 600">{t('rv.message')}</label>
  <input
    id="msg"
    class="input"
    style="width: 260px"
    placeholder={t('rv.messagePh')}
    autocomplete="off"
    bind:value={message}
  />
  <span class="conseq"
    >{draft?.base ? t('rv.saveNote', { base: short(draft.base) }) : t('rv.saveNoteNone')}</span
  >
  <button class="btn primary" type="button" disabled={!canSave} onclick={saveDraft}
    >{t('rv.save')}</button
  >
</DecisionBar>
