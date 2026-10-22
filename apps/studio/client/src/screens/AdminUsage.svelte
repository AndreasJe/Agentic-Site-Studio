<script lang="ts">
// Usage statistics (plan §15; design/prototype/AdminUsage.dc.html; M8.5). Admin only. Site and
// project figures by default; one person's figures only by asking for that person; and the
// retention setting for per-person rows.
import AdminShell from '../components/AdminShell.svelte'
import { errText, fmtNum } from '../lib/admin-format.ts'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { i18n } from '../lib/i18n.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Totals = { calls: number; attempts: number; inputTokens: number; outputTokens: number; cachedTokens: number }
type Stats = {
  totals: Totals
  byPhase: ({ phase: string } & Totals)[]
  byRole: ({ role: string } & Totals)[]
  byDay: ({ day: string } & Totals)[]
  byProject: ({ project: string } & Totals)[]
}
type Msg = { text: string; ok: boolean } | null

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')
const n = (v: number) => fmtNum(v, i18n.lang)

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let period = $state('30')
let project = $state('')
let projects = $state<{ id: string; name: string }[]>([])
let stats = $state<Stats | null>(null)
let days = $state('90')
let retMsg = $state<Msg>(null)

let who = $state('')
let person = $state<{ handle: string; stats: Stats } | null>(null)
let personMsg = $state<Msg>(null)

const query = () => {
  const q = new URLSearchParams()
  if (project) q.set('project', project)
  if (period !== 'all') {
    const from = new Date(Date.now() - Number(period) * 86400_000).toISOString().slice(0, 10)
    q.set('from', from)
  }
  const t = q.toString()
  return t ? `?${t}` : ''
}

async function load() {
  const r = await api<{ stats: Stats; retentionDays: number }>('GET', `/api/admin/usage${query()}`)
  if (!r.ok) {
    view = 'failed'
    return
  }
  stats = r.body.stats
  days = String(r.body.retentionDays)
  view = 'ok'
}

async function loadProjects() {
  const r = await api<{ projects: { id: string; name: string }[] }>('GET', '/api/projects')
  projects = r.body.projects ?? []
}

$effect(() => {
  if (isAdmin) {
    loadProjects()
    load()
  }
})

async function reload() {
  await load()
  if (person) await showPerson()
}

async function showPerson() {
  personMsg = null
  const h = who.trim()
  if (!h) return
  const r = await api<{ handle: string; stats: Stats; code?: string }>(
    'GET',
    `/api/usage/person/${encodeURIComponent(h)}${query()}`,
  )
  if (!r.ok) {
    person = null
    personMsg = { text: errText(r.body.code, s.ugCode), ok: false }
    return
  }
  person = { handle: r.body.handle, stats: r.body.stats }
}

async function saveRetention() {
  retMsg = null
  const v = /^\d{1,5}$/.test(days.trim()) ? Number(days) : Number.NaN
  if (Number.isNaN(v)) {
    retMsg = { text: s.ugCode['bad-input'] ?? '', ok: false }
    return
  }
  const r = await api<{ code?: string }>('PUT', '/api/admin/usage/retention', { days: v })
  retMsg = r.ok ? { text: s.ugRetentionSaved, ok: true } : { text: errText(r.body.code, s.ugCode), ok: false }
}

async function applyRetention() {
  retMsg = null
  const r = await api<{ result?: { deleted: number }; code?: string }>('POST', '/api/admin/usage/retention/run')
  retMsg = r.ok
    ? { text: afill(s.ugRetentionDone, { n: r.body.result?.deleted ?? 0 }), ok: true }
    : { text: errText(r.body.code, s.ugCode), ok: false }
  await load()
}
</script>

{#snippet table(rows: ({ [k: string]: string | number })[], key: string, head: string)}
  {#if rows.length === 0}
    <p class="small muted">{s.ugNoUse}</p>
  {:else}
    <div class="tblwrap">
      <table class="tbl">
        <thead>
          <tr>
            <th scope="col">{head}</th>
            <th scope="col" class="m8-num">{s.ugCalls}</th>
            <th scope="col" class="m8-num">{s.ugInput}</th>
            <th scope="col" class="m8-num">{s.ugOutput}</th>
            <th scope="col" class="m8-num">{s.ugCached}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r[key] ?? '')}
            <tr>
              <td class="mono small">{r[key] || s.ugNoName}</td>
              <td class="m8-num">{n(Number(r.calls))}</td>
              <td class="m8-num">{n(Number(r.inputTokens))}</td>
              <td class="m8-num">{n(Number(r.outputTokens))}</td>
              <td class="m8-num">{n(Number(r.cachedTokens))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/snippet}

{#snippet figures(st: Stats)}
  <div class="m8-stats">
    <div class="m8-stat"><span class="label">{s.ugCalls}</span><b>{n(st.totals.calls)}</b></div>
    <div class="m8-stat"><span class="label">{s.ugAttempts}</span><b>{n(st.totals.attempts)}</b></div>
    <div class="m8-stat"><span class="label">{s.ugInput}</span><b>{n(st.totals.inputTokens)}</b></div>
    <div class="m8-stat"><span class="label">{s.ugOutput}</span><b>{n(st.totals.outputTokens)}</b></div>
    <div class="m8-stat"><span class="label">{s.ugCached}</span><b>{n(st.totals.cachedTokens)}</b></div>
  </div>
  <div class="stack" style="gap: 20px">
    <div class="stack" style="gap: 8px"><h3 class="label">{s.ugByPhase}</h3>{@render table(st.byPhase, 'phase', s.ugColName)}</div>
    <div class="stack" style="gap: 8px"><h3 class="label">{s.ugByRole}</h3>{@render table(st.byRole, 'role', s.ugColName)}</div>
    <div class="stack" style="gap: 8px"><h3 class="label">{s.ugByProject}</h3>{@render table(st.byProject, 'project', s.ugColName)}</div>
    <div class="stack" style="gap: 8px"><h3 class="label">{s.ugByDay}</h3>{@render table(st.byDay, 'day', s.ugColDay)}</div>
  </div>
{/snippet}

<AdminShell
  heading={s.ugHeading}
  kicker={s.kicker}
  sub={s.ugSub}
  active="usage"
  did={s.ugDid}
  state={view}
>
  <div class="fgrid" style="max-width: 560px">
    <div class="field">
      <label for="ug-period">{s.ugPeriod}</label>
      <select id="ug-period" class="input" bind:value={period} onchange={reload}>
        {#each Object.entries(s.ugPeriods) as [k, label] (k)}<option value={k}>{label}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="ug-project">{s.ugProject}</label>
      <select id="ug-project" class="input" bind:value={project} onchange={reload}>
        <option value="">{s.ugAllProjects}</option>
        {#each projects as p (p.id)}<option value={p.id}>{p.name} · {p.id}</option>{/each}
      </select>
    </div>
  </div>

  {#if stats}
    <section class="sec" aria-labelledby="ug-totals" data-testid="ug-totals">
      <div class="sec-h"><h2 id="ug-totals" class="h2s">{s.ugTotalsH}</h2></div>
      {@render figures(stats)}
    </section>
  {/if}

  <section class="sec" aria-labelledby="ug-person">
    <div class="sec-h"><h2 id="ug-person" class="h2s">{s.ugPersonH}</h2></div>
    <p class="small muted">{s.ugPersonSub}</p>
    <div class="row" style="align-items: flex-end">
      <div class="field" style="width: 240px">
        <label for="ug-who">{s.ugPersonLabel}</label>
        <input id="ug-who" class="input mono" bind:value={who} autocomplete="off" />
      </div>
      <button type="button" class="btn" disabled={!who.trim()} onclick={showPerson}>{s.ugPersonShow}</button>
    </div>
    {#if personMsg}<p class="amsg" role="alert">{personMsg.text}</p>{/if}
    {#if person}
      <h3 class="label">{afill(s.ugPersonFor, { who: person.handle })}</h3>
      {#if person.stats.totals.attempts === 0}<p class="small muted">{s.ugPersonNone}</p>{:else}{@render figures(person.stats)}{/if}
    {/if}
  </section>

  <section class="card" aria-labelledby="ug-ret">
    <div class="card-h"><h2 id="ug-ret" class="h2s" style="font-size: 22px">{s.ugRetentionH}</h2></div>
    <div class="card-b">
      <p class="small muted">{s.ugRetentionSub}</p>
      <div class="field" style="max-width: 280px">
        <label for="ug-days">{s.ugRetentionDays}</label>
        <input id="ug-days" class="input mono" inputmode="numeric" bind:value={days} />
      </div>
      {#if retMsg}<p class="amsg" class:okmsg={retMsg.ok} role={retMsg.ok ? 'status' : 'alert'}>{retMsg.text}</p>{/if}
    </div>
    <div class="card-f">
      <span class="note">{s.ugRetentionRunConseq}</span>
      <button type="button" class="btn danger" onclick={applyRetention}>{s.ugRetentionRun}</button>
    </div>
  </section>

  {#snippet bar()}
    <span class="conseq">{s.ugConseq}</span>
    <button type="button" class="btn primary" onclick={saveRetention}>{s.ugRetentionSave}</button>
  {/snippet}
</AdminShell>
