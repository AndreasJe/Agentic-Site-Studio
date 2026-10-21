<script lang="ts">
// Failure analysis (plan §13.5; design/prototype/AdminFailure.dc.html; M6.8). Admin only. The
// analyst only sorts and drafts: its issues, evidence and patch are data shown here as text, never
// as HTML. A person sends the fix (a take on one section, saved as a revision by a person and
// reviewed again) or holds the run with a comment. There is no let-through here: a security-floor
// failure can only be fixed, and the server refuses it too.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import TopBar from '../components/TopBar.svelte'
import { api } from '../lib/api.ts'
import { cfill, cs } from '../lib/checks-strings.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

let { run }: { run: string | null } = $props()

type Issue = { check: string; cause: string; severity: string; confidence: string; evidence: string[] }
type Patch = { artboardId: number; sectionId: string; html: string; css: string }
type Analysis = {
  id: string | number
  status: string
  recommendation: string
  issues: Issue[]
  patch: Patch | null
  attempt: number
  note?: string
  takeId?: string | number | null
}
type Finding = { message?: string; file?: string; rule?: string }
type CheckResult = { id: string; floor?: boolean; level?: string; status: string; findings?: Finding[] }
type Detail = {
  run: { id: string; project: string; rev: string; hash: string; result: { checks?: CheckResult[] } | null }
  analysis: Analysis | null
  floorFailed: boolean
}
type ListItem = { id: string; project: string; rev: string; at: string }

const s = $derived(cs())
const isAdmin = $derived(session.user?.role === 'admin')

let loaded = $state(false)
let loadState = $state<'ok' | 'missing' | 'failed'>('ok')
let detail = $state<Detail | null>(null)
let list = $state<ListItem[]>([])
let pick = $state<'fix' | 'hold'>('fix')
let comment = $state('')
let busy = $state(false)
let error = $state('')

const analysis = $derived(detail?.analysis ?? null)
const failedChecks = $derived((detail?.run.result?.checks ?? []).filter((c) => c.status === 'fail'))
const nameOf = (id: string) => s.names[id] ?? id
const sent = $derived(!!analysis && (analysis.takeId != null || analysis.status === 'sent'))
const held = $derived(!!analysis && analysis.status === 'held')
const decided = $derived(sent || held)
const canFix = $derived(!!analysis?.patch)
const holdEmpty = $derived(pick === 'hold' && !comment.trim())
const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function load() {
  error = ''
  if (run === null) {
    const r = await api<Record<string, unknown>>('GET', '/api/admin/failures')
    loaded = true
    if (!r.ok) {
      loadState = 'failed'
      return
    }
    const rows = (r.body.failures ?? r.body.runs ?? []) as Record<string, unknown>[]
    list = rows.map((x) => ({
      id: String(x.runId ?? x.id),
      project: String(x.project ?? ''),
      rev: String(x.rev ?? ''),
      at: String(x.at ?? ''),
    }))
    loadState = 'ok'
    return
  }
  const r = await api<Detail>('GET', `/api/admin/failures/${run}`)
  loaded = true
  if (r.status === 404) {
    loadState = 'missing'
    return
  }
  if (!r.ok) {
    loadState = 'failed'
    return
  }
  loadState = 'ok'
  detail = r.body
  if (!r.body.analysis?.patch) pick = 'hold'
}

$effect(() => {
  run
  detail = null
  if (isAdmin) load()
  else loaded = true
})

async function analyse() {
  if (busy || run === null) return
  busy = true
  error = ''
  const r = await api('POST', `/api/admin/failures/${run}/analyse`)
  busy = false
  if (!r.ok) {
    error = s.afAnalyseErr
    return
  }
  await load()
}

async function decide() {
  if (busy || run === null || decided || !analysis) return
  busy = true
  error = ''
  const r =
    pick === 'fix'
      ? await api('POST', `/api/admin/failures/${run}/send-fix`)
      : await api('POST', `/api/admin/failures/${run}/hold`, { comment: comment.trim() })
  busy = false
  if (!r.ok) {
    error = s.afErr
    return
  }
  await load()
}

const primaryLabel = $derived(
  busy ? s.afSending : !analysis ? s.afAnalyse : pick === 'fix' ? s.afSendFix : s.afHold,
)
const primaryDisabled = $derived(busy || decided || (!!analysis && (pick === 'fix' ? !canFix : holdEmpty)))
const conseq = $derived(
  !analysis
    ? s.afNoAnalysis
    : decided
      ? sent
        ? s.afDoneSentT
        : s.afDoneHeldT
      : pick === 'fix'
        ? s.afSendFixT
        : holdEmpty
          ? s.afConseqHoldEmpty
          : s.afConseqHold,
)
</script>

<div class="app">
  <TopBar />
  <main class="main">
    {#if loaded && !isAdmin}
      <p role="alert">{s.afForbidden}</p>
    {:else if loaded && loadState === 'failed'}
      <p role="alert">{s.afLoadError}</p>
    {:else if loaded && loadState === 'missing'}
      <p role="alert">{s.afNotFound}</p>
      <a class="btn" style="align-self: flex-start" href="/admin/failures" use:link>{s.acNavFailures}</a>
    {:else if loaded && run === null}
      <div class="pagehead">
        <div class="stack" style="gap: 6px">
          <span class="label">{s.acKicker}</span>
          <h1>{s.afListHeading}</h1>
          <p class="muted">{s.afListSub}</p>
        </div>
      </div>
      {#if !list.length}
        <p class="muted">{s.afListNone}</p>
      {:else}
        <ul class="flist" data-testid="failures">
          {#each list as f (f.id)}
            <li class="row" style="gap: 10px">
              <span class="id">{f.rev}</span>
              <span class="small muted">{f.project}{f.at ? ` · ${when(f.at)}` : ''}</span>
              <a class="btn quiet" href="/admin/failures/{f.id}" use:link>{s.afListOpen}</a>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if loaded && detail}
      <div class="pagehead">
        <div class="stack" style="gap: 6px">
          <span class="label">{analysis ? s.afKickerReady : s.afKickerNone}</span>
          <h1>{cfill(s.afHeading, { revision: detail.run.rev })}</h1>
          <p class="muted">{cfill(s.afSub, { project: detail.run.project, run: detail.run.id.slice(0, 8), hash: detail.run.hash.slice(0, 12) })}</p>
        </div>
        <span class="row">
          <span class="chip sig">{failedChecks.length === 1 ? s.afFailedOne : cfill(s.afFailedN, { n: failedChecks.length })}</span>
        </span>
      </div>

      {#if detail.floorFailed}
        <section class="card ink" aria-labelledby="floor-h" data-testid="floor-failed">
          <div class="card-b">
            <h2 id="floor-h" class="row h3"><Icon name="lock" />{s.afFloorTitle}</h2>
            <p class="small">{s.afFloorText}</p>
          </div>
        </section>
      {/if}

      {#if analysis}
        <section class="card ink" aria-labelledby="sum-h">
          <div class="card-h">
            <svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>
            <h2 id="sum-h" class="small"><b>{s.afSummary}</b></h2>
          </div>
          <div class="card-b" style="gap: 14px">
            {#if analysis.note}<p class="muted notetext">{analysis.note}</p>{/if}
            <div class="facts">
              <div>
                <span class="label">{s.afRec}</span>
                <span class="chip ai" style="align-self: flex-start">{s.afRecs[analysis.recommendation] ?? analysis.recommendation}</span>
              </div>
              <div><span class="label">{s.afAttempt}</span><span class="mono">{analysis.attempt}</span></div>
              <div>
                <span class="label">{s.afScope}</span>
                {#if analysis.patch}<span><span class="id">{analysis.patch.sectionId}</span> · {analysis.patch.artboardId}</span>
                {:else}<span class="muted">{s.afNoPatch}</span>{/if}
              </div>
            </div>
          </div>
        </section>
      {/if}

      <section class="stack" style="gap: 0" aria-labelledby="what-h">
        <div class="group-h"><h2 id="what-h" class="h2s">{s.afWhat}</h2><span class="small muted">{s.afWhatSub}</span></div>
        {#each failedChecks as c, i (c.id)}
          <div class="issue" data-testid="failed-{c.id}">
            <div class="stack" style="gap: 8px">
              <span class="row" style="gap: 8px"><span class="mono small muted">{i + 1}</span><b class="iname">{nameOf(c.id)}</b></span>
              {#if c.findings?.length}
                <p class="ev">{c.findings.map((f) => [f.rule, f.file, f.message].filter(Boolean).join(' · ')).join('\n')}</p>
              {:else}
                <p class="small muted">{s.afNoFinding}</p>
              {/if}
            </div>
            <div class="stack" style="gap: 6px; align-content: start">
              <span class="row" style="gap: 6px">
                {#if c.floor}<span class="chip"><Icon name="lock" small />{s.afFloorChip}</span>{/if}
                {#if c.level}<span class="chip">{s.level[c.level] ?? c.level}</span>{/if}
              </span>
            </div>
          </div>
        {/each}
      </section>

      {#if analysis}
        <section class="stack" style="gap: 0" aria-labelledby="iss-h">
          <div class="group-h"><h2 id="iss-h" class="h2s">{s.afIssues}</h2><span class="small muted">{s.afIssuesSub}</span></div>
          {#each analysis.issues as issue, i (i)}
            <div class="issue" data-testid="issue-{i}">
              <div class="stack" style="gap: 8px">
                <span class="row" style="gap: 8px"><span class="mono small muted">{i + 1}</span><b class="iname">{nameOf(issue.check)}</b></span>
                <p class="small">{issue.cause}</p>
                <span class="label">{s.afEvidence}</span>
                <p class="ev">{issue.evidence.join('\n')}</p>
              </div>
              <div class="stack" style="gap: 6px; align-content: start">
                <span class="row" style="gap: 6px">
                  <span class="chip">{cfill(s.afSeverity, { v: issue.severity })}</span>
                  <span class="chip">{cfill(s.afConfidence, { v: issue.confidence })}</span>
                </span>
              </div>
            </div>
          {/each}
        </section>

        {#if analysis.patch}
          <section class="stack" style="gap: 12px" aria-labelledby="fix-h">
            <div class="group-h">
              <h2 id="fix-h" class="h2s">{s.afPatch}</h2>
              <span class="chip ai"><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{s.afPatchChip}</span>
            </div>
            <div class="diff" role="region" aria-label={cfill(s.afPatchRegion, { section: analysis.patch.sectionId })} tabindex="0" data-testid="patch">
              <span class="ctx">{analysis.patch.sectionId} · {analysis.patch.artboardId}</span>
              <span class="add">{analysis.patch.html}</span>
              {#if analysis.patch.css}
                <span class="ctx">{s.afPatchCss}</span>
                <span class="add">{analysis.patch.css}</span>
              {/if}
            </div>
            <p class="small muted" style="max-width: 820px">{s.afPatchNote}</p>
          </section>
        {/if}

        <section class="stack" style="gap: 12px" aria-labelledby="dec-h">
          <div class="group-h"><h2 id="dec-h" class="h2s">{s.afDecision}</h2></div>
          {#if decided}
            <div class="card ink rise" role="status">
              <div class="card-b" style="flex-direction: row; align-items: center; gap: 16px; flex-wrap: wrap">
                <svg class="seal" viewBox="0 0 56 56" role="img" aria-label={sent ? s.afDoneSent : s.afDoneHeld}><use href="/icons.svg#seal" /></svg>
                <span class="stack" style="gap: 2px; flex: 1 1 320px">
                  <b>{sent ? s.afDoneSent : s.afDoneHeld}</b>
                  <span class="small muted">{sent ? s.afDoneSentT : s.afDoneHeldT}</span>
                </span>
              </div>
            </div>
          {:else}
            <div class="stack" style="gap: 8px" role="radiogroup" aria-label={s.afOptionsAria}>
              <button type="button" class="opt" class:sel={pick === 'fix'} role="radio" aria-checked={pick === 'fix'} disabled={!canFix} onclick={() => (pick = 'fix')}>
                <span class="dotr"></span>
                <span class="stack" style="gap: 2px"><b>{s.afSendFix}</b><span class="small muted">{canFix ? s.afSendFixT : s.afNoFixT}</span></span>
              </button>
              <button type="button" class="opt" class:sel={pick === 'hold'} role="radio" aria-checked={pick === 'hold'} onclick={() => (pick = 'hold')}>
                <span class="dotr"></span>
                <span class="stack" style="gap: 2px"><b>{s.afHold}</b><span class="small muted">{s.afHoldT}</span></span>
              </button>
            </div>
            {#if pick === 'hold'}
              <div class="field rise" style="max-width: 720px">
                <label for="holdc">{s.afHoldLabel}</label>
                <textarea class="input" id="holdc" bind:value={comment} placeholder={s.afHoldPlaceholder} maxlength="2000"></textarea>
              </div>
            {/if}
          {/if}
        </section>
      {:else}
        <p class="muted" data-testid="no-analysis">{s.afNoAnalysis}</p>
      {/if}
      {#if error}<p class="msg" role="alert">{error}</p>{/if}
    {/if}
  </main>

  {#if loaded && isAdmin && loadState === 'ok' && (run === null || detail)}
    <DecisionBar did={detail && analysis ? s.afDid : s.afDidNone}>
      {#if detail}
        <span class="conseq">{conseq}</span>
        <a class="btn" href="/admin/checks" use:link>{s.afBack}</a>
        {#if !decided}
          <button type="button" class="btn primary" disabled={primaryDisabled} onclick={analysis ? decide : analyse}>{primaryLabel}</button>
        {/if}
      {:else}
        <a class="btn" href="/admin/checks" use:link>{s.afBack}</a>
      {/if}
    </DecisionBar>
  {/if}
</div>

<style>
.flist { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
.flist li { padding: 10px 0; border-bottom: 1px solid var(--rule); }
.h3 { font-size: 18px; font-weight: 600; gap: 8px; }
.group-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; border-top: 1px solid var(--ink); padding-top: 12px; }
.issue { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr); gap: 12px 28px; padding: 18px 0; border-bottom: 1px solid var(--rule); }
.iname { font-size: 16px; font-weight: 600; }
.notetext { white-space: pre-wrap; max-width: 820px; }
.ev { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; background: var(--wall); border: 1px solid var(--rule); padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7; border: 1px solid var(--rule); background: #fff; padding: 10px 0; overflow-x: auto; max-height: 420px; overflow-y: auto; }
.diff span { display: block; padding: 0 12px; white-space: pre; }
.diff .add { background: #e4efea; color: #1f4a40; }
.diff .ctx { color: var(--caption); }
.opt { display: flex; gap: 12px; align-items: flex-start; text-align: left; width: 100%; min-height: 44px; padding: 14px 16px; border: 1px solid var(--rule-strong); background: var(--sheet); cursor: pointer; transition: border-color var(--t-ui), background var(--t-ui); }
.opt:hover:not(:disabled) { border-color: var(--ink); }
.opt.sel { border-color: var(--ink); background: #fff; box-shadow: inset 0 0 0 1px var(--ink); }
.opt:disabled { cursor: not-allowed; background: var(--fill); color: var(--caption); }
.dotr { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--ink); flex: none; margin-top: 2px; display: grid; place-items: center; }
.opt.sel .dotr::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--ink); }
.seal { width: 56px; height: 56px; color: var(--ink); transform: rotate(-8deg); flex: none; }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
@media (max-width: 900px) { .issue { grid-template-columns: 1fr; } }
</style>
