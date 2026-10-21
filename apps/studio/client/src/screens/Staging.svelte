<script lang="ts">
// Staging (plan §13.2, §13.3; design/prototype/Staging.dc.html; M6.8). The staged revision is the
// package that passed the hard checks, served on the preview site (rule 4: it is another origin
// and can't press anything in this app). The hash, the check summary and the requests all come
// from the app's own data. A note to the Admins is plain text and is only ever shown as text.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { cfill, cs } from '../lib/checks-strings.ts'
import { link } from '../lib/router.svelte.ts'

let { id }: { id: string } = $props()

type Staged = { rev: string; hash: string; at: string }
type Req = { id: number; rev: string; hash: string; note: string; at: string; status: string; by: string }
type CheckRow = { id: string; floor: boolean; level: string; status: string }
type RunSummary = { id: string; kind: string; status: string; blocked: boolean; hash: string; rev: string }
type StagingBody = {
  staged: Staged | null
  url: string | null
  smoke: (RunSummary & { result: { checks?: CheckRow[] } | null }) | null
  requests: Req[]
  code?: string
}

const s = $derived(cs())

let loaded = $state(false)
let failed = $state(false)
let staged = $state<Staged | null>(null)
let url = $state<string | null>(null)
let noPreview = $state(false)
let smoke = $state<StagingBody['smoke']>(null)
let requests = $state<Req[]>([])
let checks = $state<CheckRow[] | null>(null)
let note = $state('')
let sending = $state(false)
let message = $state<{ text: string; ok: boolean } | null>(null)
let copied = $state(false)

const hash12 = $derived(staged?.hash.slice(0, 12) ?? '')
const floor = $derived((checks ?? []).filter((c) => c.floor))
const floorPassed = $derived(floor.filter((c) => c.status === 'pass').length)
const advisory = $derived((checks ?? []).filter((c) => !c.floor))
const canRequest = $derived(!!staged && note.trim().length > 0 && !sending)
const host = $derived.by(() => {
  try {
    return url ? new URL(url).host : ''
  } catch {
    return ''
  }
})

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
const statusText = (v: string) => s.status[v] ?? v
const nameOf = (c: string) => s.names[c] ?? c

async function load() {
  const r = await api<StagingBody>('GET', `/api/p/${id}/staging`)
  loaded = true
  // 503 still carries the staged package; only the preview address is missing.
  if (!r.ok && r.status !== 503) {
    failed = true
    return
  }
  failed = false
  noPreview = r.status === 503
  staged = r.body.staged ?? null
  url = r.body.url ?? null
  smoke = r.body.smoke ?? null
  requests = r.body.requests ?? []
  checks = null
  if (!staged) return
  const hash = staged.hash
  const runs = await api<{ runs: RunSummary[] }>('GET', `/api/p/${id}/checks/runs`)
  const run = (runs.body.runs ?? []).find(
    (x) => x.kind === 'package' && x.hash === hash && x.status === 'done',
  )
  if (!run) return
  const detail = await api<{ run: { result: { checks?: CheckRow[] } | null } }>(
    'GET',
    `/api/p/${id}/checks/runs/${run.id}`,
  )
  if (staged?.hash === hash) checks = detail.body.run?.result?.checks ?? []
}

$effect(() => {
  id
  load()
})

// The signed staging link is short-lived; fetch a fresh one now and then.
$effect(() => {
  const timer = setInterval(async () => {
    const r = await api<StagingBody>('GET', `/api/p/${id}/staging`)
    if (r.ok && r.body.url) url = r.body.url
  }, 12 * 60 * 1000)
  return () => clearInterval(timer)
})

async function copyHash() {
  if (!staged) return
  try {
    await navigator.clipboard.writeText(staged.hash)
    copied = true
    setTimeout(() => (copied = false), 2000)
  } catch {
    copied = false
  }
}

async function request() {
  if (!canRequest) return
  sending = true
  message = null
  const r = await api<{ requests?: Req[] }>('POST', `/api/p/${id}/staging/request`, { note: note.trim() })
  sending = false
  if (!r.ok) {
    message = { text: s.stErr, ok: false }
    return
  }
  requests = r.body.requests ?? requests
  note = ''
  message = { text: s.stReqSent, ok: true }
}
</script>

<main class="main">
  {#if failed}
    <p role="alert">{s.stLoadError}</p>
  {:else if loaded && !staged}
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{s.stHeading}</h1>
        <p class="muted">{s.stSub}</p>
      </div>
    </div>
    <section class="card" style="max-width: 640px" aria-labelledby="empty-h">
      <div class="card-b">
        <h2 id="empty-h" class="h2s">{s.stEmptyTitle}</h2>
        <p class="small muted">{s.stEmptyText}</p>
      </div>
      <div class="card-f">
        <a class="btn" href="/p/{id}/review" use:link>{s.stOpenReview}</a>
      </div>
    </section>
    {#if requests.length}{@render requestList()}{/if}
  {:else if staged}
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{s.stHeading}</h1>
        <p class="muted">{s.stSub}</p>
        <p class="row small onstaging">
          <span class="label">{s.stOnStaging}</span>
          <span class="id" data-testid="staged-rev">{staged.rev}</span>
          <span class="id" title={staged.hash} data-testid="staged-hash">{hash12}</span>
          <button type="button" class="btn quiet copy" onclick={copyHash}>{copied ? s.copied : s.copyHash}</button>
          <span class="muted">· {cfill(s.stStagedAt, { at: when(staged.at) })}</span>
        </p>
      </div>
    </div>

    <section class="stack" style="gap: 12px" aria-label={s.stHeading}>
      <div class="mat">
        <div class="frame rise">
          <div class="frame-bar">
            <Icon name="desktop" small />
            <span class="addr">{cfill(s.stFrameAddr, { hash: hash12 })}{host ? ` · ${host}` : ''}</span>
            <span>{s.stFrameBar}</span>
          </div>
          {#if url}
            <iframe
              src={url}
              title={cfill(s.stFrameTitle, { revision: staged.rev })}
              referrerpolicy="no-referrer"
              sandbox="allow-same-origin"
            ></iframe>
          {:else if noPreview}
            <p class="small muted" style="padding: 24px">{s.stNoPreview}</p>
          {/if}
        </div>
      </div>
      <div class="caption">
        <span class="row" style="gap: 10px"
          ><i class="serif">{staged.rev}</i><span>· {cfill(s.stCaption, { hash: hash12 })}</span></span
        >
        <span class="row">
          <span class="small muted">{s.stFound}</span>
          <a class="btn" href="/p/{id}/design" use:link>{s.stOpenEditor}</a>
        </span>
      </div>
    </section>

    <div class="cols3">
      <section class="walllabel" aria-labelledby="chk-h">
        <h2 id="chk-h" class="label">{s.stChecks}</h2>
        {#if !checks}
          <p class="small muted">{s.stChecksNone}</p>
        {:else}
          <div class="row small">
            <Icon name="lock" small />
            <b>{floorPassed === floor.length ? s.stFloorOk : s.stFloorBad}</b>
            <span class="muted">· {cfill(s.stFloorOf, { n: floorPassed, m: floor.length })}</span>
          </div>
          <p class="small muted">{s.stFloorNote}</p>
          <div class="kv" data-testid="floor-checks">
            {#each floor as c (c.id)}
              <span class="row" style="gap: 6px"><Icon name="lock" small />{nameOf(c.id)}</span><span>{statusText(c.status)}</span>
            {/each}
          </div>
          {#if advisory.length}
            <span class="label" style="margin-top: 6px">{s.stAdvisory}</span>
            <div class="kv" data-testid="advisory-checks">
              {#each advisory as c (c.id)}
                <span>{nameOf(c.id)}</span><span>{s.level[c.level] ?? c.level} · {statusText(c.status)}</span>
              {/each}
            </div>
          {/if}
        {/if}
        <span class="label" style="margin-top: 6px">{s.stSmoke}</span>
        <p class="small" data-testid="smoke">
          {#if !smoke}{s.stSmokeNone}
          {:else if smoke.status !== 'done'}{statusText(smoke.status)}
          {:else}{statusText(smoke.result?.checks?.[0]?.status ?? (smoke.blocked ? 'fail' : 'pass'))}{/if}
        </p>
      </section>

      <section class="card ink" aria-labelledby="req-h">
        <div class="card-b">
          <span class="label" style="color: var(--signal-ink)">{s.stRequestKicker}</span>
          <h2 id="req-h" class="h2s">{s.stRequest}</h2>
          <p class="small muted">{cfill(s.stRequestText, { revision: staged.rev })}</p>
          <div class="field">
            <label for="note">{s.stNote}</label>
            <textarea id="note" class="input" bind:value={note} placeholder={s.stNotePlaceholder} maxlength="2000"></textarea>
            <span class="small muted">{s.stNoteHelp}</span>
          </div>
          {#if message}<p class="msg" class:ok={message.ok} role={message.ok ? 'status' : 'alert'}>{message.text}</p>{/if}
        </div>
        <div class="card-f"><span class="note">{s.stRequestNote}</span></div>
      </section>

      {@render requestList()}
    </div>
  {/if}
</main>

{#if loaded && !failed}
  <DecisionBar did={s.stDid}>
    <span class="conseq">
      {#if !staged}{s.stConseqNone}{:else if !note.trim()}{s.stConseqNote}{:else}{s.stConseq}{/if}
    </span>
    <a class="btn" href="/p/{id}" use:link>{s.stNotYet}</a>
    <button type="button" class="btn primary" disabled={!canRequest} onclick={request}>{sending ? s.stSending : s.stRequest}</button>
  </DecisionBar>
{/if}

{#snippet requestList()}
  <section class="walllabel" aria-labelledby="reqs-h">
    <h2 id="reqs-h" class="label">{s.stRequests}</h2>
    {#if !requests.length}
      <p class="small muted">{s.stRequestsNone}</p>
    {:else}
      <ul class="reqs" data-testid="requests">
        {#each requests as r (r.id)}
          <li class="req" data-status={r.status}>
            <span class="row" style="gap: 8px">
              <span class="chip" class:sig={r.status === 'open'}>{r.status === 'open' ? s.stReqOpen : s.stReqSuperseded}</span>
              <span class="id">{r.rev}</span>
              <span class="small muted">{cfill(s.stReqBy, { by: r.by, at: when(r.at) })}</span>
            </span>
            <p class="notetext small">{r.note}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

<style>
.onstaging { gap: 8px; border: 1px dashed var(--ink); padding: 8px 12px; align-self: flex-start; }
.copy { min-height: 32px; }
.mat { background: var(--mat); padding: 48px; display: flex; justify-content: center; }
.frame { width: 100%; max-width: 1180px; background: #fff; border: 1px solid var(--ink); }
.frame-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid var(--rule-strong); background: var(--sheet); font-family: var(--font-mono); font-size: 11.5px; color: var(--caption); }
.frame-bar .addr { color: var(--ink); flex: 1 1 240px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frame iframe { display: block; width: 100%; height: 70vh; min-height: 480px; border: 0; background: #fff; }
.caption { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; font-size: 13.5px; color: var(--caption); }
.caption i.serif { font-size: 18px; color: var(--ink); }
.kv { display: grid; grid-template-columns: minmax(0, 1fr) auto; border-top: 1px solid var(--rule); }
.kv > span { padding: 8px 0; border-bottom: 1px solid var(--rule); font-size: 13px; }
.kv > span:nth-child(2n) { text-align: right; font-family: var(--font-mono); font-size: 11.5px; padding-left: 12px; }
.reqs { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
.req { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--rule); }
.notetext { background: var(--fill); padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
.msg.ok { background: var(--sheet); border-color: var(--ink); color: var(--ink); }
@media (max-width: 720px) { .mat { padding: 12px; } }
</style>
