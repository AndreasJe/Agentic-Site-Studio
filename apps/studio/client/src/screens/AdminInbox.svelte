<script lang="ts">
// Waiting for you (plan §10.5, §13.3 step 5, §16.6; design/prototype/AdminInbox.dc.html; M7.8).
// Admin only. One list across projects: failed check runs, publication requests, address requests
// and notices. Opening a card opens the page where the decision is made; nothing is decided here.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'
import { when } from '../lib/signing.ts'

type Item = { id: number; kind: string; ref: string; title: string; created_at: string }
type Failure = {
  id: string
  project: string
  rev: string
  at: string
  failedChecks: string[]
  floorFailed: boolean
  analysis: { status: string; recommendation: string } | null
}
type Address = { id: string; project: string; name: string; by: string; at: string; note: string }
type Review = {
  request: { id: number; project: string; rev: string; by: string; note: string; at: string; status: string }
  checks: { floorPassed: boolean; results: { id: string; status: string; floor: boolean }[] }
  warnings: { acknowledged: unknown }[]
  policy: { releases: number }
}
type Pub = { item: Item; review: Review | null }

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let filter = $state<'all' | 'fail' | 'pub' | 'addr' | 'not'>('all')
let pubs = $state<Pub[]>([])
let addrs = $state<Address[]>([])
let fails = $state<Failure[]>([])
let notices = $state<Item[]>([])

async function load() {
  const [inbox, addr, fail] = await Promise.all([
    api<{ items: Item[] }>('GET', '/api/admin/inbox'),
    api<{ requests: Address[] }>('GET', '/api/admin/addresses?status=pending'),
    api<{ failures: Failure[] }>('GET', '/api/admin/failures'),
  ])
  if (!inbox.ok) {
    view = 'failed'
    return
  }
  const items = inbox.body.items ?? []
  const requests = items.filter((i) => i.kind === 'publication-request')
  pubs = await Promise.all(
    requests.slice(0, 20).map(async (item) => {
      const id = /^request:(\d+)$/.exec(item.ref)?.[1]
      const r = id ? await api<Review>('GET', `/api/admin/review/${id}`) : null
      return { item, review: r?.ok ? r.body : null }
    }),
  )
  notices = items.filter((i) => i.kind !== 'publication-request' && i.kind !== 'address-request')
  addrs = addr.ok ? (addr.body.requests ?? []) : []
  fails = fail.ok
    ? (fail.body.failures ?? []).filter((f) => f.analysis !== null || f.floorFailed).slice(0, 10)
    : []
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

async function done(item: Item) {
  const r = await api('POST', `/api/admin/inbox/${item.id}/done`, {})
  if (r.ok) notices = notices.filter((n) => n.id !== item.id)
}

const count = $derived(pubs.length + addrs.length + fails.length + notices.length)
const show = (g: 'fail' | 'pub' | 'addr' | 'not') => filter === 'all' || filter === g
const oldest = $derived(pubs.length ? pubs[pubs.length - 1] : null)
const kindOf = (k: string) => s.inKind[k] ?? s.inKindOther
const openWarnings = (p: Pub) => p.review?.warnings.filter((w) => !w.acknowledged).length ?? 0
const reqId = (p: Pub) => p.item.ref.replace('request:', '')
const floorOf = (r: Review) => r.checks.results.filter((c) => c.floor)
</script>

<AdminShell
  heading={s.inHeading}
  sub={count === 1 ? s.inSubOne : afill(s.inSub, { n: count })}
  did={s.inDid}
  state={view}
>
  {#snippet head()}
    <div class="seg" role="group" aria-label={s.inFilterAria}>
      <button type="button" aria-pressed={filter === 'all'} onclick={() => (filter = 'all')}>{afill(s.inAll, { n: count })}</button>
      <button type="button" aria-pressed={filter === 'fail'} onclick={() => (filter = 'fail')}>{afill(s.inFail, { n: fails.length })}</button>
      <button type="button" aria-pressed={filter === 'pub'} onclick={() => (filter = 'pub')}>{afill(s.inPub, { n: pubs.length })}</button>
      <button type="button" aria-pressed={filter === 'addr'} onclick={() => (filter = 'addr')}>{afill(s.inAddr, { n: addrs.length })}</button>
      <button type="button" aria-pressed={filter === 'not'} onclick={() => (filter = 'not')}>{afill(s.inNot, { n: notices.length })}</button>
    </div>
  {/snippet}

  <p class="small muted row" style="gap: 8px"><Icon name="lock" small />{s.inNote}</p>

  {#if count === 0}
    <p class="muted" role="status">{s.inEmpty}</p>
  {/if}

  {#if show('fail') && fails.length}
    <section class="group rise" aria-labelledby="g-fail">
      <div class="group-h"><h2 id="g-fail" class="h2s">{s.inFailGroup}</h2><span class="mono small muted">{fails.length}</span></div>
      {#each fails as f (f.id)}
        <article class="card">
          <div class="card-h">
            <Icon name="warn" />
            <b>{f.project}</b>
            <span class="id">{f.rev}</span>
            <span class="small muted">{afill(s.inFailChecks, { checks: f.failedChecks.join(', ') })}</span>
            <span class="mono small muted" style="margin-left: auto">{when(f.at)}</span>
          </div>
          {#if f.floorFailed}
            <div class="card-b"><div class="row" style="gap: 6px"><span class="chip sig">{s.inFloor}</span></div></div>
          {/if}
          <div class="card-f">
            <span class="note">{s.inFailNote}</span>
            <a class="btn" href="/admin/failures/{f.id}" use:link>{s.inFailOpen}</a>
          </div>
        </article>
      {/each}
    </section>
  {/if}

  {#if show('pub') && pubs.length}
    <section class="group rise" aria-labelledby="g-pub">
      <div class="group-h"><h2 id="g-pub" class="h2s">{s.inPubGroup}</h2><span class="mono small muted">{pubs.length}</span></div>
      {#each pubs as p (p.item.id)}
        <article class="card ink" data-testid="inbox-publication">
          <div class="card-h">
            <Icon name="publish" />
            <b>{p.review?.request.project ?? p.item.title}</b>
            {#if p.review}<span class="id">{p.review.request.rev}</span>{/if}
            <span class="small muted">{s.inPubKind}</span>
            <span class="mono small muted" style="margin-left: auto">{when(p.item.created_at)}</span>
          </div>
          <div class="card-b">
            <span class="small">{p.item.title}</span>
            {#if p.review}
              {#if p.review.request.note}<p class="note-plain">{p.review.request.note}</p>{/if}
              <div class="rows small">
                <div class="r"><span style="width: 150px">{s.rvHardH}</span>
                  {#if p.review.checks.floorPassed}<span class="chip ok">{afill(s.rvHardCount, { n: floorOf(p.review).filter((c) => c.status === 'pass').length, m: floorOf(p.review).length })}</span>
                  {:else}<span class="chip sig">{s.rvHardNone}</span>{/if}
                </div>
                <div class="r"><span style="width: 150px">{s.rvAdvH}</span>
                  {#if openWarnings(p)}<span class="chip warn">{openWarnings(p)}</span>{:else}<span class="chip">{s.rvAckNone}</span>{/if}
                </div>
                <div class="r"><span style="width: 150px">{s.rvDecisionH}</span><span>{p.review.policy.releases === 2 ? s.rvRuleTwo : s.rvRuleOne}</span></div>
              </div>
            {/if}
          </div>
          <div class="card-f">
            <span class="note">{s.inPubNote}</span>
            {#if p.review}<a class="btn" href="/p/{p.review.request.project}/staging" use:link>{s.rvOpenStaging}</a>{/if}
            <a class="btn primary" href="/admin/review/{reqId(p)}" use:link>{s.inPubOpen}</a>
          </div>
        </article>
      {/each}
    </section>
  {/if}

  {#if show('addr') && addrs.length}
    <section class="group rise" aria-labelledby="g-addr">
      <div class="group-h"><h2 id="g-addr" class="h2s">{s.inAddrGroup}</h2><span class="mono small muted">{addrs.length}</span></div>
      {#each addrs as a (a.id)}
        <article class="card">
          <div class="card-h">
            <Icon name="globe" />
            <b>{a.project}</b>
            <span class="small muted">{afill(s.inAddrBy, { by: a.by })}</span>
            <span class="mono small muted" style="margin-left: auto">{when(a.at)}</span>
          </div>
          <div class="card-b">
            <span class="bigaddr">{a.name}</span>
            {#if a.note}<p class="note-plain">{a.note}</p>{/if}
          </div>
          <div class="card-f">
            <span class="note">{s.inAddrNote}</span>
            <a class="btn primary" href="/admin/addresses/{a.project}/{a.name}" use:link>{s.inAddrOpen}</a>
          </div>
        </article>
      {/each}
    </section>
  {/if}

  {#if show('not') && notices.length}
    <section class="group rise" aria-labelledby="g-not">
      <div class="group-h"><h2 id="g-not" class="h2s">{s.inNotGroup}</h2><span class="mono small muted">{notices.length}</span></div>
      {#each notices as n (n.id)}
        <article class="card">
          <div class="card-h">
            <Icon name="inbox" />
            <b>{kindOf(n.kind)}</b>
            <span class="mono small muted" style="margin-left: auto">{when(n.created_at)}</span>
          </div>
          <div class="card-b"><p class="small">{n.title}</p></div>
          <div class="card-f">
            <span class="note">{s.inNoticeNote}</span>
            <button type="button" class="btn" aria-label={afill(s.inDoneTitle, { title: n.title })} onclick={() => done(n)}>{s.inDone}</button>
          </div>
        </article>
      {/each}
    </section>
  {/if}

  {#snippet bar()}
    <span class="conseq">{s.inConseq}</span>
    {#if oldest?.review}
      <a class="btn primary" href="/admin/review/{reqId(oldest)}" use:link>{s.inPubOpen}</a>
    {/if}
  {/snippet}
</AdminShell>
