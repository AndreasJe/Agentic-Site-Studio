<script lang="ts">
// The Review screen (plan §7, §13.2a; design/prototype/Review.dc.html; M5, decision #46). A saved
// revision is shown as the files that would ship, in a review shell on the preview site (rule 4:
// generated code never runs on this origin). Section boxes and accessibility findings come from
// the shell by postMessage and are advisory display only: a message can change the selection and
// the findings shown, never tick, approve or navigate. Approval uses the app's own data.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { navigate, link } from '../lib/router.svelte.ts'
import { fill, refusal, rs } from '../lib/review-strings.ts'

let { id, rev }: { id: string; rev?: string } = $props()

type Checklist = Record<string, boolean>
type Approved = { at: string; by: string } | null
type Section = {
  id: string
  name: string
  checklist: Checklist
  approved: Approved
  done: number
  progress: string
}
type Page = {
  id: string
  title: string
  lead: { letter: string; artboard: number; sections: Section[] } | null
}
type Detail = {
  rev: string
  pages: Page[]
  approved: { n: number; m: number }
  package: { hash: string }
  ready: boolean
  canApprove: boolean
  blockers: unknown[]
  acceptances: Acceptance[]
  approval: { packageHash: string; at: string; by: string } | null
}
type Acceptance = { id: number; rule: string; target: string; reason: string; at: string; by: string }
type Finding = { rule: string; impact: string | null; help: string; targets: string[] }
type Box = { id: string; x: number; y: number; w: number; h: number }
type Suggestion = { item: string; reason: string }
type LiveSection = { checklist: Checklist; approved: Approved }

const SECTION_ID = /^s-[a-z0-9]{6}$/
const ITEMS = ['copy', 'media', 'interactions', 'mobile', 'motion', 'translated', 'tested']
const WIDTHS = { desktop: 1280, tablet: 768, mobile: 375 } as const
// Links last 15 minutes; fetch a new one a little before that.
const REFRESH_MS = 12 * 60 * 1000

const s = $derived(rs())

let revisions = $state<{ id: string; approved: boolean }[]>([])
let listed = $state(false)
let failed = $state(false)
let detail = $state<Detail | null>(null)
const revId = $derived(rev ?? revisions[0]?.id ?? null)

// Canvas
let frame = $state<HTMLIFrameElement | null>(null)
let shell = $state<{ url: string; pages: string[] } | null>(null)
let previewFailed = $state(false)
let page = $state('index.html')
let device = $state<keyof typeof WIDTHS>('desktop')
let labelsOn = $state(true)
let boxes = $state<Box[]>([])
let frameHeight = $state(600)
let findings = $state<Finding[] | null>(null)

// Panel
let selected = $state<string | null>(null)
let live = $state<Record<string, LiveSection>>({})
let touched = $state(false)
let checkMsg = $state<string | null>(null)
let suggestions = $state<Record<string, Suggestion[]>>({})
let suggesting = $state(false)
let suggestMsg = $state<string | null>(null)
let reasons = $state<Record<string, string>>({})
let findingMsg = $state<{ key: string; text: string } | null>(null)
let approving = $state(false)
let approveMsg = $state<string | null>(null)
let copied = $state(false)

const src = $derived(shell ? `${shell.url}#page=${page}` : null)
const origin = $derived.by(() => {
  try {
    return shell ? new URL(shell.url).origin : null
  } catch {
    return null
  }
})

const knownIds = $derived(
  new Set(detail?.pages.flatMap((p) => p.lead?.sections.map((x) => x.id) ?? []) ?? []),
)
// The page being looked at: the one whose Lead holds the sections the shell found.
const current = $derived.by(() => {
  if (!detail) return null
  const ids = new Set(boxes.map((b) => b.id))
  return (
    detail.pages.find((p) => p.lead?.sections.some((x) => ids.has(x.id))) ??
    detail.pages[shell ? Math.max(shell.pages.indexOf(page), 0) : 0] ??
    null
  )
})
const lead = $derived(current?.lead ?? null)
const sel = $derived(lead?.sections.find((x) => x.id === selected) ?? null)
const view = (x: Section): LiveSection => live[x.id] ?? { checklist: x.checklist, approved: x.approved }
const nameOf = (sid: string) => lead?.sections.find((x) => x.id === sid)?.name ?? sid
const hash12 = $derived(detail?.package.hash.slice(0, 12) ?? '')
const left = $derived(detail ? detail.blockers.length : 0)
const accepted = $derived(
  new Set((detail?.acceptances ?? []).map((a) => `${a.rule}\u0000${a.target}`)),
)
const isAccepted = (f: Finding) =>
  f.targets.length > 0 && f.targets.every((t) => accepted.has(`${f.rule}\u0000${t}`))

// ---- loading ----

$effect(() => {
  failed = false
  api<{ revisions: { id: string; approved: boolean }[] }>('GET', `/api/p/${id}/review`).then((r) => {
    listed = true
    if (!r.ok) {
      failed = true
      return
    }
    revisions = r.body.revisions
  })
})

let refresh: ReturnType<typeof setTimeout> | undefined
async function fetchLink(rid: string) {
  clearTimeout(refresh)
  const r = await api<{ url?: string; pages?: string[] }>('GET', `/api/p/${id}/review/${rid}/link`)
  if (rid !== revId) return
  if (!r.ok || !r.body.url || !Array.isArray(r.body.pages)) {
    previewFailed = true
    return
  }
  previewFailed = false
  const pages = r.body.pages.filter((p): p is string => typeof p === 'string')
  // Keep the same page and token origin on a refresh; only the token changes.
  shell = { url: r.body.url, pages }
  if (!pages.includes(page)) page = pages[0] ?? 'index.html'
  refresh = setTimeout(() => fetchLink(rid), REFRESH_MS)
}

async function loadDetail(rid: string) {
  const r = await api<Detail>('GET', `/api/p/${id}/review/${rid}`)
  if (rid !== revId) return
  if (!r.ok) {
    failed = true
    return
  }
  detail = r.body
}

$effect(() => {
  const rid = revId
  detail = null
  shell = null
  boxes = []
  findings = null
  selected = null
  live = {}
  touched = false
  suggestions = {}
  checkMsg = null
  approveMsg = null
  if (!rid) return
  loadDetail(rid)
  fetchLink(rid)
  return () => clearTimeout(refresh)
})

$effect(() => {
  // A new page: the old boxes and findings no longer apply.
  void page
  boxes = []
  findings = null
  selected = null
})

// ---- messages from the shell ----
// Only this frame, from the preview origin, with the right type and a sane shape is believed.
// What it says can change the boxes, the selection's options and the findings shown. Nothing else.

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null)

function readFindings(raw: unknown): Finding[] | null {
  if (!Array.isArray(raw)) return null
  const out: Finding[] = []
  for (const f of raw.slice(0, 100)) {
    const o = f as Partial<Record<keyof Finding, unknown>> | null
    const rule = str(o?.rule, 200)
    const help = str(o?.help, 500)
    if (!o || !rule || help === null) continue
    const impact = typeof o.impact === 'string' ? o.impact.slice(0, 20) : null
    const targets = (Array.isArray(o.targets) ? o.targets : [])
      .slice(0, 20)
      .map((t) => str(t, 500))
      .filter((t): t is string => !!t)
    out.push({ rule, impact, help, targets })
  }
  return out
}

function onMessage(e: MessageEvent) {
  if (!origin || !frame || e.origin !== origin || e.source !== frame.contentWindow) return
  const d = e.data as { type?: unknown; page?: unknown; boxes?: unknown; height?: unknown } | null
  if (!d || d.type !== 'ss-review' || !shell || !Array.isArray(d.boxes)) return
  if (typeof d.page !== 'string' || !shell.pages.includes(d.page) || d.page !== page) return
  if (typeof d.height !== 'number' || !Number.isFinite(d.height)) return
  const out: Box[] = []
  // One bad entry and the whole message is ignored: a half-believed message is worse than none.
  for (const raw of d.boxes.slice(0, 200)) {
    const b = raw as Partial<Box> | null
    if (!b || typeof b.id !== 'string' || !SECTION_ID.test(b.id) || !knownIds.has(b.id)) return
    const { x, y, w, h } = b
    if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return
    out.push({ id: b.id, x: x as number, y: y as number, w: w as number, h: h as number })
  }
  boxes = out
  frameHeight = Math.min(Math.max(Math.ceil(d.height), 120), 30000)
  const f = readFindings((d as { findings?: unknown }).findings)
  if (f) findings = f
}
$effect(() => {
  addEventListener('message', onMessage)
  return () => removeEventListener('message', onMessage)
})

// ---- actions ----

function select(sid: string | null) {
  selected = sid
  checkMsg = null
  suggestMsg = null
}

function adopt(board: { sections?: Section[] }) {
  const next = { ...live }
  for (const x of board.sections ?? []) next[x.id] = { checklist: x.checklist, approved: x.approved }
  live = next
  touched = true
}

const design = (artboard: number, section: string) =>
  `/api/p/${id}/design/sections/${artboard}/${section}`

async function tick(item: string, on: boolean, input: HTMLInputElement) {
  if (!lead || !selected) return
  checkMsg = null
  const r = await api<{ sections?: Section[] }>('PUT', `${design(lead.artboard, selected)}/check/${item}`, { on })
  if (!r.ok) {
    input.checked = !on
    checkMsg = refusal(r.body)
    return
  }
  adopt(r.body)
}

async function sectionAction(action: 'approve' | 'unlock') {
  if (!lead || !selected) return
  checkMsg = null
  const r = await api<{ sections?: Section[] }>('POST', `${design(lead.artboard, selected)}/${action}`)
  if (!r.ok) {
    checkMsg = refusal(r.body)
    return
  }
  adopt(r.body)
}

async function suggest() {
  if (!revId || !selected || suggesting) return
  const sid = selected
  suggesting = true
  suggestMsg = null
  const r = await api<{ suggestions?: Suggestion[] }>('POST', `/api/p/${id}/review/${revId}/suggest`, {
    sectionId: sid,
  })
  suggesting = false
  if (!r.ok || !Array.isArray(r.body.suggestions)) {
    suggestMsg = refusal(r.body)
    return
  }
  suggestions = {
    ...suggestions,
    [sid]: r.body.suggestions.filter((x) => ITEMS.includes(x.item) && typeof x.reason === 'string'),
  }
  if (!suggestions[sid]?.length) suggestMsg = s.noSuggestions
}

async function accept(f: Finding) {
  if (!revId) return
  const key = f.rule + f.targets.join('|')
  const reason = (reasons[key] ?? '').trim()
  if (reason.length < 3) return
  findingMsg = null
  const targets = f.targets.length ? f.targets : [page]
  for (const target of targets) {
    if (accepted.has(`${f.rule}\u0000${target}`)) continue
    const r = await api<{ acceptances?: Acceptance[] }>('POST', `/api/p/${id}/review/${revId}/findings/accept`, {
      rule: f.rule,
      target,
      reason,
    })
    if (!r.ok) {
      findingMsg = { key, text: refusal(r.body) }
      return
    }
    if (detail && r.body.acceptances) detail.acceptances = r.body.acceptances
  }
}

async function approveRevision() {
  if (!revId || !detail?.canApprove || approving) return
  approving = true
  approveMsg = null
  const r = await api('POST', `/api/p/${id}/review/${revId}/approve`)
  approving = false
  if (!r.ok) {
    approveMsg = refusal(r.body)
    return
  }
  await loadDetail(revId)
  const l = await api<{ revisions: { id: string; approved: boolean }[] }>('GET', `/api/p/${id}/review`)
  if (l.ok) revisions = l.body.revisions
}

async function copyHash() {
  if (!detail) return
  try {
    await navigator.clipboard.writeText(detail.package.hash)
    copied = true
    setTimeout(() => (copied = false), 2000)
  } catch {
    copied = false
  }
}

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
const pageLabel = (p: string) => (p === 'index.html' ? '/' : `/${p.replace(/index\.html$/, '')}`)
</script>

<main class="main review">
  {#if failed}
    <p role="alert">{s.loadError}</p>
  {:else if listed && !revId}
    <div class="pagehead"><h1>{s.heading}</h1></div>
    <p class="muted">{s.noRevisions}</p>
    <a class="btn" style="align-self: flex-start" href="/p/{id}/revisions" use:link>{s.goRevisions}</a>
  {:else if detail}
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{s.heading}</h1>
        <p class="muted">{s.sub}</p>
        <p class="ctx small" data-testid="context">
          <span class="id">{revId}</span>
          <span>{fill(s.context, {
              page: current?.title ?? pageLabel(page),
              revision: revId ?? '',
              letter: lead?.letter ?? s.noLead,
              n: detail.approved.n,
              m: detail.approved.m,
            })}</span>
          <span class="id" title={detail.package.hash}>{hash12}</span>
          <button type="button" class="btn quiet copy" onclick={copyHash}>{copied ? s.copied : s.copyHash}</button>
        </p>
        <p class="small muted">{s.fromApp}</p>
      </div>
      <div class="row">
        <div class="field">
          <label for="revpick">{s.revision}</label>
          <select id="revpick" class="input" value={revId} onchange={(e) => navigate(`/p/${id}/review/${e.currentTarget.value}`)}>
            {#each revisions as r (r.id)}
              <option value={r.id}>{r.id}{r.approved ? ` · ${s.revisionApproved}` : ''}</option>
            {/each}
          </select>
        </div>
      </div>
    </div>

    <div class="split">
      <section class="canvas" aria-label={s.canvas}>
        <div class="bar">
          <div class="row">
            <div class="field">
              <label for="pagepick">{s.page}</label>
              <select id="pagepick" class="input" bind:value={page}>
                {#each shell?.pages ?? [] as p (p)}
                  <option value={p}>{pageLabel(p)}</option>
                {/each}
              </select>
            </div>
            <div class="seg" role="group" aria-label={s.device}>
              <button type="button" aria-pressed={device === 'desktop'} onclick={() => (device = 'desktop')}><Icon name="desktop" small /> {s.desktop}</button>
              <button type="button" aria-pressed={device === 'tablet'} onclick={() => (device = 'tablet')}><Icon name="tablet" small /> {s.tablet}</button>
              <button type="button" aria-pressed={device === 'mobile'} onclick={() => (device = 'mobile')}><Icon name="mobile" small /> {s.mobile}</button>
            </div>
          </div>
          <button type="button" class="tool" aria-pressed={labelsOn} onclick={() => (labelsOn = !labelsOn)}>{labelsOn ? s.hideLabels : s.showLabels}</button>
        </div>
        <div class="mat">
          {#if previewFailed}
            <p role="alert" class="msg">{s.canvasFailed} <button type="button" class="btn quiet" onclick={() => revId && fetchLink(revId)}>{s.reload}</button></p>
          {:else if !src}
            <p class="small muted">{s.canvasLoading}</p>
          {:else}
            <div class="stage" style="width: {WIDTHS[device]}px">
              <iframe
                bind:this={frame}
                {src}
                title={fill(s.frameTitle, { page: pageLabel(page), revision: revId ?? '' })}
                style="height: {frameHeight}px"
                referrerpolicy="no-referrer"
              ></iframe>
              {#if labelsOn}
                <div class="overlay">
                  {#each boxes as b (b.id)}
                    <div class="rect" class:sel={selected === b.id} style="left: {b.x}px; top: {b.y}px; width: {b.w}px; height: {b.h}px"></div>
                    <button
                      type="button"
                      class="slabel"
                      class:sel={selected === b.id}
                      aria-pressed={selected === b.id}
                      style="left: {b.x + 8}px; top: {b.y + 8}px"
                      onclick={() => select(b.id)}
                      >{nameOf(b.id)}<span class="sr"> · {fill(s.labelOf, { name: nameOf(b.id) })}</span></button
                    >
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
        <p class="small muted">{s.caption}</p>
      </section>

      <aside class="panel" aria-label={s.panel}>
        {#if detail.approval}
          <section class="card ink" role="status" aria-label={s.approvalDone}>
            <div class="card-b">
              <span class="h3s"><Icon name="check" /> {s.approvalDone}</span>
              <span class="small">{fill(s.approvalBy, { by: detail.approval.by, at: when(detail.approval.at) })}</span>
              <span class="small">{s.packageLabel} <span class="id" data-testid="approved-hash">{detail.approval.packageHash.slice(0, 12)}</span></span>
            </div>
          </section>
        {/if}

        {#if !lead}
          <p class="small muted">{s.noLeadNote}</p>
        {:else}
          <h2 class="label">{s.checklist}</h2>
          <ul class="olist">
            {#each lead.sections as x (x.id)}
              {@const v = view(x)}
              {@const n = ITEMS.filter((i) => v.checklist[i]).length}
              <li>
                <button type="button" class="orow" aria-pressed={selected === x.id} onclick={() => select(selected === x.id ? null : x.id)}>
                  <b>{x.name}</b>
                  {#if v.approved}<span class="chip ok"><Icon name="lock" small />{s.statusApproved}</span>
                  {:else}<span class="chip">{n}/7</span>{/if}
                </button>
              </li>
            {/each}
          </ul>

          {#if sel}
            {@const v = view(sel)}
            <div class="card">
              <div class="card-h"><h3 class="h3s">{sel.name}</h3><span class="id">{sel.id}</span></div>
              <div class="card-b">
                <fieldset class="checks">
                  <legend class="label">{s.checklist}</legend>
                  {#each ITEMS as item (item)}
                    {@const hint = suggestions[sel.id]?.find((g) => g.item === item)}
                    <div class="chkrow">
                      <label class="chk">
                        <input
                          type="checkbox"
                          checked={v.checklist[item]}
                          disabled={!!v.approved}
                          onchange={(e) => tick(item, e.currentTarget.checked, e.currentTarget)}
                        />
                        <span>{s.checks[item]}</span>
                      </label>
                      {#if hint}
                        <p class="small hint"><span class="chip ai">{s.suggestedBy}</span> {fill(s.looksReady, { reason: hint.reason })}</p>
                      {/if}
                    </div>
                  {/each}
                </fieldset>
                <p class="small muted">{s.checklistNote}</p>
                {#if v.approved}<p class="small"><Icon name="lock" small /> {fill(s.approvedBy, { by: v.approved.by })}. {s.locked}</p>{/if}
                {#if checkMsg}<p class="msg" role="alert">{checkMsg}</p>{/if}
                {#if touched}<p class="small muted" role="status">{s.savedNote}</p>{/if}
                <div class="stack" style="gap: 6px">
                  <button type="button" class="btn" disabled={suggesting} onclick={suggest}>{suggesting ? s.suggesting : s.suggest}</button>
                  <p class="small muted">{s.suggestNote}</p>
                  {#if suggestMsg}<p class="small" role="status">{suggestMsg}</p>{/if}
                </div>
              </div>
              <div class="card-f">
                <span class="note">{s.reviseNote}</span>
                <a class="btn" href="/p/{id}/design/{lead.artboard}" use:link>{s.revise}</a>
                {#if v.approved}
                  <button type="button" class="btn" onclick={() => sectionAction('unlock')}>{s.unlockSection}</button>
                {:else}
                  <button type="button" class="btn" onclick={() => sectionAction('approve')}>{s.approveSection}</button>
                {/if}
              </div>
            </div>
          {:else}
            <p class="small muted">{s.nothingSelected}</p>
          {/if}
        {/if}

        <section class="card" aria-labelledby="fnd-h">
          <div class="card-h"><Icon name="warn" /><h2 id="fnd-h" class="h3s">{s.findings}</h2></div>
          <div class="card-b">
            <p class="small muted">{s.findingsNote}</p>
            {#if findings === null}
              <p class="small muted">{s.findingsWaiting}</p>
            {:else if findings.length === 0}
              <p class="small muted">{s.noFindings}</p>
            {/if}
            {#each findings ?? [] as f (f.rule + f.targets.join('|'))}
              {@const key = f.rule + f.targets.join('|')}
              {@const done = isAccepted(f)}
              <div class="finding">
                <span class="row small"><span class="chip warn">{f.impact ?? s.impact}</span><span class="id">{f.rule}</span></span>
                <p class="small">{f.help}</p>
                {#if f.targets.length}<p class="small muted mono">{f.targets.join(' · ')}</p>{/if}
                {#if done}
                  {@const a = detail.acceptances.find((x) => x.rule === f.rule)}
                  {#if a}<p class="small">{fill(s.acceptedBy, { by: a.by, reason: a.reason })}</p>{/if}
                {:else}
                  <div class="field">
                    <label for="r-{key}">{s.reason}</label>
                    <input id="r-{key}" class="input" placeholder={s.reasonPh} bind:value={reasons[key]} />
                  </div>
                  {#if findingMsg?.key === key}<p class="msg" role="alert">{findingMsg.text}</p>{/if}
                  <div class="row" style="justify-content: flex-end">
                    <button type="button" class="btn" disabled={(reasons[key] ?? '').trim().length < 3} onclick={() => accept(f)}>{s.acceptFinding}</button>
                  </div>
                {/if}
              </div>
            {/each}
            {#if detail.acceptances.length && (findings ?? []).length === 0}
              <h3 class="label">{s.acceptedHead}</h3>
              {#each detail.acceptances as a (a.id)}
                <p class="small"><span class="id">{a.rule}</span> {fill(s.acceptedBy, { by: a.by, reason: a.reason })}</p>
              {/each}
            {/if}
          </div>
        </section>
      </aside>
    </div>
  {/if}
</main>

{#if detail}
  <DecisionBar did={s.decideDid}>
    <span class="conseq">
      {#if detail.approval}
        {fill(s.approvalBy, { by: detail.approval.by, at: when(detail.approval.at) })} · {fill(s.consReady, { hash: detail.approval.packageHash.slice(0, 12) })}
      {:else if !detail.ready}
        {fill(s.consBlocked, { n: left })}
      {:else if !detail.canApprove}
        {s.consNotAllowed}
      {:else}
        {fill(s.consReady, { hash: hash12 })}
      {/if}
    </span>
    {#if approveMsg}<span class="conseq" role="alert">{approveMsg}</span>{/if}
    <button type="button" class="btn primary" disabled={!detail.canApprove || !!detail.approval || approving} onclick={approveRevision}>{approving ? s.approving : s.approveRevision}</button>
  </DecisionBar>
{/if}

<style>
.review { max-width: 1680px; }
.ctx { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.copy { min-height: 32px; }
.split { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.canvas { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.panel { flex: 1 1 340px; max-width: 420px; display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; justify-content: space-between; }
.mat { background: var(--mat); padding: 24px; overflow: auto; max-height: 72vh; }
.stage { position: relative; background: #fff; margin: 0 auto; flex: none; }
.stage iframe { display: block; width: 100%; border: 0; background: #fff; }
.overlay { position: absolute; inset: 0; pointer-events: none; }
.rect { position: absolute; border: 1px dashed var(--quiet); box-sizing: border-box; }
.rect.sel { border: 2px solid var(--ink); }
.slabel { position: absolute; pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 8px; background: var(--ink); color: var(--sheet); border: 1px solid var(--sheet); font-family: var(--font-mono); font-size: 11.5px; cursor: pointer; max-width: 60%; }
.slabel.sel { outline: 2px solid var(--signal); outline-offset: 1px; }
.olist { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--ink); }
.orow { width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: none; border: 0; border-bottom: 1px solid var(--rule); text-align: left; cursor: pointer; }
.orow[aria-pressed="true"] { background: var(--sheet); outline: 1px solid var(--ink); outline-offset: -1px; }
.orow b { font-size: 14px; font-weight: 600; }
.checks { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; }
.chkrow { border-bottom: 1px solid var(--rule); }
.chk { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 14px; cursor: pointer; }
.chk input { width: 18px; height: 18px; accent-color: var(--ink); }
.hint { padding: 0 0 8px 28px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip.ai { border-style: dashed; }
.finding { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--rule); }
.h3s { font-size: 16px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
select.input { min-width: 200px; }
</style>
