<script lang="ts">
// The Design editor (plan §6.1-6.6; design/prototype/DesignEditor.dc.html). The canvas is the
// preview site in an iframe (rule 4: generated code never runs on this origin). The section
// labels are drawn here, from where the preview shell says each section sits: the HTML never
// carries an annotation. The AI proposes takes; a person applies them.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { ds, fill, refusal } from '../lib/design-strings.ts'
import { link } from '../lib/router.svelte.ts'

let { id, artboard, current }: { id: string; artboard: number; current: string | null } = $props()

type Checklist = Record<string, boolean>
type Section = {
  id: string
  name: string
  checklist: Checklist
  translatedNotNeeded: boolean
  progress: string
  done: number
  approved: { at: string; by: string } | null
}
type Deviation = {
  id: number
  sectionId: string | null
  rule: string
  message: string
  status: 'open' | 'experiment' | 'proposed' | 'fixed'
}
type Board = {
  id: number
  pageId: string
  letter: string
  role: string
  htmlHash: string
  cssHash: string
  html: string
  sections: Section[]
  deviations: Deviation[]
}
type Issue = { rule: string; message: string; sectionId?: string }
type Take = {
  id: number
  scope: string
  level: string
  summary: string
  proposals: { kind: string; name: string; detail: string }[]
  warnings: Issue[]
  deviations: Issue[]
  deviationId: number | null
}
type Box = { id: string; x: number; y: number; w: number; h: number }

const SECTION_ID = /^s-[a-z0-9]{6}$/
const WIDTHS = { desktop: 1280, tablet: 768, mobile: 375 } as const
const GROUPS = {
  form: ['layout', 'density', 'depth', 'navigation', 'media'],
  feel: ['tone', 'colour-rhythm', 'motion'],
} as const
// Links last 15 minutes; fetch a new one a little before that.
const REFRESH_MS = 12 * 60 * 1000

const s = $derived(ds())
const base = $derived(`/api/p/${id}/design`)

let board = $state<Board | null>(null)
let pageTitle = $state('')
let presence = $state<{ handle: string; name: string }[]>([])
let failed = $state(false)
let selected = $state<string | null>(null)
let baseline: Map<string, string> | null = null

// Canvas
let frame = $state<HTMLIFrameElement | null>(null)
let previewUrl = $state<string | null>(null)
let previewFailed = $state(false)
let device = $state<keyof typeof WIDTHS>('desktop')
let labelsOn = $state(true)
let boxes = $state<Box[]>([])
let frameHeight = $state(600)

// Prompt bar
let prompt = $state('')
let creative = $state<'follow' | 'explore'>('follow')
let thinkNew = $state(false)
let axis = $state<string | null>(null)
let steer = $state('')
let menuOpen = $state(false)
let group = $state<'form' | 'feel'>('form')
let estimate = $state<{ low: number; high: number } | null>(null)
let busy = $state(false)

// Take result and messages
let take = $state<Take | null>(null)
let takeMsg = $state<{ text: string; ok: boolean } | null>(null)
let appliedNew = $state<{ id: number; tag: string } | null>(null)
let checkMsg = $state<string | null>(null)
let devMsg = $state<{ id: number; text: string } | null>(null)
let working = $state<number | null>(null)

const scope = $derived(selected ?? 'page')
const level = $derived(thinkNew ? 'think-new' : creative)
const sel = $derived(board?.sections.find((x) => x.id === selected) ?? null)
const tag = $derived(board ? `${id}-${board.letter}` : '')
const live = $derived(board?.deviations.filter((d) => d.status === 'open' || d.status === 'experiment') ?? [])
const deviating = $derived(new Set(live.flatMap((d) => (d.sectionId ? [d.sectionId] : []))))
const origin = $derived.by(() => {
  try {
    return previewUrl ? new URL(previewUrl).origin : null
  } catch {
    return null
  }
})
const nameOf = (sid: string | null | undefined) =>
  board?.sections.find((x) => x.id === sid)?.name ?? s.wholePage

/** The sections' own markup by id, to count what changed since the editor was opened. */
function sectionHtml(html: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const el of new DOMParser().parseFromString(html, 'text/html').querySelectorAll('[data-section]'))
    out.set(el.getAttribute('data-section') ?? '', el.outerHTML)
  return out
}
const changed = $derived.by(() => {
  if (!board || !baseline) return 0
  let n = 0
  for (const [k, v] of sectionHtml(board.html)) if (baseline.get(k) !== v) n++
  return n
})

async function load() {
  failed = false
  const [b, o] = await Promise.all([
    api<Board>('GET', `${base}/artboards/${artboard}`),
    api<{ pages: { id: string; title: string }[]; presence: { handle: string; name: string }[] }>(
      'GET',
      base,
    ),
  ])
  if (!b.ok) {
    failed = true
    return
  }
  board = b.body
  baseline = sectionHtml(b.body.html)
  pageTitle = o.body.pages?.find((p) => p.id === b.body.pageId)?.title ?? ''
  presence = o.body.presence ?? []
  await fetchPreview()
}

let refresh: ReturnType<typeof setTimeout> | undefined
async function fetchPreview() {
  clearTimeout(refresh)
  const r = await api<{ url?: string }>('GET', `${base}/artboards/${artboard}/preview`)
  if (!r.ok || !r.body.url) {
    previewFailed = true
    return
  }
  previewFailed = false
  boxes = []
  previewUrl = r.body.url
  refresh = setTimeout(fetchPreview, REFRESH_MS)
}

$effect(() => {
  void artboard
  board = null
  previewUrl = null
  selected = null
  take = null
  boxes = []
  load()
  return () => clearTimeout(refresh)
})

// The preview shell tells us where the sections sit. Only this frame, from the preview origin,
// with the right message type and a sane shape, is believed; unknown ids are dropped.
function onMessage(e: MessageEvent) {
  if (!origin || !frame || e.origin !== origin || e.source !== frame.contentWindow) return
  const d = e.data as { type?: unknown; boxes?: unknown; height?: unknown } | null
  if (!d || d.type !== 'ss-sections' || !Array.isArray(d.boxes)) return
  if (typeof d.height !== 'number' || !Number.isFinite(d.height)) return
  const known = new Set(board?.sections.map((x) => x.id))
  const out: Box[] = []
  for (const raw of d.boxes) {
    const b = raw as Partial<Box> | null
    if (!b || typeof b.id !== 'string' || !SECTION_ID.test(b.id) || !known.has(b.id)) continue
    const { x, y, w, h } = b
    if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
    out.push({ id: b.id, x: x as number, y: y as number, w: w as number, h: h as number })
  }
  boxes = out
  frameHeight = Math.min(Math.max(Math.ceil(d.height), 120), 30000)
}
$effect(() => {
  addEventListener('message', onMessage)
  return () => removeEventListener('message', onMessage)
})

/** A new board from the server; a new preview when the page itself changed. */
function adopt(next: Board) {
  const moved = !board || next.htmlHash !== board.htmlHash || next.cssHash !== board.cssHash
  board = next
  if (moved) fetchPreview()
}

// ---- checklist ----

async function tick(item: string, on: boolean, input: HTMLInputElement) {
  if (!board || !selected) return
  checkMsg = null
  const r = await api<Board>('PUT', `${base}/sections/${board.id}/${selected}/check/${item}`, { on })
  if (!r.ok) {
    input.checked = !on
    checkMsg = refusal(r.body)
    return
  }
  adopt(r.body)
}

async function approve(action: 'approve' | 'unlock') {
  if (!board || !selected) return
  checkMsg = null
  const r = await api<Board>('POST', `${base}/sections/${board.id}/${selected}/${action}`)
  if (!r.ok) {
    checkMsg = refusal(r.body)
    return
  }
  adopt(r.body)
}

// ---- takes ----

type TakeReply = { take?: Take; level?: string; code?: string } & Record<string, unknown>

function pickAxis(a: string) {
  axis = a
  menuOpen = false
}
function select(sid: string | null) {
  selected = sid
  checkMsg = null
  // A whole-page take can only be about layout.
  if (sid === null && axis && axis !== 'layout') axis = null
}

$effect(() => {
  // The estimate follows what the request would be.
  if (!board) return
  const q = new URLSearchParams({ scope, level, prompt: prompt.slice(0, 1000) })
  if (axis) q.set('axis', axis)
  const bid = board.id
  const t = setTimeout(async () => {
    const r = await api<{ low: number; high: number }>('GET', `${base}/artboards/${bid}/takes/estimate?${q}`)
    estimate = r.ok ? r.body : null
  }, 300)
  return () => clearTimeout(t)
})

async function generate() {
  if (!board || busy) return
  if (!prompt.trim() && !axis) {
    takeMsg = { text: s.needPrompt, ok: false }
    return
  }
  busy = true
  takeMsg = null
  appliedNew = null
  const r = await api<TakeReply>('POST', `${base}/artboards/${board.id}/takes`, {
    scope,
    prompt,
    axis: axis ?? undefined,
    steer: axis && steer ? steer : undefined,
    level,
  })
  busy = false
  // Think new is never sticky: whatever was asked, the server answers with the next level
  // (follow) and the switch goes off.
  thinkNew = false
  if (!r.ok || !r.body.take) {
    takeMsg = { text: refusal(r.body), ok: false }
    return
  }
  take = r.body.take
}

async function applyTake() {
  if (!board || !take) return
  takeMsg = null
  const r = await api<Board & { code?: string }>('POST', `${base}/artboards/${board.id}/takes/${take.id}/apply`)
  if (!r.ok) {
    takeMsg = { text: refusal(r.body), ok: false }
    return
  }
  take = null
  if (r.body.id !== board.id) {
    appliedNew = { id: r.body.id, tag: `${id}-${r.body.letter}` }
    takeMsg = { text: fill(s.appliedNew, { id: appliedNew.tag }), ok: true }
    return
  }
  takeMsg = { text: s.applied, ok: true }
  adopt(r.body)
}

function discard() {
  take = null
  takeMsg = { text: s.discarded, ok: true }
}

// ---- deviations ----

async function outcome(d: Deviation, how: 'experiment' | 'proposed') {
  devMsg = null
  const r = await api('POST', `${base}/deviations/${d.id}/${how === 'proposed' ? 'propose' : 'outcome'}`, how === 'proposed' ? undefined : { outcome: how })
  if (!r.ok) {
    devMsg = { id: d.id, text: refusal(r.body) }
    return
  }
  if (how === 'proposed') devMsg = { id: d.id, text: s.proposedDone }
  const b = await api<Board>('GET', `${base}/artboards/${artboard}`)
  if (b.ok) adopt(b.body)
}

async function fix(d: Deviation) {
  devMsg = null
  working = d.id
  const r = await api<TakeReply>('POST', `${base}/deviations/${d.id}/fix`)
  working = null
  thinkNew = false
  if (!r.ok || !r.body.take) {
    devMsg = { id: d.id, text: refusal(r.body) }
    return
  }
  take = r.body.take
  takeMsg = null
}

const statusName = (st: Deviation['status']) =>
  ({ open: s.statusOpen, experiment: s.statusExperiment, proposed: s.statusProposed, fixed: s.statusFixed })[st]
const consequence = $derived(
  !take
    ? ''
    : take.deviationId !== null
      ? s.consFix
      : take.scope !== 'page' && take.level !== 'think-new'
        ? s.consSection
        : s.consNew,
)
const initials = (n: string) => n.slice(0, 2).toUpperCase()
</script>

<main class="main ed">
  {#if failed}
    <p role="alert">{s.loadError}</p>
    <a class="btn" href="/p/{id}/design" use:link>{s.back}</a>
  {:else if board}
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <a class="back" href="/p/{id}/design" use:link><Icon name="arrow-left" small />{s.back}</a>
        <h1>{pageTitle}</h1>
        <p class="small muted ctx">
          <span class="id">{tag}</span>
          {fill(s.context, {
            page: pageTitle,
            revision: current ?? s.noRevision,
            role: s.roles[board.role] ?? board.role,
            n: changed,
          })}
        </p>
      </div>
      {#if presence.length}
        <div class="who" role="group" aria-label={s.presenceLabel}>
          {#each presence as p (p.handle)}
            <span class="avatar" title={fill(s.presence, { name: p.name })}
              ><span aria-hidden="true">{initials(p.name)}</span><span class="sr">{fill(s.presence, { name: p.name })}</span></span
            >
          {/each}
        </div>
      {/if}
    </div>

    <div class="edgrid">
      <nav class="outline" aria-label={s.outline}>
        <h2 class="label">{s.outline}</h2>
        <ul class="olist">
          <li>
            <button type="button" class="orow" aria-pressed={selected === null} onclick={() => select(null)}>
              <b>{s.wholePage}</b>
              <span class="id">{tag}</span>
            </button>
          </li>
          {#each board.sections as x (x.id)}
            <li>
              <button type="button" class="orow" aria-pressed={selected === x.id} onclick={() => select(x.id)}>
                <b>{x.name}</b>
                <span class="meta">
                  {#if x.approved}<span class="chip ok"><Icon name="lock" small />{s.statusApproved}</span>
                  {:else}<span class="chip">{x.progress}</span>{/if}
                  {#if deviating.has(x.id)}<span class="chip warn"><Icon name="warn" small />{s.statusDeviates}</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </nav>

      <section class="canvas" aria-label={s.canvas}>
        <div class="bar">
          <div class="seg" role="group" aria-label={s.device}>
            <button type="button" aria-pressed={device === 'desktop'} onclick={() => (device = 'desktop')}><Icon name="desktop" small /> {s.desktop}</button>
            <button type="button" aria-pressed={device === 'tablet'} onclick={() => (device = 'tablet')}><Icon name="tablet" small /> {s.tablet}</button>
            <button type="button" aria-pressed={device === 'mobile'} onclick={() => (device = 'mobile')}><Icon name="mobile" small /> {s.mobile}</button>
          </div>
          <button type="button" class="tool" aria-pressed={labelsOn} onclick={() => (labelsOn = !labelsOn)}>{labelsOn ? s.hideLabels : s.showLabels}</button>
        </div>
        <div class="mat">
          {#if previewFailed}
            <p role="alert" class="msg">{s.canvasFailed} <button type="button" class="btn quiet" onclick={fetchPreview}>{s.reload}</button></p>
          {:else if !previewUrl}
            <p class="small muted">{s.canvasLoading}</p>
          {:else}
            <div class="stage" style="width: {WIDTHS[device]}px">
              <iframe
                bind:this={frame}
                src={previewUrl}
                title={fill(s.frameTitle, { id: tag })}
                style="height: {frameHeight}px"
                referrerpolicy="no-referrer"
              ></iframe>
              {#if labelsOn}
                <div class="overlay">
                  {#each boxes as b (b.id)}
                    <div
                      class="rect"
                      class:sel={selected === b.id}
                      class:dev={deviating.has(b.id)}
                      style="left: {b.x}px; top: {b.y}px; width: {b.w}px; height: {b.h}px"
                    ></div>
                    <button
                      type="button"
                      class="slabel"
                      class:sel={selected === b.id}
                      class:dev={deviating.has(b.id)}
                      aria-pressed={selected === b.id}
                      style="left: {b.x + 8}px; top: {b.y + 8}px"
                      onclick={() => select(b.id)}
                      >{#if deviating.has(b.id)}<Icon name="warn" small />{/if}{nameOf(b.id)}<span class="sr"> · {fill(s.labelOf, { name: nameOf(b.id) })}</span></button
                    >
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </section>

      <aside class="inspector" aria-label={s.inspector}>
        <h2 class="label">{s.inspector}</h2>
        {#if !sel}
          <p class="small muted">{s.nothingSelected}</p>
        {:else}
          <div class="card">
            <div class="card-h"><h3 class="h3s">{sel.name}</h3><span class="id">{selected}</span></div>
            <div class="card-b">
              <fieldset class="checks">
                <legend class="label">{s.checklist}</legend>
                {#each Object.keys(s.checks) as item (item)}
                  {@const auto = item === 'translated' && sel.translatedNotNeeded}
                  <label class="chk">
                    <input
                      type="checkbox"
                      checked={sel.checklist[item]}
                      disabled={!!sel.approved || auto}
                      onchange={(e) => tick(item, e.currentTarget.checked, e.currentTarget)}
                    />
                    <span>{s.checks[item]}{#if auto} · {s.notNeeded}{/if}</span>
                  </label>
                {/each}
              </fieldset>
              <p class="small muted">{s.checklistNote}</p>
              {#if sel.approved}<p class="small"><Icon name="lock" small /> {fill(s.approvedBy, { by: sel.approved.by })}</p>
                <p class="small muted">{s.unlockNote}</p>{/if}
              {#if checkMsg}<p class="msg" role="alert">{checkMsg}</p>{/if}
            </div>
            <div class="card-f">
              {#if sel.approved}
                <button type="button" class="btn" onclick={() => approve('unlock')}>{s.unlock}</button>
              {:else}
                <button type="button" class="btn" onclick={() => approve('approve')}>{s.approve}</button>
              {/if}
            </div>
          </div>
        {/if}
      </aside>
    </div>

    <section class="card" aria-labelledby="dev-h">
      <div class="card-h"><Icon name="warn" /><h2 id="dev-h" class="h2s sm">{s.deviations}</h2></div>
      <div class="card-b">
        {#if board.deviations.filter((d) => d.status !== 'fixed').length === 0}
          <p class="small muted">{s.noDeviations}</p>
        {/if}
        {#each board.deviations.filter((d) => d.status !== 'fixed') as d (d.id)}
          <div class="dev-row">
            <div class="stack" style="gap: 4px; flex: 1 1 280px">
              <span class="row small"><span class="chip warn">{statusName(d.status)}</span><b>{nameOf(d.sectionId)}</b><span class="id">{d.rule}</span></span>
              <p class="small">{d.message}</p>
              {#if devMsg?.id === d.id}<p class="msg" role="alert">{devMsg.text}</p>{/if}
            </div>
            <div class="row">
              <button type="button" class="btn" disabled={working === d.id} onclick={() => fix(d)}>{s.fixIt}</button>
              {#if d.status === 'open'}
                <button type="button" class="btn" onclick={() => outcome(d, 'experiment')}>{s.keepExperiment}</button>
                <button type="button" class="btn" onclick={() => outcome(d, 'proposed')}>{s.proposeGuide}</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </section>

    {#if take}
      <section class="card ink" aria-labelledby="take-h">
        <div class="card-h"><Icon name="design" /><h2 id="take-h" class="h2s sm">{s.take}</h2>
          <span class="chip">{nameOf(take.scope === 'page' ? null : take.scope)}</span>
          {#if take.level === 'think-new'}<span class="chip warn">{s.thinkNew}</span>{/if}
        </div>
        <div class="card-b">
          <div><span class="label">{s.takeSummary}</span><p>{take.summary}</p></div>
          {#if take.warnings.length === 0 && take.deviations.length === 0}<p class="small muted">{s.takeNone}</p>{/if}
          {#if take.warnings.length}
            <div><span class="label">{s.takeWarnings}</span>
              <ul class="plain">{#each take.warnings as w}<li class="small">{w.message}</li>{/each}</ul></div>
          {/if}
          {#if take.deviations.length}
            <div><span class="label">{s.takeDeviations}</span>
              <ul class="plain">{#each take.deviations as w}<li class="small"><span class="chip warn">{nameOf(w.sectionId)}</span> {w.message}</li>{/each}</ul></div>
          {/if}
          {#if take.proposals.length}
            <div><span class="label">{s.takeProposals}</span>
              <ul class="plain">{#each take.proposals as p}<li class="small"><b>{p.name}</b> · {p.detail}</li>{/each}</ul></div>
          {/if}
        </div>
      </section>
    {/if}

    {#if takeMsg}
      <p class="msg" class:okmsg={takeMsg.ok} role={takeMsg.ok ? 'status' : 'alert'}>
        {takeMsg.text}
        {#if appliedNew}<a href="/p/{id}/design/{appliedNew.id}" use:link>{fill(s.openNew, { id: appliedNew.tag })}</a>{/if}
      </p>
    {/if}

    <section class="card" aria-labelledby="prompt-h">
      <div class="card-h">
        <h2 id="prompt-h" class="h2s sm">{s.promptHead}</h2>
        <span class="chip">{s.scope}: {nameOf(selected)}</span>
        <span class="small muted">{s.scopeFollows}</span>
      </div>
      <div class="card-b">
        <div class="field">
          <label for="prompt">{s.prompt}</label>
          <textarea id="prompt" class="input" bind:value={prompt} placeholder={s.promptPh}></textarea>
        </div>
        <div class="row ctl">
          <div class="field">
            <label for="creative">{s.creative}</label>
            <select id="creative" class="input" bind:value={creative} disabled={thinkNew}>
              <option value="follow">{s.follow}</option>
              <option value="explore">{s.explore}</option>
            </select>
          </div>
          <button type="button" class="thinknew" class:on={thinkNew} role="switch" aria-checked={thinkNew} onclick={() => (thinkNew = !thinkNew)}>
            <span class="sw" class:on={thinkNew} aria-hidden="true"></span>
            <span><b>{s.thinkNew}</b></span>
          </button>
          <div class="menuwrap">
            <button type="button" class="btn" aria-expanded={menuOpen} aria-haspopup="true" onclick={() => (menuOpen = !menuOpen)}>{s.another}</button>
            {#if menuOpen}
              <div class="popup" role="group" aria-label={s.another}>
                <div class="seg" role="group" aria-label={s.group}>
                  <button type="button" aria-pressed={group === 'form'} onclick={() => (group = 'form')}>{s.groups.form}</button>
                  <button type="button" aria-pressed={group === 'feel'} onclick={() => (group = 'feel')}>{s.groups.feel}</button>
                </div>
                <div class="axes" role="group" aria-label={s.axis}>
                  {#each GROUPS[group] as a (a)}
                    <button type="button" class="btn" aria-pressed={axis === a} disabled={selected === null && a !== 'layout'} onclick={() => pickAxis(a)}>{s.axes[a]}</button>
                  {/each}
                </div>
                <div class="field">
                  <label for="steer">{s.steer}</label>
                  <input id="steer" class="input" bind:value={steer} placeholder={s.steerPh} />
                </div>
              </div>
            {/if}
          </div>
        </div>
        {#if thinkNew}<p class="small warnnote">{s.thinkNewNote}</p>{/if}
        {#if axis}
          <p class="row small"><span class="chip">{fill(s.axisChosen, { axis: s.axes[axis] ?? axis })}</span>
            <button type="button" class="btn quiet" onclick={() => (axis = null)}>{s.clearAxis}</button></p>
        {/if}
        <p class="small muted" aria-live="polite">{estimate ? fill(s.estimate, { low: estimate.low, high: estimate.high }) : s.estimateNone}</p>
      </div>
    </section>
  {/if}
</main>

{#if board}
  <DecisionBar did={take ? s.takeDid : s.idleDid}>
    <span class="conseq">{take ? consequence : s.consGenerate}</span>
    {#if take}
      <button type="button" class="btn quiet" onclick={discard}>{s.discard}</button>
      <button type="button" class="btn primary" onclick={applyTake}>{s.applyTake}</button>
    {:else}
      <button type="button" class="btn primary" disabled={busy} onclick={generate}>{busy ? s.generating : s.generate}</button>
    {/if}
  </DecisionBar>
{/if}

<style>
.ed { max-width: 1680px; }
.back { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: 13.5px; }
.ctx { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.who { display: flex; gap: 6px; }
.edgrid { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.outline { flex: 1 1 220px; max-width: 280px; display: flex; flex-direction: column; gap: 8px; }
.canvas { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.inspector { flex: 1 1 300px; max-width: 360px; display: flex; flex-direction: column; gap: 8px; }
.olist { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--ink); }
.orow { width: 100%; min-height: 44px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px 10px; background: none; border: 0; border-bottom: 1px solid var(--rule); text-align: left; cursor: pointer; }
.orow[aria-pressed="true"] { background: var(--sheet); outline: 1px solid var(--ink); outline-offset: -1px; }
.orow b { font-size: 14px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 4px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
.mat { background: var(--mat); padding: 24px; overflow: auto; max-height: 72vh; }
.stage { position: relative; background: #fff; margin: 0 auto; flex: none; }
.stage iframe { display: block; width: 100%; border: 0; background: #fff; }
.overlay { position: absolute; inset: 0; pointer-events: none; }
.rect { position: absolute; border: 1px dashed var(--quiet); box-sizing: border-box; }
.rect.sel { border: 2px solid var(--ink); }
.rect.dev { border-color: var(--warn-border); border-style: dashed; }
.slabel { position: absolute; pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 8px; background: var(--ink); color: var(--sheet); border: 1px solid var(--sheet); font-family: var(--font-mono); font-size: 11.5px; cursor: pointer; max-width: 60%; }
.slabel.dev { background: var(--warn-bg); color: var(--warn-ink); border-color: var(--warn-border); }
.slabel.sel { outline: 2px solid var(--signal); outline-offset: 1px; }
.checks { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; }
.chk { display: flex; align-items: center; gap: 10px; min-height: 44px; border-bottom: 1px solid var(--rule); font-size: 14px; cursor: pointer; }
.chk input { width: 18px; height: 18px; accent-color: var(--ink); }
.h3s { font-size: 16px; font-weight: 600; }
.h2s.sm { font-size: 22px; }
.dev-row { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--rule); }
.plain { margin: 4px 0 0; padding-left: 18px; }
.ctl { align-items: flex-end; gap: 12px 20px; }
.menuwrap { position: relative; }
.popup { position: absolute; left: 0; top: 100%; z-index: 10; min-width: 300px; background: var(--sheet); border: 1px solid var(--ink); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.axes { display: flex; flex-wrap: wrap; gap: 6px; }
.axes .btn[aria-pressed="true"] { background: var(--ink); color: var(--sheet); }
.axes .btn[disabled] { background: var(--fill); color: #6b6b67; border-color: var(--rule); cursor: not-allowed; }
.thinknew { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 12px; border: 1px solid var(--warn-border); background: repeating-linear-gradient(-45deg, var(--warn-bg) 0 8px, var(--warn-stripe) 8px 16px); color: var(--warn-ink); cursor: pointer; font: inherit; }
.thinknew.on { background: var(--warn-ink); color: var(--warn-bg); border-color: var(--warn-ink); }
.warnnote { padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
.sw { width: 34px; height: 20px; border: 1.5px solid currentColor; border-radius: 10px; position: relative; flex: none; display: inline-block; }
.sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: currentColor; transition: transform 0.3s; }
.sw.on::after { transform: translateX(14px); }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
.msg.okmsg { background: var(--sheet); border-color: var(--ink); color: var(--ink); }
.chip.ok { background: var(--ink); color: var(--sheet); border-color: var(--ink); }
textarea.input { min-height: 80px; resize: vertical; }
select.input { min-width: 200px; }
</style>
