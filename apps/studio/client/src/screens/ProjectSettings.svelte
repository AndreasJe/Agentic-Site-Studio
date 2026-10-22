<script lang="ts">
// Project settings (plan §16.6; design/prototype/ProjectSettings.dc.html; M8.6), at
// /p/:project/settings. Admin only. Members, whether structure changes need an Admin, and rules
// that make this project stricter than the install. Looser options are never offered.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { errText } from '../lib/admin-format.ts'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { cs } from '../lib/checks-strings.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Member = { handle: string; name: string; role?: string }
type View = {
  project: string
  members: Member[]
  install: { twoPerson: Record<string, number>; checks: Record<string, string> }
  settings: {
    structureNeedsAdmin: boolean
    twoPerson: Record<string, number>
    checks: Record<string, string>
  }
}
type Msg = { text: string; ok: boolean } | null

const PARTS = ['releases', 'keys', 'domains']
const FLOOR = new Set(['html', 'links', 'csp', 'inline-code', 'validators', 'svg', 'pinned', 'secrets'])

let { id }: { id: string } = $props()
const s = $derived(ad())
const names = $derived(cs().names as Record<string, string>)
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let data = $state<View | null>(null)
let members = $state<Member[]>([])
let structure = $state(false)
let two = $state<Record<string, string>>({})
let lv = $state<Record<string, string>>({})
let newHandle = $state('')
let msg = $state<Msg>(null)
let busy = $state(false)

function fill(v: View) {
  data = v
  members = v.members
  structure = v.settings.structureNeedsAdmin
  two = Object.fromEntries(PARTS.map((p) => [p, String(v.settings.twoPerson[p] ?? '')]))
  lv = Object.fromEntries(Object.keys(v.install.checks).map((c) => [c, v.settings.checks[c] ?? '']))
}

async function load() {
  const r = await api<View>('GET', `/api/p/${encodeURIComponent(id)}/settings`)
  if (!r.ok) {
    view = 'failed'
    return
  }
  fill(r.body)
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

function addMember() {
  const h = newHandle.trim().toLowerCase()
  if (!h) return
  if (members.some((m) => m.handle === h)) {
    msg = { text: s.pstMemberExists, ok: false }
    return
  }
  members = [...members, { handle: h, name: h }]
  newHandle = ''
  msg = null
}

async function save() {
  if (busy || !data) return
  busy = true
  msg = null
  const twoPerson: Record<string, number> = {}
  for (const p of PARTS) if (two[p]) twoPerson[p] = Number(two[p])
  const checks: Record<string, string> = {}
  for (const [c, v] of Object.entries(lv)) if (v && !FLOOR.has(c)) checks[c] = v
  const r = await api<View & { code?: string }>('PUT', `/api/p/${encodeURIComponent(id)}/settings`, {
    structureNeedsAdmin: structure,
    twoPerson,
    checks,
    members: members.map((m) => m.handle),
  })
  busy = false
  if (r.ok) {
    fill(r.body)
    msg = { text: s.pstSaved, ok: true }
  } else msg = { text: errText(r.body.code, s.pstCode), ok: false }
}

const lowered = $derived(
  data
    ? Object.entries(data.install.checks).filter(
        ([c, level]) => !FLOOR.has(c) && (level !== 'block' || data?.settings.checks[c]),
      )
    : [],
)
const rank = (l: string) => ({ off: 0, warn: 1, block: 2 })[l] ?? 2
</script>

<AdminShell
  heading={data ? data.project : s.pstHeading}
  kicker={s.pstHeading}
  sub={s.pstSub}
  did={s.pstDid}
  state={view}
>
  {#snippet head()}
    <a class="back btn quiet" href="/p/{id}" use:link><Icon name="arrow-left" small />{s.pstBack}</a>
  {/snippet}

  {#if data}
    <section class="sec" aria-labelledby="ps-mem">
      <div class="sec-h"><h2 id="ps-mem" class="h2s">{s.pstMembersH}</h2><span class="m8-sub">{s.pstMembersSub}</span></div>
      {#if members.length === 0}<p class="small muted">{s.pstNoMembers}</p>{/if}
      <ul class="rows" style="list-style: none; margin: 0; padding: 0" data-testid="ps-members">
        {#each members as m (m.handle)}
          <li class="keyrow">
            <span class="who"><b>{m.name}</b><span class="mono small muted">{m.handle}</span></span>
            <button type="button" class="btn quiet" aria-label={afill(s.pstMemberRemove, { who: m.name })} onclick={() => (members = members.filter((x) => x.handle !== m.handle))}>{s.m8Remove}</button>
          </li>
        {/each}
      </ul>
      <div class="row" style="align-items: flex-end">
        <div class="field" style="width: 240px">
          <label for="ps-add">{s.pstMemberAdd}</label>
          <input id="ps-add" class="input mono" bind:value={newHandle} autocomplete="off" />
        </div>
        <button type="button" class="btn" disabled={!newHandle.trim()} onclick={addMember}>{s.pstMemberAddGo}</button>
      </div>
    </section>

    <section class="sec" aria-labelledby="ps-st">
      <div class="sec-h"><h2 id="ps-st" class="h2s">{s.pstStructureH}</h2></div>
      <button type="button" class="tgl" aria-pressed={structure} onclick={() => (structure = !structure)}>
        <span class="sw"></span><span>{s.pstStructure}</span>
      </button>
      <p class="small muted">{s.pstStructureNote}</p>
    </section>

    <section class="sec" aria-labelledby="ps-two">
      <div class="sec-h"><h2 id="ps-two" class="h2s">{s.pstRulesH}</h2><span class="m8-sub">{s.pstRulesSub}</span></div>
      <div class="tblwrap">
        <table class="tbl">
          <thead><tr><th scope="col">{s.pstRulesH}</th><th scope="col">{s.pstColInstall}</th><th scope="col">{s.pstColProject}</th></tr></thead>
          <tbody>
            {#each PARTS as p (p)}
              {@const base = data.install.twoPerson[p] ?? 1}
              <tr>
                <td>{s.pstPartNames[p]}</td>
                <td class="small">{base === 2 ? s.pstTwo : s.pstOne}</td>
                <td style="min-width: 170px">
                  <label class="sr-only" for="two-{p}">{s.pstPartNames[p]}</label>
                  <select id="two-{p}" class="input" bind:value={two[p]}>
                    <option value="">{s.pstSame}</option>
                    <option value="1" disabled={base > 1}>{s.pstOne}</option>
                    <option value="2">{s.pstTwo}</option>
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="small muted">{s.pstRulesNote}</p>
    </section>

    <section class="sec" aria-labelledby="ps-ck">
      <div class="sec-h"><h2 id="ps-ck" class="h2s">{s.pstChecksH}</h2><span class="m8-sub">{s.pstChecksSub}</span></div>
      {#if lowered.length === 0}
        <p class="small muted">{s.pstChecksNone}</p>
      {:else}
        <div class="tblwrap">
          <table class="tbl">
            <thead><tr><th scope="col">{s.pstColCheck}</th><th scope="col">{s.pstColInstall}</th><th scope="col">{s.pstColProject}</th></tr></thead>
            <tbody>
              {#each lowered as [c, level] (c)}
                <tr>
                  <td>{names[c] ?? c}</td>
                  <td class="small">{s.pstLevels[level] ?? level}</td>
                  <td style="min-width: 170px">
                    <label class="sr-only" for="lv-{c}">{afill(s.pstLevelFor, { check: names[c] ?? c })}</label>
                    <select id="lv-{c}" class="input" bind:value={lv[c]}>
                      <option value="">{s.pstSame}</option>
                      {#each ['warn', 'block'] as l (l)}
                        <option value={l} disabled={rank(l) < rank(level)}>{s.pstLevels[l]}</option>
                      {/each}
                    </select>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="sec" aria-labelledby="ps-fl">
      <div class="sec-h"><h2 id="ps-fl" class="h2s">{s.pstFloorH}</h2></div>
      <ul class="findings">
        {#each s.pstFloor as line (line)}<li>{line}</li>{/each}
      </ul>
    </section>

    {#if msg}<p class="amsg" class:okmsg={msg.ok} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>{/if}
  {/if}

  {#snippet bar()}
    <span class="conseq">{s.pstConseq}</span>
    <button type="button" class="btn primary" disabled={busy || !data} onclick={save}>{s.pstSave}</button>
  {/snippet}
</AdminShell>
