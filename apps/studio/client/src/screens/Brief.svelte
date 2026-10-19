<script lang="ts">
// The brief board (plan §4; design/prototype/Brief.dc.html). Blocks with sources, a side panel
// to edit one, the ways in (guided, one prompt, material), open questions and the change log.
// The AI only proposes; a person saves or applies every change.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { b, fill, tokenRange } from '../lib/brief-strings.ts'

let { id }: { id: string } = $props()

type Source = { kind: 'user' | 'existing_brief' | 'document'; by?: string; ref?: string }
type Cta = { label: string; target: string; visitorGets?: string; priority: 'primary' | 'secondary' }
type Block = { key: string; state: 'filled' | 'not_set'; text?: string; source?: Source; aiSorted?: boolean; ctas?: Cta[] }
type View = {
  brief: { id: string; status: string; blocks: Block[] }
  openQuestions: string[]
  changeLog: { at: string; key: string; change: 'filled' | 'edited' | 'cleared' }[]
  approval: 'off' | 'optional' | 'required'
}
type Proposal = { blocks: { key: string; text: string; source: Source }[]; leftOut: string[] }

let view = $state<View | null>(null)
let selected = $state<string | null>(null)
let draftText = $state('')
let draftCtas = $state<Cta[]>([])
let message = $state('')
let busy = $state(false)
let followUps = $state<string[]>([])
let tightened = $state<string | null>(null)
let mode = $state<'board' | 'guided' | 'prompt'>('board')
let notes = $state('')
let proposal = $state<Proposal | null>(null)
let chosen = $state<Record<string, boolean>>({})

const s = $derived(b())
const block = $derived(view?.brief.blocks.find((x) => x.key === selected) ?? null)
const guidedKey = $derived(view?.openQuestions[0] ?? null)

async function load() {
  const r = await api<View>('GET', `/api/p/${id}/brief`)
  if (r.ok) view = r.body
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

async function clearBlock(key: string) {
  const r = await api<View>('POST', `/api/p/${id}/brief/blocks/${key}/clear`)
  if (r.ok) {
    view = r.body
    draftText = ''
  }
}

async function runAi(action: 'follow-ups' | 'tighten') {
  if (!selected) return
  busy = true
  message = ''
  const r = await api<{ questions?: string[]; text?: string }>('POST', `/api/p/${id}/brief/blocks/${selected}/ai`, { action })
  busy = false
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
  message = ''
  const r = await api<Proposal>('POST', `/api/p/${id}/brief/sort`, { notes })
  busy = false
  if (r.ok) receive(r.body)
  else message = aiMessage(r.status)
}

async function upload(e: Event) {
  const file = (e.currentTarget as HTMLInputElement).files?.[0]
  if (!file) return
  busy = true
  message = ''
  mode = 'prompt'
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

function sourceLabel(src?: Source, aiSorted?: boolean) {
  if (!src) return ''
  const base =
    src.kind === 'document' ? s.sourceDoc : src.kind === 'existing_brief' ? fill(s.sourceBrief, { ref: src.ref ?? '' }) : fill(s.sourceUser, { by: src.by ?? '' })
  return aiSorted ? `${base} · ${s.aiSorted}` : base
}

const title = (key: string) => s.blocks[key]?.title ?? key
const range = (chars: number) => fill(s.tokens, tokenRange(chars))
</script>

<main class="main">
  <div class="pagehead">
    <div class="stack" style="gap: 6px">
      <h1>{s.heading}</h1>
      <p class="muted">{s.sub}</p>
    </div>
    {#if view}<span class="id">{view.brief.id}</span>{/if}
  </div>

  {#if message}<p role="alert" class="chip warn">{message}</p>{/if}

  {#if view}
    <div class="split">
      <div class="grow stack">
        {#if mode === 'guided'}
          <section class="card ink" aria-labelledby="g-h">
            <div class="card-h"><Icon name="brief" /><h2 id="g-h" class="h2s">{s.guided}</h2></div>
            {#if guidedKey}
              <div class="card-b">
                <span class="label">{title(guidedKey)}</span>
                <label class="flabel" for="g-text">{s.blocks[guidedKey]?.question}</label>
                <ul class="small muted">{#each s.blocks[guidedKey]?.guiding ?? [] as q (q)}<li>{q}</li>{/each}</ul>
                <textarea id="g-text" class="input" bind:value={draftText}></textarea>
              </div>
              <div class="card-f">
                <button class="btn quiet" type="button" onclick={() => (mode = 'board')}>{s.close}</button>
                <button class="btn" type="button" onclick={() => { draftText = ''; view = view && { ...view, openQuestions: [...view.openQuestions.slice(1), guidedKey] } }}>{s.skip}</button>
                <button class="btn primary" type="button" disabled={busy} onclick={guidedSave}>{s.next}</button>
              </div>
            {:else}
              <div class="card-b"><p>{s.guidedDone}</p></div>
              <div class="card-f"><button class="btn" type="button" onclick={() => (mode = 'board')}>{s.close}</button></div>
            {/if}
          </section>
        {:else if mode === 'prompt'}
          <section class="card ink" aria-labelledby="p-h">
            <div class="card-h"><Icon name="brief" /><h2 id="p-h" class="h2s">{s.prompt}</h2></div>
            {#if !proposal}
              <div class="card-b">
                <label class="flabel" for="p-notes">{s.promptLabel}</label>
                <textarea id="p-notes" class="input" style="min-height: 180px" bind:value={notes}></textarea>
              </div>
              <div class="card-f">
                <button class="btn quiet" type="button" onclick={() => (mode = 'board')}>{s.close}</button>
                <button class="btn primary" type="button" disabled={busy || !notes.trim()} onclick={sort}
                  >{busy ? s.sorting : s.sort} <span class="tok">{range(notes.length)}</span></button
                >
              </div>
            {:else}
              <div class="card-b">
                <span class="label">{s.proposal}</span>
                <p class="small muted">{s.proposalNote}</p>
                <div class="rows">
                  {#each proposal.blocks as pb (pb.key)}
                    <label class="r"><input type="checkbox" bind:checked={chosen[pb.key]} /><span class="stack" style="gap: 2px"><b>{title(pb.key)}</b><span>{pb.text}</span></span></label>
                  {/each}
                </div>
                {#if proposal.leftOut.length}
                  <span class="label">{s.leftOut}</span>
                  <ul class="small muted">{#each proposal.leftOut as l (l)}<li>{l}</li>{/each}</ul>
                {/if}
              </div>
              <div class="card-f">
                <button class="btn quiet" type="button" onclick={() => (proposal = null)}>{s.close}</button>
                <button class="btn primary" type="button" onclick={apply}>{s.apply}</button>
              </div>
            {/if}
          </section>
        {/if}

        <div class="cols3" aria-label={s.heading}>
          {#each view.brief.blocks as blk (blk.key)}
            <button type="button" class="card blockcard" class:ink={selected === blk.key} onclick={() => select(blk.key)} aria-pressed={selected === blk.key}>
              <span class="card-h"><b>{title(blk.key)}</b>{#if blk.state === 'not_set'}<span class="chip warn">{s.notSet}</span>{/if}</span>
              <span class="card-b">
                {#if blk.state === 'filled'}<span>{blk.text}</span><span class="small muted">{sourceLabel(blk.source, blk.aiSorted)}</span>
                {:else}<span class="muted">{s.notSet}</span>{/if}
              </span>
            </button>
          {/each}
        </div>
      </div>

      <aside class="side stack">
        {#if block}
          <section class="card ink" aria-labelledby="e-h">
            <div class="card-h"><Icon name="brief" /><h2 id="e-h" class="h2s">{title(block.key)}</h2></div>
            <div class="card-b">
              <label class="flabel" for="e-text">{s.blocks[block.key]?.question}</label>
              <ul class="small muted">{#each s.blocks[block.key]?.guiding ?? [] as q (q)}<li>{q}</li>{/each}</ul>
              <textarea id="e-text" class="input" bind:value={draftText}></textarea>
              {#if block.key === 'calls_to_action'}
                {#each draftCtas as cta, i (i)}
                  <div class="stack" style="gap: 6px; border-top: 1px solid var(--rule); padding-top: 8px">
                    <label class="small" for="cta-l-{i}">{s.ctaLabel}</label><input id="cta-l-{i}" class="input" bind:value={cta.label} />
                    <label class="small" for="cta-t-{i}">{s.ctaTarget}</label><input id="cta-t-{i}" class="input" bind:value={cta.target} />
                    <label class="small" for="cta-g-{i}">{s.ctaGets}</label><input id="cta-g-{i}" class="input" bind:value={cta.visitorGets} />
                    <div class="row">
                      <label class="row small"><input type="radio" name="prio-{i}" value="primary" bind:group={cta.priority} />{s.ctaPrimary}</label>
                      <label class="row small"><input type="radio" name="prio-{i}" value="secondary" bind:group={cta.priority} />{s.ctaSecondary}</label>
                      <button class="btn quiet" type="button" onclick={() => (draftCtas = draftCtas.filter((_, j) => j !== i))}>{s.ctaRemove}</button>
                    </div>
                  </div>
                {/each}
                <button class="btn" type="button" onclick={() => (draftCtas = [...draftCtas, { label: '', target: '', priority: draftCtas.length ? 'secondary' : 'primary' }])}>{s.ctaAdd}</button>
              {/if}
              {#if block.state === 'filled'}<span class="small muted">{sourceLabel(block.source, block.aiSorted)}</span>{/if}
              <div class="row">
                <button class="btn" type="button" disabled={busy || !draftText.trim()} onclick={() => runAi('follow-ups')}
                  ><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{s.followUps} <span class="tok">{range(draftText.length)}</span></button
                >
                <button class="btn" type="button" disabled={busy || block.state !== 'filled'} onclick={() => runAi('tighten')}
                  ><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{s.tighten} <span class="tok">{range(draftText.length)}</span></button
                >
              </div>
              {#if followUps.length}<ul>{#each followUps as q (q)}<li>{q}</li>{/each}</ul>{/if}
              {#if tightened}
                <div class="card" style="padding: 10px"><p>{tightened}</p>
                  <div class="row"><button class="btn" type="button" onclick={() => { draftText = tightened ?? ''; tightened = null }}>{s.useThis}</button><button class="btn quiet" type="button" onclick={() => (tightened = null)}>{s.keepMine}</button></div>
                </div>
              {/if}
            </div>
            <div class="card-f">
              <span class="note">{s.saveNote}</span>
              <button class="btn quiet" type="button" onclick={() => clearBlock(block.key)}>{s.clear}</button>
              <button class="btn primary" type="button" disabled={busy} onclick={() => saveBlock(block.key, draftText, block.key === 'calls_to_action' ? draftCtas : undefined)}>{s.save}</button>
            </div>
          </section>
        {/if}

        <section class="card" aria-labelledby="w-h">
          <div class="card-h"><h2 id="w-h" class="h2s" style="font-size: 20px">{s.ways}</h2></div>
          <div class="card-b">
            <button class="opt" type="button" onclick={() => { mode = 'guided'; draftText = '' }}><b>{s.guided}</b><span class="small muted">{s.guidedDesc}</span></button>
            <button class="opt" type="button" onclick={() => { mode = 'prompt'; proposal = null }}><b>{s.prompt}</b><span class="small muted">{s.promptDesc}</span></button>
            <label class="opt"><b>{s.material}</b><span class="small muted">{s.materialDesc}</span><input type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" onchange={upload} /></label>
            <p class="small muted">{s.importLater}</p>
          </div>
        </section>

        <section class="card" aria-labelledby="o-h">
          <div class="card-h"><h2 id="o-h" class="h2s" style="font-size: 20px">{s.open}</h2><span class="chip">{view.openQuestions.length}</span></div>
          <div class="card-b">
            {#if view.openQuestions.length}
              <ul>{#each view.openQuestions as k (k)}<li><button class="btn quiet" type="button" onclick={() => select(k)}>{title(k)}</button></li>{/each}</ul>
            {:else}<p class="muted">{s.openNone}</p>{/if}
            <p class="small muted">{s.openNote}</p>
          </div>
        </section>

        <section class="card" aria-labelledby="l-h">
          <div class="card-h"><h2 id="l-h" class="h2s" style="font-size: 20px">{s.log}</h2></div>
          <div class="card-b">
            {#if view.changeLog.length}
              <ul class="small">{#each [...view.changeLog].reverse() as e (e.at + e.key + e.change)}<li>{title(e.key)} · {s[e.change]}</li>{/each}</ul>
            {:else}<p class="muted">{s.logNone}</p>{/if}
          </div>
        </section>
      </aside>
    </div>
  {/if}
</main>

{#if view}
  <DecisionBar did={s.did}>
    <span class="conseq">{s.approveNote}</span>
    {#if view.brief.status === 'approved'}
      <span class="chip ok">{s.approved}</span>
    {:else if view.approval !== 'off'}
      <button class="btn primary" type="button" onclick={approve}>{s.approve}</button>
    {/if}
  </DecisionBar>
{/if}

<style>
.blockcard { text-align: left; cursor: pointer; font: inherit; color: inherit; padding: 0; }
.blockcard:focus-visible { outline: var(--focus); outline-offset: var(--focus-offset); }
.opt { flex-direction: column; align-items: flex-start; gap: 2px; }
.opt input[type='file'] { font-size: 13px; }
.rows .r { cursor: pointer; }
</style>
