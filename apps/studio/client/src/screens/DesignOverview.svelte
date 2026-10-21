<script lang="ts">
// The Design overview (plan §6.1-6.2; design/prototype/DesignOverview.dc.html): one direction per
// page, the Lead. Alternatives and references only show when asked for. Every card has the same
// actions in the same place; the server's refusals are shown as they come.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { ds, fill, refusal } from '../lib/design-strings.ts'
import { link } from '../lib/router.svelte.ts'

let { id }: { id: string } = $props()

type SectionSummary = { id: string; name: string; progress: string }
type Board = {
  id: number
  pageId: string
  letter: string
  role: 'lead' | 'alternative' | 'reference' | 'state'
  kind: string | null
  parentId: number | null
  description: string
  createdBy: string
  sections: SectionSummary[]
  sectionsApproved: number
  sectionsTotal: number
  unsettledDeviations: number
}
type Overview = {
  pages: { id: string; title: string; artboards: Board[] }[]
  presence: { handle: string; name: string }[]
}

let data = $state<Overview | null>(null)
let failed = $state(false)
let showAlt = $state(false)
let message = $state<{ board: number | string; text: string } | null>(null)
let starting = $state<string | null>(null)
// Make lead: which card is asking what the old Lead becomes.
let asking = $state<number | null>(null)
let becomes = $state<'alternative' | 'reference'>('alternative')

const s = $derived(ds())
const tag = (b: Board) => `${id}-${b.letter}`

async function load() {
  const r = await api<Overview>('GET', `/api/p/${id}/design`)
  if (!r.ok) {
    failed = true
    return
  }
  data = r.body
}
$effect(() => {
  load()
})

const leadOf = (boards: Board[]) => boards.find((b) => b.role === 'lead')
const othersOf = (boards: Board[]) =>
  boards.filter((b) => b.role === 'alternative' || b.role === 'reference')

/** Checklist items ticked across the sections, out of seven each. Approved counts as all seven. */
function done(b: Board): number {
  return b.sections.reduce(
    (n, x) => n + (x.progress === 'approved' ? 7 : Number(x.progress.split('/')[0])),
    0,
  )
}
function progress(b: Board): string {
  if (b.sectionsTotal > 0 && b.sectionsApproved === b.sectionsTotal) return s.approved
  return fill(s.inDev, { n: done(b), total: Math.max(b.sectionsTotal, 1) * 7 })
}
const sectionLine = (b: Board) =>
  b.sectionsTotal === 0
    ? s.noSections
    : b.sectionsTotal === 1
      ? s.oneSection
      : fill(s.sectionCount, { n: b.sectionsTotal })

const esc = (v: string) =>
  v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// A minimal valid page: a full document linking style.css, one hero section. The server gives the
// section its id (a bare data-section is refused); the words are placeholders until the brief fills them in.
const starter = (title: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<section>\n<h1>${esc(title)}</h1>\n<p>[Core message from the brief]</p>\n</section>\n</body>\n</html>\n`

async function start(pageId: string, title: string) {
  starting = pageId
  message = null
  const r = await api<{ id?: number }>('POST', `/api/p/${id}/design/artboards`, {
    pageId,
    html: starter(title),
    css: 'body{margin:0}',
  })
  starting = null
  if (!r.ok || typeof r.body.id !== 'number') {
    message = { board: pageId, text: refusal(r.body) }
    return
  }
  await load()
}

async function setRole(b: Board, role: string, oldLeadBecomes?: string) {
  const r = await api('POST', `/api/p/${id}/design/artboards/${b.id}/role`, { role, oldLeadBecomes })
  if (!r.ok) {
    message = { board: b.id, text: refusal(r.body) }
    return
  }
  message = null
  asking = null
  await load()
}

function askLead(b: Board) {
  message = null
  // No Lead to replace: no question to ask.
  const page = data?.pages.find((p) => p.id === b.pageId)
  if (page && !leadOf(page.artboards)) setRole(b, 'lead')
  else asking = b.id
}
</script>

<main class="main">
  <div class="pagehead">
    <div class="stack" style="gap: 6px">
      <h1>{s.heading}</h1>
      <p class="muted">{s.sub}</p>
    </div>
    <button
      type="button"
      class="tool alt"
      aria-pressed={showAlt}
      onclick={() => (showAlt = !showAlt)}
      ><span class="sw" class:on={showAlt} aria-hidden="true"></span>{s.showAlt}</button
    >
  </div>

  {#if failed}
    <p role="alert">{s.loadError}</p>
  {:else if data}
    {#if data.pages.length === 0}<p class="muted">{s.noPages}</p>{/if}
    <div class="boards">
      {#each data.pages as p (p.id)}
        {@const lead = leadOf(p.artboards)}
        {@const others = othersOf(p.artboards)}
        {#if lead}
          {@render card(lead, p.title, others.length)}
        {:else}
          <article class="card" aria-labelledby="h-{p.id}">
            <div class="card-h">
              <h2 id="h-{p.id}" class="h2s">{p.title}</h2>
              <span class="chip">{s.noArtboard}</span>
            </div>
            <div class="card-b empty">
              <Icon name="design" />
              <p class="small muted">{s.notDesigned}</p>
              <p class="small muted">{s.startNote}</p>
              {#if message?.board === p.id}<p class="msg" role="alert">{message.text}</p>{/if}
            </div>
            <div class="card-f">
              <button
                type="button"
                class="btn primary"
                disabled={starting === p.id}
                onclick={() => start(p.id, p.title)}
                >{starting === p.id ? s.starting : s.startDesign}</button
              >
            </div>
          </article>
        {/if}
        {#if showAlt}
          {#each others as b (b.id)}
            {@render card(b, p.title, 0)}
          {/each}
        {/if}
      {/each}
    </div>
  {/if}
</main>

<DecisionBar did={s.ovDid}>
  <span class="conseq">{s.ovConseq}</span>
  <a class="btn" href="/p/{id}/pages/new" use:link>{s.newPage}</a>
  <a class="btn primary" href="/p/{id}/review" use:link>{s.openReview}</a>
</DecisionBar>

{#snippet card(b: Board, title: string, altCount: number)}
  <article class="card" class:ink={b.role === 'lead'} class:dashed={b.role !== 'lead'} aria-labelledby="c-{b.id}">
    <div class="card-h">
      <h2 id="c-{b.id}" class="h2s">{title}</h2>
      <span class="chip" class:ok={b.role === 'lead'}>{s.roles[b.role]}</span>
      <span class="id">{tag(b)}</span>
      {#if altCount > 0}
        <span class="chip" style="margin-left: auto"
          >{altCount === 1 ? s.oneAlternative : fill(s.alternatives, { n: altCount })}</span
        >
      {/if}
    </div>
    <div class="card-b">
      {#if b.description}<p class="small">{b.description}</p>{/if}
      <div class="row small prog">
        <span class="secbar" aria-hidden="true"
          >{#each b.sections as x (x.id)}<i class:on={x.progress === 'approved'}></i>{/each}</span
        >
        <span>{progress(b)}</span>
        <span class="muted">· {sectionLine(b)}</span>
      </div>
      {#if b.unsettledDeviations > 0}
        <p class="small"><span class="chip warn"><Icon name="warn" small />{fill(s.unsettled, { n: b.unsettledDeviations })}</span></p>
      {/if}
      {#if asking === b.id}
        <div class="ask" role="group" aria-label={fill(s.makeLeadYes, { id: tag(b) })}>
          {#each data?.pages.filter((p) => p.id === b.pageId) ?? [] as p (p.id)}
            {@const old = leadOf(p.artboards)}
            {#if old}<p class="small" style="font-weight: 600">{fill(s.askOld, { id: tag(old) })}</p>{/if}
          {/each}
          <label><input type="radio" name="old-{b.id}" checked={becomes === 'alternative'} onchange={() => (becomes = 'alternative')} />{s.becomesAlt}</label>
          <label><input type="radio" name="old-{b.id}" checked={becomes === 'reference'} onchange={() => (becomes = 'reference')} />{s.becomesRef}</label>
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn quiet" onclick={() => (asking = null)}>{s.cancel}</button>
            <button type="button" class="btn" onclick={() => setRole(b, 'lead', becomes)}>{fill(s.makeLeadYes, { id: tag(b) })}</button>
          </div>
        </div>
      {/if}
      {#if message?.board === b.id}<p class="msg" role="alert">{message.text}</p>{/if}
    </div>
    <div class="card-f">
      <button type="button" class="btn quiet" disabled={b.role === 'lead'} onclick={() => askLead(b)}>{s.makeLead}</button>
      <button type="button" class="btn quiet" disabled={b.role !== 'alternative'} onclick={() => setRole(b, 'reference')}>{s.parkRef}</button>
      <a class="btn primary" href="/p/{id}/design/{b.id}" use:link>{s.openEditor}</a>
    </div>
  </article>
{/snippet}

<style>
.alt { gap: 10px; }
.sw { width: 34px; height: 20px; border: 1.5px solid currentColor; border-radius: 10px; position: relative; flex: none; display: inline-block; }
.sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: currentColor; transition: transform 0.3s; }
.sw.on::after { transform: translateX(14px); }
.boards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(480px, 100%), 1fr)); gap: 28px; align-items: stretch; }
.card.dashed { border-style: dashed; border-color: var(--caption); }
.card-b.empty { align-items: center; justify-content: center; text-align: center; min-height: 200px; border: 1px dashed var(--caption); margin: 18px; }
.secbar { display: flex; gap: 3px; flex-wrap: wrap; }
.secbar i { display: block; width: 26px; height: 8px; border: 1px solid var(--ink); }
.secbar i.on { background: var(--ink); }
.prog { gap: 10px; }
.ask { border: 1px solid var(--ink); background: #fff; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.ask label { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 14px; cursor: pointer; }
.ask input { width: 18px; height: 18px; accent-color: var(--ink); }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
.btn.quiet[disabled] { background: transparent; border-color: transparent; }
</style>
