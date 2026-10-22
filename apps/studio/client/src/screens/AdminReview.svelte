<script lang="ts">
// The Admin's review page for a publication request (plan §13.3 steps 6 and 7;
// design/prototype/AdminReview.dc.html; M7.8). Admin only. It shows the package hash, the
// Creator's note, the check results and the per-page, per-section comparison; every warning is
// acknowledged with a reason; the passkey signs the release challenge (one or two Admins), and
// the Admin can send the request back with a comment. Only the passkey approves: opening this
// page, from the inbox or from an email, grants nothing.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { cs } from '../lib/checks-strings.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'
import { type SignOptions, type SigningView, signAndSend, when } from '../lib/signing.ts'

let { id }: { id: number } = $props()

type Finding = { message: string; file?: string; rule?: string }
type Review = {
  request: {
    id: number
    project: string
    rev: string
    hash: string
    note: string
    by: string
    at: string
    status: 'open' | 'superseded' | 'sent-back' | 'published'
    closed: { by: string | null; note: string | null; at: string } | null
  }
  isStaged: boolean
  checks: { floorPassed: boolean; results: { id: string; status: string; floor: boolean }[] }
  visual: {
    status: string
    findings: Finding[]
    pages: {
      page: string
      path: string
      status: string
      findings: Finding[]
      sections: { id: string; name: string }[]
    }[]
  }
  warnings: {
    check: string
    status: string
    findings: Finding[]
    acknowledged: { by: string; reason: string; at: string } | null
  }[]
  policy: { releases: 1 | 2 }
  signing: SigningView | null
  signers: { adminId: string; at: string }[]
  canSign: boolean
  reSign: boolean
}

const s = $derived(ad())
const c = $derived(cs())
const isAdmin = $derived(session.user?.role === 'admin')
const me = $derived(session.user?.handle ?? '')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let missing = $state(false)
let review = $state<Review | null>(null)
let phase = $state<'idle' | 'signing' | 'sendback'>('idle')
let message = $state<{ text: string; ok: boolean } | null>(null)
let comment = $state('')
let drafts = $state<Record<string, { ticked: boolean; reason: string }>>({})
let ackBusy = $state<string | null>(null)
let ackError = $state<Record<string, string>>({})

async function load() {
  const r = await api<Review>('GET', `/api/admin/review/${id}`)
  if (r.status === 404) {
    missing = true
    view = 'ok'
    return
  }
  if (!r.ok) {
    view = 'failed'
    return
  }
  review = r.body
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const req = $derived(review?.request ?? null)
const signing = $derived(review?.signing ?? null)
const needed = $derived(signing?.needed ?? review?.policy.releases ?? 1)
const signedBy = $derived(
  signing && ['open', 'signed', 'sent', 'accepted'].includes(signing.status) ? signing.signers : [],
)
const youSigned = $derived(signedBy.some((x) => x.adminId === me))
const open = $derived(req?.status === 'open')
const waitingDeliver = $derived(open && signing?.status === 'signed')
const inProduction = $derived(!!signing && ['sent', 'accepted'].includes(signing.status))
const canApprove = $derived(
  open && !!review?.canSign && phase === 'idle' && !waitingDeliver && !inProduction && !youSigned,
)
const warnings = $derived(review?.warnings ?? [])
const acked = $derived(warnings.filter((w) => w.acknowledged).length)
const hard = $derived((review?.checks.results ?? []).filter((x) => x.floor))
const advisory = $derived((review?.checks.results ?? []).filter((x) => !x.floor))
const shortHash = $derived(`sha256:${(req?.hash ?? '').slice(0, 12)}…`)
const nameOf = (cid: string) => c.names[cid] ?? cid
const statusOf = (st: string) => s.rvPageStatus[st] ?? st

const draftOf = (check: string) => drafts[check] ?? { ticked: false, reason: '' }
function setDraft(check: string, patch: Partial<{ ticked: boolean; reason: string }>) {
  drafts[check] = { ...draftOf(check), ...patch }
}

async function acknowledge(check: string) {
  const d = draftOf(check)
  if (!d.ticked || !d.reason.trim() || ackBusy) return
  ackBusy = check
  const r = await api<{ code?: string; review?: Review }>(
    'POST',
    `/api/admin/review/${id}/acknowledge`,
    { check, reason: d.reason.trim() },
  )
  ackBusy = null
  if (r.ok) {
    ackError[check] = ''
    await load()
  } else ackError[check] = codeText(r.body.code)
}

async function approve() {
  if (!canApprove) return
  phase = 'signing'
  message = null
  const ch = await api<SignOptions & { code?: string }>('POST', `/api/admin/review/${id}/challenge`, {})
  if (!ch.ok) {
    phase = 'idle'
    message = { text: codeText(ch.body.code), ok: false }
    return
  }
  const done = await signAndSend(ch.body, `/api/admin/review/${id}/sign`)
  phase = 'idle'
  if (!done.ok) message = { text: done.code === 'cancelled' ? codeText('cancelled') : codeText(done.code), ok: false }
  await load()
}

async function deliver() {
  if (!waitingDeliver || phase !== 'idle') return
  phase = 'signing'
  message = null
  const r = await api<{ code?: string }>('POST', `/api/admin/review/${id}/deliver`, {})
  phase = 'idle'
  if (!r.ok) message = { text: codeText(r.body.code), ok: false }
  await load()
}

async function sendBack() {
  if (!comment.trim()) return
  const r = await api<{ code?: string }>('POST', `/api/admin/review/${id}/send-back`, {
    note: comment.trim(),
  })
  if (!r.ok) {
    message = { text: codeText(r.body.code), ok: false }
    return
  }
  phase = 'idle'
  await load()
}

const conseq = $derived.by(() => {
  if (phase === 'signing') return s.rvConseqWaiting
  if (phase === 'sendback') return afill(s.rvConseqSendBack, { by: req?.by ?? '' })
  if (!open) return s.rvConseqDone
  if (waitingDeliver) return s.rvSignedNotSentText
  if (inProduction) return s.rvSentText.replace('{n}', String(signing?.releaseNumber ?? ''))
  if (youSigned) return s.rvConseqHalf
  if (!review?.canSign) return s.rvConseqBlocked
  return needed === 2 ? s.rvConseqTwo : s.rvConseqIdle
})
</script>

<AdminShell
  heading={req ? afill(s.rvTitle, { rev: `${req.project}/${req.rev}` }) : s.rvBack}
  did={s.rvDid}
  state={view}
>
  {#snippet head()}
    {#if req}
      <a class="btn" href="/p/{req.project}/staging" use:link><Icon name="open-external" small />{s.rvOpenStaging}</a>
    {/if}
  {/snippet}

  <a class="small muted back" href="/admin" use:link><Icon name="arrow-left" small />{s.rvBack}</a>

  {#if missing}
    <p role="alert">{s.rvLoadMissing}</p>
  {:else if req && review}
    <p class="row muted" style="gap: 8px">
      <span>{afill(s.rvBy, { by: req.by, at: when(req.at) })}</span>
    </p>
    <p class="row small" style="gap: 8px; border: 1px dashed var(--ink); padding: 8px 12px; align-self: flex-start">
      <span class="label">{s.rvReviewing}</span><span class="id">{req.project}</span><span class="id">{req.rev}</span>
      <span class="mono small muted">{shortHash}</span>
      {#if review.isStaged}<span class="chip">{s.rvStaged}</span>{:else}<span class="chip warn">{s.rvNotStaged}</span>{/if}
    </p>

    {#if !open}
      <div class="banner" role="status">
        <Icon name="lock" small />
        <span>{afill(s.rvClosed, { status: s.rvStatus[req.status] ?? req.status })}</span>
        {#if req.closed?.note}<span class="small muted">{afill(s.rvSentBackText, { by: req.closed.by ?? '', note: req.closed.note })}</span>{/if}
      </div>
    {/if}

    <div class="split">
      <div class="grow stack" style="gap: 28px">
        <section class="stack" style="gap: 8px" aria-labelledby="note-h">
          <h2 id="note-h" class="label">{afill(s.rvNoteH, { by: req.by })}</h2>
          {#if req.note}<p class="note-plain">{req.note}</p>{:else}<p class="muted small">{s.rvNoteNone}</p>{/if}
        </section>

        <section class="stack" style="gap: 14px" aria-labelledby="chg-h">
          <div class="row" style="justify-content: space-between">
            <h2 id="chg-h" class="h2s">{s.rvChangesH}</h2>
            <span class="chip">{s.rvVisual} · {statusOf(review.visual.status)}</span>
          </div>
          <p class="small muted">{s.rvChangesSub}</p>
          {#if review.visual.pages.length === 0}
            <p class="muted small">{s.rvNoPages}</p>
          {/if}
          {#each review.visual.pages as p (p.page)}
            <article class="card" data-testid="review-page">
              <div class="card-h">
                <b>{p.path === '' ? '/' : `/${p.path}`}</b>
                <span class="chip" class:warn={p.status === 'changed'}>{p.status === 'changed' ? s.rvPageChanged : p.status === 'unchanged' ? s.rvPageUnchanged : statusOf(p.status)}</span>
              </div>
              <div class="card-b">
                {#if p.findings.length}
                  <span class="label">{s.rvVisualFindings}</span>
                  <ul class="findings">{#each p.findings as f, i (i)}<li>{f.message}</li>{/each}</ul>
                {/if}
                {#if p.sections.length}
                  <span class="label">{s.rvSections}</span>
                  <div class="row" style="gap: 6px">
                    {#each p.sections as sec (sec.id)}<span class="chip" title={sec.id}>{sec.name}</span>{/each}
                  </div>
                {/if}
              </div>
            </article>
          {/each}
        </section>
      </div>

      <aside class="side stack" style="gap: 24px">
        <section class="walllabel" aria-labelledby="hg-h">
          <div class="row" style="justify-content: space-between">
            <h2 id="hg-h" class="label">{s.rvHardH}</h2>
            {#if hard.length}<span class="chip" class:ok={review.checks.floorPassed} class:sig={!review.checks.floorPassed}>{afill(s.rvHardCount, { n: hard.filter((x) => x.status === 'pass').length, m: hard.length })}</span>{/if}
          </div>
          {#if hard.length === 0}<p class="small muted">{s.rvHardNone}</p>{/if}
          <div class="rows small" style="border-top: 0">
            {#each hard as h (h.id)}
              <div class="r"><Icon name={h.status === 'pass' ? 'check' : 'warn'} small />{nameOf(h.id)}<span class="muted small">· {statusOf(h.status)}</span></div>
            {/each}
          </div>
        </section>

        <section class="walllabel" aria-labelledby="adv-h">
          <h2 id="adv-h" class="label">{s.rvAdvH}</h2>
          <div class="rows small" style="border-top: 0">
            {#each advisory as a (a.id)}
              <div class="r"><span class="chip" class:warn={a.status !== 'pass'}>{statusOf(a.status)}</span><span><b style="font-weight: 600">{nameOf(a.id)}</b></span></div>
            {/each}
          </div>
        </section>

        <section class="stack" style="gap: 10px" aria-labelledby="ack-h">
          <div class="row" style="justify-content: space-between"><h2 id="ack-h" class="label">{s.rvAckH}</h2><span class="mono small">{afill(s.rvAckCount, { n: acked, m: warnings.length })}</span></div>
          {#if warnings.length === 0}<p class="small muted">{s.rvAckNone}</p>{/if}
          {#each warnings as w (w.check)}
            <div class="ack" class:done={!!w.acknowledged} data-testid="warning-{w.check}">
              <b class="small">{afill(s.rvAckCheck, { name: nameOf(w.check), status: statusOf(w.status) })}</b>
              {#if w.findings.length}
                <ul class="findings">{#each w.findings.slice(0, 5) as f, i (i)}<li>{f.message}{f.file ? ` · ${f.file}` : ''}</li>{/each}</ul>
              {/if}
              {#if w.acknowledged}
                <p class="small">{afill(s.rvAckDone, { by: w.acknowledged.by, reason: w.acknowledged.reason })}</p>
              {:else if open}
                <label class="cb"><input type="checkbox" checked={draftOf(w.check).ticked} onchange={(e) => setDraft(w.check, { ticked: e.currentTarget.checked })} /><span class="small">{s.rvAckTick}</span></label>
                <div class="field">
                  <label for="r-{w.check}" class="small">{s.rvAckReason}</label>
                  <input id="r-{w.check}" class="input" value={draftOf(w.check).reason} oninput={(e) => setDraft(w.check, { reason: e.currentTarget.value })} placeholder={s.rvAckPlaceholder} maxlength="500" />
                </div>
                <div class="row">
                  <button type="button" class="btn" disabled={!draftOf(w.check).ticked || !draftOf(w.check).reason.trim() || ackBusy === w.check} onclick={() => acknowledge(w.check)}>{s.rvAckButton}</button>
                  {#if ackError[w.check]}<span class="small" role="alert">{ackError[w.check]}</span>{/if}
                </div>
              {/if}
            </div>
          {/each}
        </section>

        <section class="card ink" aria-labelledby="ap-h">
          <div class="card-h">
            <h2 id="ap-h" style="font-size: 16px">{s.rvDecisionH}</h2>
            <span class="chip" style="margin-left: auto">{needed === 2 ? s.rvRuleTwo : s.rvRuleOne}</span>
          </div>
          <div class="card-b">
            <div class="stack" style="gap: 4px" data-testid="signers">
              <span class="label">{s.rvSignersH} · {afill(s.rvNeeded, { n: signedBy.length, m: needed })}</span>
              {#if signedBy.length === 0}<span class="small muted">{s.rvSignersNone}</span>{/if}
              {#each signedBy as sg (sg.adminId)}
                <span class="small"><Icon name="check" small /> {afill(s.signedAt, { who: sg.adminId, at: when(sg.at) })}</span>
              {/each}
            </div>

            {#if phase === 'signing'}
              <div class="passkey rise" role="status">
                <div class="row" style="gap: 12px"><Icon name="passkey" /><b>{s.waitingPasskey}</b></div>
                <p class="small">{s.touch}</p>
                <p class="mono small muted">{afill(s.rvSigning, { hash: shortHash, rev: req.rev })}</p>
              </div>
            {:else if open && inProduction}
              <div class="passkey" role="status">
                <b>{s.rvSent}</b>
                <p class="small muted">{afill(s.rvSentText, { n: signing?.releaseNumber ?? '' })}</p>
              </div>
            {:else if open && waitingDeliver}
              <div class="passkey" role="status">
                <b>{s.rvSignedNotSent}</b>
                <p class="small muted">{s.rvSignedNotSentText}</p>
              </div>
            {:else if !open && req.status === 'published'}
              <div class="passkey" role="status">
                <div class="row" style="gap: 14px">
                  <svg class="seal" viewBox="0 0 56 56" role="img" aria-label={s.rvLive}><circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2.6" /><circle cx="28" cy="28" r="21" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M19 28.5l6 6 12-13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square" /></svg>
                  <span class="stack" style="gap: 2px"><b>{s.rvLive}</b><span class="small muted">{afill(s.rvLiveText, { n: signing?.releaseNumber ?? '' })}</span></span>
                </div>
              </div>
            {:else if !open && req.status === 'sent-back'}
              <div class="passkey" role="status"><b>{s.rvSentBack}</b><p class="small muted">{afill(s.rvSentBackText, { by: req.closed?.by ?? '', note: req.closed?.note ?? '' })}</p></div>
            {:else if open && youSigned}
              <p class="small">{s.rvYouSigned}</p>
            {:else if open}
              <p class="small muted">{review.canSign ? afill(s.rvIdle, { rev: req.rev }) : s.rvIdleBlocked}</p>
            {/if}

            {#if signing?.status === 'refused'}
              <div class="amsg" role="alert"><b>{s.rvRefused}</b> {afill(s.rvRefusedText, { code: signing.outcome ?? '' })}</div>
            {/if}

            {#if phase === 'sendback'}
              <div class="field rise">
                <label for="cm">{afill(s.rvCommentH, { by: req.by })}</label>
                <textarea id="cm" class="input" bind:value={comment} placeholder={s.rvCommentPlaceholder} maxlength="2000"></textarea>
                <span class="small muted">{s.rvCommentHelp}</span>
              </div>
            {/if}

            {#if message}<p class="amsg" class:okmsg={message.ok} role={message.ok ? 'status' : 'alert'}>{message.text}</p>{/if}
          </div>
        </section>
      </aside>
    </div>
  {/if}

  {#snippet bar()}
    <span class="conseq">{conseq}</span>
    {#if missing || !req}
      <a class="btn primary" href="/admin" use:link>{s.rvBackInbox}</a>
    {:else if phase === 'sendback'}
      <button type="button" class="btn quiet" onclick={() => (phase = 'idle')}>{s.cancel}</button>
      <button type="button" class="btn primary" disabled={!comment.trim()} onclick={sendBack}>{afill(s.rvSendBackTo, { by: req.by })}</button>
    {:else if !open}
      <a class="btn" href="/admin/deployment" use:link>{s.rvOpenDeployment}</a>
      <a class="btn primary" href="/admin" use:link>{s.rvBackInbox}</a>
    {:else}
      <button type="button" class="btn" disabled={phase !== 'idle'} onclick={() => (phase = 'sendback')}><Icon name="send-back" small />{s.rvSendBack}</button>
      {#if waitingDeliver}
        <button type="button" class="btn primary" disabled={phase !== 'idle'} onclick={deliver}>{s.rvDeliver}</button>
      {:else}
        <button type="button" class="btn primary" disabled={!canApprove} onclick={approve}><Icon name="passkey" small />{review?.reSign ? s.rvApproveAgain : s.rvApprove}</button>
      {/if}
    {/if}
  {/snippet}
</AdminShell>
