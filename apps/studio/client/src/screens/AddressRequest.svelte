<script lang="ts">
// Address request (plan §10.4; design/prototype/AddressRequest.dc.html; M7.8). Admin only. A
// Creator asks for an own address (a subdomain) for a page; the Admin approves it or turns it down
// with a note, and the Creator sees the answer. Approving reserves the name; it goes live with the
// next release that includes it.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'
import { when } from '../lib/signing.ts'

let { project, name }: { project: string; name: string } = $props()

type Request = {
  id: string
  project: string
  name: string
  pageId: string
  pageTitle: string | null
  note: string
  by: string
  at: string
  revision: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
  decisionNote: string | null
  decidedAt: string | null
}

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let request = $state<Request | null>(null)
let domain = $state('')
let pick = $state<'approve' | 'reject' | null>(null)
let note = $state('')
let busy = $state(false)
let error = $state('')

async function load() {
  const [r, t] = await Promise.all([
    api<{ requests: Request[] }>('GET', `/api/admin/addresses?project=${encodeURIComponent(project)}`),
    api<{ targets: { domains: string[] }[] }>('GET', '/api/deploy/targets'),
  ])
  if (!r.ok) {
    view = 'failed'
    return
  }
  request = (r.body.requests ?? []).find((x) => x.name === name) ?? null
  const d = t.ok ? (t.body.targets ?? []).flatMap((x) => x.domains).find((x) => !x.startsWith('*')) : ''
  domain = d ?? ''
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const full = $derived(`${name}.${domain || s.adUnknownDomain}`)
const by = $derived(request?.by ?? '')
const pending = $derived(request?.status === 'pending')
const needsNote = $derived(pick === 'reject' && !note.trim())
const ready = $derived(pick !== null && !needsNote && !busy)

async function decide() {
  if (!pick || !ready) return
  busy = true
  error = ''
  const r = await api<{ request?: Request; code?: string }>(
    'POST',
    `/api/admin/addresses/${encodeURIComponent(project)}/${encodeURIComponent(name)}/${pick}`,
    { note: note.trim() },
  )
  busy = false
  if (r.ok && r.body.request) {
    request = r.body.request
    pick = null
  } else error = codeText(r.body.code)
}

const conseq = $derived.by(() => {
  if (!pending) return ''
  if (pick === 'approve') return s.adConseqApprove
  if (pick === 'reject') return needsNote ? afill(s.adConseqNeedNote, { by }) : afill(s.adConseqReject, { by })
  return s.adConseqPick
})
</script>

<AdminShell
  heading={s.adTitle}
  did={afill(s.adDid, { by })}
  state={view}
>
  <a class="small muted back" href="/admin" use:link><Icon name="arrow-left" small />{s.rvBack}</a>

  {#if !request}
    <p role="alert">{s.adMissing}</p>
  {:else}
    <p class="row muted" style="gap: 8px"><span class="id">{request.project}</span><span>{afill(s.adBy, { by: request.by, at: when(request.at) })}</span></p>

    <div class="split">
      <div class="grow stack" style="gap: 28px">
        <section class="card ink" aria-labelledby="addr-h">
          <div class="card-b" style="gap: 18px; padding: 28px">
            <span class="label">{s.adSuggested}</span>
            <h2 id="addr-h" class="bigaddr">{full}</h2>
            <div class="row" style="gap: 8px">
              <span class="chip ok"><Icon name="check" small />{s.adStatus[request.status]}</span>
              <span class="chip where"><Icon name="globe" small />{request.pageTitle ? afill(s.adPage, { title: request.pageTitle, rev: request.revision }) : afill(s.adPageNone, { id: request.pageId, rev: request.revision })}</span>
            </div>
          </div>
        </section>

        <section class="stack" style="gap: 8px" aria-labelledby="note-h">
          <h2 id="note-h" class="label">{afill(s.adNote, { by: request.by })}</h2>
          {#if request.note}<p class="note-plain">{request.note}</p>{:else}<p class="small muted">{s.adNoteNone}</p>{/if}
        </section>
      </div>

      <aside class="side stack" style="gap: 24px">
        <section class="walllabel" aria-labelledby="chk-h">
          <h2 id="chk-h" class="label">{s.adChecksH}</h2>
          <div class="rows small" style="border-top: 0">
            <div class="r"><Icon name="check" small /><span>{s.adCheckFree}</span></div>
            <div class="r"><Icon name="check" small /><span>{s.adCheckRules}</span></div>
            <div class="r"><Icon name="lock" small /><span>{s.adCheckProduction}</span></div>
          </div>
        </section>

        <section class="stack" style="gap: 12px" aria-labelledby="out-h">
          <h2 id="out-h" class="h2s">{s.adOutcomeH}</h2>
          {#if pending}
            <div class="opts" role="group" aria-label={s.adOutcomeAria}>
              <button type="button" class="opt" aria-pressed={pick === 'approve'} onclick={() => (pick = 'approve')}><b>{s.adApprove}</b><span class="small muted">{afill(s.adApproveSub, { name: full })}</span></button>
              <button type="button" class="opt" aria-pressed={pick === 'reject'} onclick={() => (pick = 'reject')}><b>{s.adReject}</b><span class="small muted">{afill(s.adRejectSub, { by })}</span></button>
            </div>
            {#if pick}
              <div class="field rise">
                <label for="nt">{pick === 'reject' ? afill(s.adRejectNote, { by }) : afill(s.adApproveNote, { by })}</label>
                <textarea id="nt" class="input" bind:value={note} maxlength="1000" placeholder={pick === 'reject' ? s.adRejectPlaceholder : ''}></textarea>
              </div>
            {/if}
            {#if error}<p class="amsg" role="alert">{error}</p>{/if}
          {:else}
            <div class="passkey" role="status">
              <div class="row" style="gap: 14px">
                <svg class="seal" viewBox="0 0 56 56" role="img" aria-label={request.status === 'approved' ? s.adDoneApproved : s.adDoneRejected}><circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2.6" /><circle cx="28" cy="28" r="21" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M19 28.5l6 6 12-13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square" /></svg>
                <span class="stack" style="gap: 2px">
                  <b>{request.status === 'approved' ? s.adDoneApproved : s.adDoneRejected}</b>
                  <span class="small muted">{afill(s.adDecided, { who: request.decidedBy ?? '', at: when(request.decidedAt) })}</span>
                </span>
              </div>
              <p class="small">{request.status === 'approved' ? afill(s.adDoneApprovedText, { name: full, by }) : afill(s.adDoneRejectedText, { by })}</p>
              {#if request.decisionNote}<p class="note-plain">{request.decisionNote}</p>{/if}
            </div>
          {/if}
        </section>
      </aside>
    </div>
  {/if}

  {#snippet bar()}
    {#if request && pending}
      <span class="conseq">{conseq}</span>
      <button type="button" class="btn primary" disabled={!ready} onclick={decide}>{pick === 'reject' ? afill(s.adConfirmReject, { name: full }) : afill(s.adConfirmApprove, { name: full })}</button>
    {:else}
      <a class="btn" href="/admin/deployment" use:link>{s.rvOpenDeployment}</a>
      <a class="btn primary" href="/admin" use:link>{s.rvBackInbox}</a>
    {/if}
  {/snippet}
</AdminShell>
