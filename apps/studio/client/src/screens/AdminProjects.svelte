<script lang="ts">
// Projects overview (plan §16.6; design/prototype/AdminProjects.dc.html; M8.5). Admin only. Every
// project with its members and where it stands, with a filter, and a way in to the project and
// to its settings.
import AdminShell from '../components/AdminShell.svelte'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Project = {
  id: string
  name: string
  members: { handle: string; name: string }[]
  lastRevision: string | null
  approved: string | null
  staged: string | null
  published: string | null
}

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let projects = $state<Project[]>([])
let text = $state('')
let stateFilter = $state('all')

async function load() {
  const r = await api<{ projects: Project[] }>('GET', '/api/admin/projects')
  if (!r.ok) {
    view = 'failed'
    return
  }
  projects = r.body.projects
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const shown = $derived(
  projects.filter((p) => {
    const q = text.trim().toLowerCase()
    if (q && !p.name.toLowerCase().includes(q) && !p.id.includes(q)) return false
    if (stateFilter === 'live') return p.published !== null
    if (stateFilter === 'notlive') return p.published === null
    if (stateFilter === 'staged') return p.staged !== null
    return true
  }),
)
</script>

<AdminShell
  heading={s.pjHeading}
  kicker={s.kicker}
  sub={s.pjSub}
  active="projects"
  did={s.pjDid}
  state={view}
>
  <div class="fgrid" style="max-width: 560px">
    <div class="field">
      <label for="pj-q">{s.pjFilter}</label>
      <input id="pj-q" class="input" bind:value={text} autocomplete="off" />
    </div>
    <div class="field">
      <label for="pj-s">{s.pjState}</label>
      <select id="pj-s" class="input" bind:value={stateFilter}>
        {#each Object.entries(s.pjStates) as [k, label] (k)}<option value={k}>{label}</option>{/each}
      </select>
    </div>
  </div>

  {#if projects.length === 0}
    <p class="small muted">{s.pjEmpty}</p>
  {:else if shown.length === 0}
    <p class="small muted">{s.pjNone}</p>
  {:else}
    <div class="tblwrap">
      <table class="tbl" data-testid="pj-list">
        <thead>
          <tr>
            <th scope="col">{s.pjColProject}</th>
            <th scope="col">{s.pjColMembers}</th>
            <th scope="col">{s.pjColRev}</th>
            <th scope="col">{s.pjColStaged}</th>
            <th scope="col">{s.pjColLive}</th>
            <th scope="col"><span class="sr-only">{s.pjColGo}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each shown as p (p.id)}
            <tr>
              <td><span class="row" style="gap: 8px"><b>{p.name}</b><span class="id">{p.id}</span></span></td>
              <td class="small">
                {#if p.members.length === 0}<span class="muted">{s.pjNoMembers}</span>{:else}{p.members.map((m) => m.name || m.handle).join(', ')}{/if}
              </td>
              <td class="mono small">{p.lastRevision ?? s.pjNoRev}</td>
              <td class="mono small">{p.staged ?? s.pjNotStaged}</td>
              <td class="mono small">{p.published ?? s.pjNotLive}</td>
              <td>
                <span class="row">
                  <a class="btn" href="/p/{p.id}" use:link aria-label={afill(s.pjOpenAria, { name: p.name })}>{s.pjOpenProject}</a>
                  <a class="btn quiet" href="/p/{p.id}/settings" use:link aria-label={afill(s.pjSettingsAria, { name: p.name })}>{s.pjSettings}</a>
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#snippet bar()}
    <span class="conseq">{s.pjConseq}</span>
    <a class="btn primary" href="/projects" use:link>{s.pjGoProjects}</a>
  {/snippet}
</AdminShell>
