<script lang="ts">
// The brief board (plan §4; design/prototype/Brief.dc.html). Ways in on top, the blocks as a
// numbered grid with sources, a panel to edit one block, open questions and the change log.
// The AI only proposes; a person saves or applies every change.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { b, fill, tokenRange } from '../lib/brief-strings.ts'
import { i18n } from '../lib/i18n.svelte.ts'
import { link } from '../lib/router.svelte.ts'
import { pathOf, type StructureView } from '../lib/structure.ts'

let { id }: { id: string } = $props()

type Source = { kind: 'user' | 'existing_brief' | 'document'; by?: string; ref?: string }
type Cta = { label: string; target: string; visitorGets?: string; priority: 'primary' | 'secondary' }
type Block = { key: string; state: 'filled' | 'not_set'; text?: string; source?: Source; aiSorted?: boolean; ctas?: Cta[] }
type View = {
  brief: {
    id: string
    title: string
    author: string
    scope: string
    status: string
    templateVersion: number
    blocks: Block[]
  }
  openQuestions: string[]
  changeLog: { at: string; key: string; change: 'filled' | 'edited' | 'cleared' }[]
  approval: 'off' | 'optional' | 'required'
}
type Proposal = { blocks: { key: string; text: string; source: Source }[]; leftOut: string[] }

let view = $state<View | null>(null)
let structure = $state<StructureView['structure'] | null>(null)
let selected = $state<string | null>(null)
let draftText = $state('')
let draftCtas = $state<Cta[]>([])
let message = $state('')
let busy = $state(false)
let sorting = $state(false)
let working = $state(false)
let saved = $state(false)
let followUps = $state<string[]>([])
let tightened = $state<string | null>(null)
let mode = $state<'board' | 'guided' | 'prompt' | 'material'>('board')
let notes = $state('')
let file = $state<File | null>(null)
let proposal = $state<Proposal | null>(null)
let chosen = $state<Record<string, boolean>>({})

const s = $derived(b())
const block = $derived(view?.brief.blocks.find((x) => x.key === selected) ?? null)
const guidedKey = $derived(view?.openQuestions[0] ?? null)
const isCta = $derived(block?.key === 'calls_to_action')
const openCount = $derived(view?.openQuestions.length ?? 0)

// "Partly set" is derived, never stored (decision #42): a filled block that still has a [placeholder].
const partly = (blk: Block) => blk.state === 'filled' && /\[[^\]]*\]/.test(blk.text ?? '')
const counts = $derived.by(() => {
  const all = view?.brief.blocks ?? []
  const open = all.filter((x) => x.state === 'not_set').length
  const part = all.filter(partly).length
  return { set: all.length - open - part, partly: part, open }
})

async function load() {
  const r = await api<View>('GET', `/api/p/${id}/brief`)
  if (r.ok) view = r.body
  const st = await api<StructureView>('GET', `/api/p/${id}/structure`)
  if (st.ok) structure = st.body.structure
}
$effect(() => {
  load()
})

function select(key: string) {
  selected = key
  const blk = view?.brief.blocks.find((x) => x.key === key)
  draftText = blk?.text ?? ''
  draftCtas = blk?.ctas ? blk.ctas.map((c) => ({ ...c })) : []
  followUps = []
  tightened = null
  message = ''
  saved = false
}

function aiMessage(status: number) {
  return status === 503 ? s.noModel : s.aiFailed
}

async function saveBlock(key: string, text: string, ctas?: Cta[]) {
  busy = true
  const r = await api<View & { message?: string }>('PUT', `/api/p/${id}/brief/blocks/${key}`, {
    text,
    ...(ctas ? { ctas } : {}),
  })
  busy = false
  if (r.ok) view = r.body
  else message = r.body.message ?? ''
  return r.ok
}

async function saveEditor() {
  if (!block) return
  const ok = isCta
    ? await saveBlock(block.key, ctaText(draftCtas), draftCtas)
    : await saveBlock(block.key, draftText)
  if (ok) {
    selected = null
    saved = true
  }
}

async function clearBlock(key: string) {
  const r = await api<View>('POST', `/api/p/${id}/brief/blocks/${key}/clear`)
  if (r.ok) {
    view = r.body
    draftText = ''
    draftCtas = []
  }
}

async function runAi(action: 'follow-ups' | 'tighten') {
  if (!selected) return
  busy = true
  working = true
  message = ''
  followUps = []
  tightened = null
  const r = await api<{ questions?: string[]; text?: string }>('POST', `/api/p/${id}/brief/blocks/${selected}/ai`, { action })
  busy = false
  working = false
  if (!r.ok) {
    message = aiMessage(r.status)
    return
  }
  if (action === 'follow-ups') followUps = r.body.questions ?? []
  else tightened = r.body.text ?? null
}

function receive(p: Proposal) {
  proposal = p
  chosen = Object.fromEntries(p.blocks.map((x) => [x.key, true]))
}

async function sort() {
  busy = true
  sorting = true
  message = ''
  const r = await api<Proposal>('POST', `/api/p/${id}/brief/sort`, { notes })
  busy = false
  sorting = false
  if (r.ok) receive(r.body)
  else message = aiMessage(r.status)
}

function pick(e: Event) {
  file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file) return
  busy = true
  sorting = true
  message = ''
  const form = new FormData()
  form.append('file', file)
  const csrf = (await api<{ csrf: string }>('GET', '/api/me')).body.csrf
  const res = await fetch(`/api/p/${id}/brief/material`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': csrf },
    body: form,
  })
  busy = false
  sorting = false
  const body = (await res.json().catch(() => ({}))) as Proposal & { message?: string }
  if (res.ok) receive(body)
  else message = res.status === 503 || res.status === 502 ? aiMessage(res.status) : (body.message ?? '')
}

async function apply() {
  if (!proposal) return
  const blocks = proposal.blocks.filter((x) => chosen[x.key])
  const r = await api<View>('POST', `/api/p/${id}/brief/apply`, { blocks })
  if (r.ok) {
    view = r.body
    proposal = null
    notes = ''
    file = null
    mode = 'board'
  }
}

async function guidedSave() {
  if (!guidedKey) return
  if (draftText.trim()) await saveBlock(guidedKey, draftText)
  draftText = ''
}

async function approve() {
  const r = await api<View>('POST', `/api/p/${id}/brief/approve`)
  if (r.ok) view = r.body
  else message = s.approvalOff
}

function openWay(next: 'guided' | 'prompt' | 'material') {
  if (mode === next) {
    mode = 'board'
    return
  }
  mode = next
  proposal = null
  if (next === 'guided') draftText = ''
}

function sourceLabel(src?: Source) {
  if (!src) return ''
  return src.kind === 'document'
    ? s.sourceDoc
    : src.kind === 'existing_brief'
      ? fill(s.sourceBrief, { ref: src.ref ?? '' })
      : fill(s.sourceUser, { by: src.by ?? '' })
}

// Calls to action: one primary at most; choosing Primary demotes the others.
function setPriority(i: number, p: 'primary' | 'secondary') {
  draftCtas = draftCtas.map((c, j) =>
    j === i ? { ...c, priority: p } : p === 'primary' && c.priority === 'primary' ? { ...c, priority: 'secondary' } : c,
  )
}
const pages = $derived(structure?.pages ?? [])
const isPage = (target: string) => pages.some((p) => p.id === target)
const whereValue = (target: string) => (isPage(target) ? target : target === '' ? '' : 'link')
function setWhere(i: number, value: string) {
  const c = draftCtas[i]
  if (!c) return
  c.target = value === 'link' ? 'https://' : value
}
function destination(c: Cta) {
  return pages.find((p) => p.id === c.target)?.title ?? c.target
}
function ctaText(list: Cta[]) {
  const parts = list
    .filter((c) => c.label.trim())
    .map((c) => {
      const to = destination(c)
      return `${c.priority === 'primary' ? s.ctaPrimary : s.ctaSecondary}: ${c.label.trim()}${to ? ` → ${to}` : ''}`
    })
  return parts.length ? `${parts.join('. ')}.` : ''
}
const editorText = $derived(isCta ? ctaText(draftCtas) : draftText)

const title = (key: string) => s.blocks[key]?.title ?? key
const range = (chars: number) => fill(s.tokens, tokenRange(chars))
const num = (key: string) => String((view?.brief.blocks.findIndex((x) => x.key === key) ?? 0) + 1).padStart(2, '0')
const when = (at: string) =>
  new Date(at).toLocaleDateString(i18n.lang === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'short' })
const statusText = (st: string) => (st === 'optional_review' ? s.stOptional : s.stDraft)
const approvalText = (a: View['approval']) => (a === 'off' ? s.appOff : a === 'required' ? s.appRequired : s.appOptional)
const conseq = $derived(openCount === 0 ? s.conseqNone : openCount === 1 ? s.conseqOne : fill(s.conseqMany, { n: openCount }))
const askAi = $derived(editorText.length)
</script>

{#snippet ai(spin = false)}
  <svg class="aim" class:working={spin} viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>
{/snippet}

{#snippet proposalView()}
  {#if proposal}
    <div class="proposal rise">
      <span class="row small" style="gap: 6px">{@render ai()}<b>{s.proposal}</b></span>
      <span class="small muted">{s.proposalNote}</span>
      <div class="rows">
        {#each proposal.blocks as pb (pb.key)}
          <label class="r pick"><input type="checkbox" bind:checked={chosen[pb.key]} /><span class="stack" style="gap: 2px"><b>{title(pb.key)}</b><span>{pb.text}</span></span></label>
        {/each}
      </div>
      {#if proposal.leftOut.length}
        <span class="label">{s.leftOut}</span>
        <ul class="small muted">{#each proposal.leftOut as l (l)}<li>{l}</li>{/each}</ul>
      {/if}
    </div>
  {/if}
{/snippet}

<main class="main">
  <div class="pagehead">
    <div class="stack" style="gap: 6px">
      <span class="label">{s.eyebrow}</span>
      <h1>{view?.brief.title ?? s.heading}</h1>
    </div>
  </div>

  {#if message}<p role="alert" class="chip warn">{message}</p>{/if}

  {#if view}
    <div class="meta" aria-label={s.metaAria}>
      <div><span class="label">{s.mId}</span><span><span class="id">{view.brief.id}</span></span></div>
      <div><span class="label">{s.mAuthor}</span><span>{view.brief.author} <span class="small muted">{s.fromLogin}</span></span></div>
      <div><span class="label">{s.mScope}</span><span>{view.brief.scope || s.notSet}</span></div>
      <div>
        <span class="label">{s.mStatus}</span>
        <span class="row" style="gap: 6px">
          {#if view.brief.status === 'approved'}
            <span class="chip ok"><Icon name="check" small />{s.approved}</span>
          {:else}
            <span class="chip">{statusText(view.brief.status)}</span>
          {/if}
        </span>
      </div>
      <div><span class="label">{s.mApproval}</span><span>{approvalText(view.approval)} <span class="small muted">{s.installSetting}</span></span></div>
      <div><span class="label">{s.mTemplate}</span><span class="mono" style="font-size: 13px">{fill(s.templateV, { v: view.brief.templateVersion })}</span></div>
    </div>

    <div class="split">
      <div class="grow stack" style="gap: 28px">
        <section class="stack" style="gap: 10px" aria-labelledby="ways-h">
          <div class="row" style="justify-content: space-between">
            <h2 id="ways-h" class="label">{s.waysHead}</h2>
            {#if openCount > 0}
              <button class="btn" type="button" onclick={() => { mode = 'guided'; proposal = null; draftText = '' }}>{fill(s.guidedOpen, { n: openCount })}</button>
            {/if}
          </div>
          <div class="ways">
            <button class="way" class:on={mode === 'guided'} type="button" aria-pressed={mode === 'guided'} onclick={() => openWay('guided')}><b>{s.guided}</b><span>{s.guidedDesc}</span></button>
            <button class="way" class:on={mode === 'prompt'} type="button" aria-pressed={mode === 'prompt'} onclick={() => openWay('prompt')}><b>{s.prompt}</b><span>{s.promptDesc}</span></button>
            <button class="way" class:on={mode === 'material'} type="button" aria-pressed={mode === 'material'} onclick={() => openWay('material')}><b>{s.material}</b><span>{s.materialDesc}</span></button>
            <button class="way" type="button" disabled><b>{s.importTitle}</b><span>{s.comesLater}</span></button>
            <button class="way" type="button" disabled><b>{s.duplicateTitle}</b><span>{s.comesLater}</span></button>
          </div>

          {#if mode === 'guided'}
            <div class="panel rise">
              {#if guidedKey}
                <div class="card-b">
                  <div class="row" style="justify-content: space-between"><span class="label">{fill(s.guidedOf, { i: 1, n: openCount })}</span></div>
                  <h3 class="h2s" style="font-size: 22px">{title(guidedKey)}: {s.blocks[guidedKey]?.question}</h3>
                  <ul class="gq">{#each s.blocks[guidedKey]?.guiding ?? [] as q (q)}<li>{q}</li>{/each}</ul>
                  <div class="field"><label for="g-text">{s.yourAnswer}</label><textarea id="g-text" class="input" placeholder={s.guidedPh} bind:value={draftText}></textarea></div>
                </div>
                <div class="card-f">
                  <span class="note">{s.guidedNote}</span>
                  <button class="btn" type="button" onclick={() => { draftText = ''; view = view && { ...view, openQuestions: [...view.openQuestions.slice(1), guidedKey] } }}>{s.skip}</button>
                  <button class="btn primary" type="button" disabled={busy} onclick={guidedSave}>{s.next}</button>
                </div>
              {:else}
                <div class="card-b"><p>{s.guidedDone}</p></div>
                <div class="card-f"><button class="btn" type="button" onclick={() => (mode = 'board')}>{s.close}</button></div>
              {/if}
            </div>
          {:else if mode === 'prompt'}
            <div class="panel rise">
              <div class="card-b">
                <span class="label">{s.prompt}</span>
                <div class="field"><label for="p-notes">{s.promptLabel}</label><textarea id="p-notes" class="input" style="min-height: 120px" bind:value={notes}></textarea></div>
                <p class="small muted">{s.promptData}</p>
                {#if sorting}<div class="row small">{@render ai(true)}{s.sortingMsg}</div>{/if}
                {@render proposalView()}
              </div>
              <div class="card-f">
                <span class="note">{s.promptSource}</span>
                <button class="btn" type="button" onclick={() => { proposal = null; mode = 'board' }}>{s.close}</button>
                {#if proposal}
                  <button class="btn primary" type="button" onclick={apply}>{s.apply}</button>
                {:else}
                  <button class="btn primary" type="button" disabled={busy || !notes.trim()} onclick={sort}>{s.sort} <span class="tok">{range(notes.length)}</span></button>
                {/if}
              </div>
            </div>
          {:else if mode === 'material'}
            <div class="panel rise">
              <div class="card-b">
                <span class="label">{s.material}</span>
                <div class="drop">
                  <Icon name="upload" />
                  <b>{s.dropTitle}</b>
                  <span class="small muted">{s.dropHint}</span>
                  {#if file}<span class="small mono">{fill(s.fileChosen, { name: file.name })}</span>{/if}
                  <input type="file" aria-label={s.dropTitle} accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" onchange={pick} />
                </div>
                {#if sorting}<div class="row small">{@render ai(true)}{s.sortingMsg}</div>{/if}
                {@render proposalView()}
              </div>
              <div class="card-f">
                <span class="note">{s.matNote}</span>
                <button class="btn" type="button" onclick={() => { proposal = null; file = null; mode = 'board' }}>{s.close}</button>
                {#if proposal}
                  <button class="btn primary" type="button" onclick={apply}>{s.apply}</button>
                {:else}
                  <button class="btn primary" type="button" disabled={busy || !file} onclick={upload}>{s.matFill}</button>
                {/if}
              </div>
            </div>
          {/if}
        </section>

        <section class="stack" style="gap: 10px" aria-labelledby="blocks-h">
          <div class="row" style="justify-content: space-between">
            <h2 id="blocks-h" class="label">{fill(s.blocksHead, { set: counts.set, partly: counts.partly, open: counts.open })}</h2>
            <span class="row small muted" style="gap: 6px">{@render ai()}{s.aiLegend}</span>
          </div>
          <div class="blocks">
            {#each view.brief.blocks as blk, i (blk.key)}
              {@const open = blk.state === 'not_set'}
              <button type="button" class="blk" class:open class:sel={selected === blk.key} onclick={() => select(blk.key)} aria-pressed={selected === blk.key}>
                <span class="bt">
                  <span class="mono small muted">{String(i + 1).padStart(2, '0')}</span><b>{title(blk.key)}</b>
                  <span class="chip" class:sig={open} class:warn={partly(blk)}>{open ? s.chipOpen : partly(blk) ? s.chipPartly : s.chipSet}</span>
                </span>
                <span class="tx">{blk.state === 'filled' ? blk.text : s.notSet}</span>
                <span class="src">
                  {#if blk.aiSorted}{@render ai()}<span class="sr">{s.aiSorted}</span>{/if}
                  {fill(s.source, { src: (open ? '' : sourceLabel(blk.source)) || s.sourceNone })}
                </span>
              </button>
            {/each}
          </div>
        </section>
      </div>

      <aside class="side stack" style="gap: 28px">
        {#if block}
          <section class="panel rise" aria-labelledby="e-h">
            <div class="card-h">
              <span class="mono small muted">{num(block.key)}</span>
              <h2 id="e-h" class="h2s" style="font-size: 22px">{title(block.key)}</h2>
              <button class="btn quiet" type="button" style="margin-left: auto" aria-label={s.closeEditor} onclick={() => (selected = null)}><Icon name="close" small /></button>
            </div>
            <div class="card-b">
              <span class="label">{s.guidingQs}</span>
              <ul class="gq"><li>{s.blocks[block.key]?.question}</li>{#each s.blocks[block.key]?.guiding ?? [] as q (q)}<li>{q}</li>{/each}</ul>

              {#if isCta}
                <div class="stack" style="gap: 10px">
                  {#each draftCtas as cta, i (i)}
                    <div class="ctarow">
                      <div class="row" style="justify-content: space-between">
                        <span class="label">{fill(s.ctaN, { n: i + 1 })}</span>
                        <div class="pill" role="group" aria-label={s.priority}>
                          <button type="button" class:on={cta.priority === 'primary'} aria-pressed={cta.priority === 'primary'} onclick={() => setPriority(i, 'primary')}>{s.ctaPrimary}</button>
                          <button type="button" class:on={cta.priority === 'secondary'} aria-pressed={cta.priority === 'secondary'} onclick={() => setPriority(i, 'secondary')}>{s.ctaSecondary}</button>
                        </div>
                      </div>
                      <div class="two">
                        <div class="field"><label for="cta-l-{i}">{s.ctaLabel}</label><input id="cta-l-{i}" class="input" bind:value={cta.label} /></div>
                        <div class="field">
                          <label for="cta-t-{i}">{s.ctaWhere}</label>
                          <select id="cta-t-{i}" class="input" value={whereValue(cta.target)} onchange={(e) => setWhere(i, e.currentTarget.value)}>
                            {#if cta.target === ''}<option value="">{s.chooseDest}</option>{/if}
                            {#each pages as p (p.id)}<option value={p.id}>{fill(s.pageOpt, { title: p.title, path: structure ? pathOf(structure, p.id) : '' })}</option>{/each}
                            <option value="link">{s.external}</option>
                          </select>
                        </div>
                      </div>
                      {#if whereValue(cta.target) === 'link'}
                        <div class="field"><label for="cta-u-{i}">{s.urlLabel}</label><input id="cta-u-{i}" class="input" inputmode="url" placeholder="https://" bind:value={cta.target} /></div>
                      {/if}
                      <div class="field"><label for="cta-g-{i}">{s.ctaGets}</label><input id="cta-g-{i}" class="input" bind:value={cta.visitorGets} /></div>
                      <div class="row" style="justify-content: flex-end"><button class="btn quiet" type="button" onclick={() => (draftCtas = draftCtas.filter((_, j) => j !== i))}>{s.ctaRemove}</button></div>
                    </div>
                  {/each}
                  <button class="btn" type="button" onclick={() => (draftCtas = [...draftCtas, { label: '', target: '', priority: draftCtas.some((c) => c.priority === 'primary') ? 'secondary' : 'primary' }])}><Icon name="plus" small />{s.ctaAddAnother}</button>
                </div>
              {:else}
                <div class="field"><label for="e-text">{title(block.key)}</label><textarea id="e-text" class="input" style="min-height: 150px" placeholder={s.notSet} bind:value={draftText}></textarea></div>
              {/if}

              <span class="label">{s.aiActions}</span>
              <div class="row">
                <button class="btn" type="button" disabled={busy || !editorText.trim()} onclick={() => runAi('follow-ups')}>{s.followUps} <span class="tok">{range(askAi)}</span></button>
                <button class="btn" type="button" disabled={busy || block.state !== 'filled'} onclick={() => runAi('tighten')}>{s.tighten} <span class="tok">{range(askAi)}</span></button>
                <button class="btn" type="button" onclick={() => clearBlock(block.key)}>{s.clear}</button>
              </div>
              {#if working}<div class="row small">{@render ai(true)}{s.working}</div>{/if}
              {#if followUps.length}
                <div class="proposal rise">
                  <span class="row small" style="gap: 6px">{@render ai()}<b>{s.followHead}</b></span>
                  <ol class="gq" style="color: var(--ink)">{#each followUps as q (q)}<li>{q}</li>{/each}</ol>
                  <div class="row" style="justify-content: flex-end">
                    <button class="btn quiet" type="button" onclick={() => (followUps = [])}>{s.dismiss}</button>
                    <button class="btn" type="button" onclick={() => { followUps = []; document.getElementById('e-text')?.focus() }}>{s.answerNow}</button>
                  </div>
                </div>
              {/if}
              {#if tightened}
                <div class="proposal rise">
                  <span class="row small" style="gap: 6px">{@render ai()}<b>{s.tightHead}</b></span>
                  <span class="small">{tightened}</span>
                  <span class="small muted">{s.tightNote}</span>
                  <div class="row" style="justify-content: flex-end">
                    <button class="btn quiet" type="button" onclick={() => (tightened = null)}>{s.discard}</button>
                    <button class="btn" type="button" onclick={() => { draftText = tightened ?? ''; tightened = null }}>{s.useVersion}</button>
                  </div>
                </div>
              {/if}

              <div class="rows small">
                <div class="r"><span class="label" style="min-width: 64px">{s.sourceWord}</span><span class="row" style="gap: 6px">{#if block.aiSorted}{@render ai()}{/if}{block.state === 'filled' ? sourceLabel(block.source) : s.sourceNone}</span></div>
              </div>
            </div>
            <div class="card-f">
              <span class="note">{s.saveNote}</span>
              <button class="btn" type="button" onclick={() => (selected = null)}>{s.cancel}</button>
              <button class="btn primary" type="button" disabled={busy} onclick={saveEditor}>{s.save}</button>
            </div>
          </section>
        {/if}
        {#if saved}<p class="small rise row" style="gap: 6px"><Icon name="check" small />{s.saved}</p>{/if}

        <section class="walllabel" aria-labelledby="o-h">
          <div class="row" style="justify-content: space-between"><h2 id="o-h" class="label">{fill(s.openHead, { n: openCount })}</h2><span class="small muted">{s.derived}</span></div>
          {#if openCount}
            <div class="rows small" style="border-top: 0">
              {#each view.openQuestions as k (k)}
                <div class="r"><button class="btn quiet" type="button" style="padding: 0; text-align: left; white-space: normal; min-height: 32px" onclick={() => select(k)}>{title(k)}: {s.blocks[k]?.question}</button></div>
              {/each}
            </div>
          {:else}<p class="small muted">{s.openNone}</p>{/if}
          <p class="small muted">{s.openNote}</p>
        </section>

        <section class="walllabel" aria-labelledby="l-h">
          <div class="row" style="justify-content: space-between"><h2 id="l-h" class="label">{s.log}</h2><span class="small muted">{s.fromHistory}</span></div>
          {#if view.changeLog.length}
            <div class="rows small" style="border-top: 0">
              {#each [...view.changeLog].reverse() as e (e.at + e.key + e.change)}
                <div class="r"><span class="mono muted" style="min-width: 56px">{when(e.at)}</span><span>{view.brief.author} · {title(e.key)}: {s[e.change]}</span></div>
              {/each}
            </div>
          {:else}<p class="small muted">{s.logNone}</p>{/if}
        </section>
      </aside>
    </div>
  {/if}
</main>

{#if view}
  <DecisionBar did={s.did}>
    <span class="conseq">{conseq}</span>
    {#if openCount > 0}
      <button class="btn" type="button" onclick={() => { mode = 'guided'; proposal = null; draftText = '' }}>{s.answerOpen}</button>
    {/if}
    {#if view.brief.status === 'approved'}
      <span class="chip ok"><Icon name="check" small />{s.approved}</span>
    {:else if view.approval !== 'off'}
      <button class="btn" type="button" onclick={approve}>{s.approve}</button>
    {/if}
    <a class="btn primary" href="/p/{id}/structure" use:link>{s.toStructure}</a>
  </DecisionBar>
{/if}

<style>
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 12px 24px; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--rule); padding: 12px 0; }
.meta > div { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.ways { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 8px; }
.way {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  min-height: 84px; padding: 12px 14px; text-align: left; cursor: pointer;
  font: inherit; color: inherit; border: 1px solid var(--rule-strong); background: var(--sheet);
  transition: border-color var(--t-ui) var(--ease), background var(--t-ui) var(--ease);
}
.way:hover { border-color: var(--ink); }
.way.on { border-color: var(--ink); background: #fff; box-shadow: inset 0 -3px 0 var(--ink); }
.way[disabled] { border-style: dashed; cursor: not-allowed; }
.way[disabled]:hover { border-color: var(--rule-strong); }
.way b { font-size: 14px; font-weight: 600; }
.way span { font-size: 12.5px; color: var(--caption); line-height: 1.4; }
.way:focus-visible, .blk:focus-visible { outline: var(--focus); outline-offset: var(--focus-offset); }
.blocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px; }
.blk {
  display: flex; flex-direction: column; gap: 10px; padding: 16px; min-height: 168px;
  font: inherit; color: inherit; border: 1px solid var(--rule); background: var(--sheet);
  cursor: pointer; text-align: left;
  transition: border-color var(--t-ui) var(--ease), background var(--t-ui) var(--ease);
}
.blk:hover { border-color: var(--ink); }
.blk.sel { border-color: var(--ink); background: #fff; outline: 1px solid var(--ink); }
.blk.open { background: repeating-linear-gradient(-45deg, var(--sheet) 0 10px, var(--wall) 10px 20px); border-style: dashed; border-color: var(--quiet); }
.blk.open.sel { border-style: solid; border-color: var(--ink); }
.blk .bt { display: flex; align-items: baseline; gap: 8px; width: 100%; }
.blk .bt b { font-family: var(--font-title); font-weight: 400; font-size: 21px; line-height: 1.15; }
.blk .bt .chip { margin-left: auto; }
.blk .tx { font-size: 14px; line-height: 1.5; }
.blk .src { margin-top: auto; display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11.5px; color: var(--caption); border-top: 1px solid var(--rule); padding-top: 8px; width: 100%; }
.panel { border: 1px solid var(--ink); background: var(--sheet); }
.gq { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 13.5px; color: var(--caption); }
.ctarow { border: 1px solid var(--rule); background: #fff; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: 10px; }
.pill { display: flex; border: 1px solid var(--rule-strong); padding: 2px; gap: 2px; background: var(--sheet); }
.pill button { flex: 1; min-height: 40px; min-width: 44px; padding: 0 10px; border: 0; background: none; cursor: pointer; font-size: 13px; }
.pill button.on { background: var(--ink); color: var(--sheet); }
.drop { position: relative; border: 1px dashed var(--ink); background: var(--wall); min-height: 110px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 16px; text-align: center; }
.drop:focus-within { outline: var(--focus); outline-offset: var(--focus-offset); }
/* The real file input fills the box, out of sight: drop or click, keyboard and screen readers keep it. */
.drop input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.proposal { border: 1px dashed var(--caption); background: #fff; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.rows .r.pick { cursor: pointer; align-items: flex-start; }
@media (prefers-reduced-motion: reduce) { .way, .blk { transition: none; } }
</style>
