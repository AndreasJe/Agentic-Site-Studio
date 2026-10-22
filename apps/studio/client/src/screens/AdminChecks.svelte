<script lang="ts">
// Checks (plan §16.5, §13.5; design/prototype/AdminChecks.dc.html; M6.8). Admin only. Each check
// has a level (Off, Warn, Block); the security-floor checks are locked on Block, and the server
// refuses to lower them (409 cant-be-lowered), so this screen only ever shows the lock. The
// failure-analysis setting sits here too. Every change is saved at once and audited by the server.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { cfill, cs } from '../lib/checks-strings.ts'
import { assertWithPasskey } from '../lib/passkey.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Check = {
  id: string
  floor: boolean
  level: string
  guards: string
  runsOn: string
  last: { status: string; at: string; run: string } | null
}

const LEVELS = ['off', 'warn', 'block'] as const
const HEAL = ['off', 'analyse', 'analyse-and-fix'] as const

const s = $derived(cs())
const isAdmin = $derived(session.user?.role === 'admin')

let loaded = $state(false)
let failed = $state(false)
let checks = $state<Check[]>([])
let heal = $state('analyse-and-fix')
let busy = $state<string | null>(null)
// An inline message per row (id) or for the failure-analysis setting ('failure-analysis').
let notes = $state<Record<string, { text: string; ok: boolean }>>({})

const floor = $derived(checks.filter((c) => c.floor))
const other = $derived(checks.filter((c) => !c.floor))
const nameOf = (id: string) => s.names[id] ?? id
const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function load() {
  const r = await api<{ checks: Check[]; failureAnalysis: string }>('GET', '/api/admin/checks')
  loaded = true
  if (!r.ok) {
    failed = true
    return
  }
  checks = r.body.checks
  heal = r.body.failureAnalysis
}

$effect(() => {
  if (isAdmin) load()
  else loaded = true
})

async function setLevel(c: Check, level: string) {
  if (busy || level === c.level) return
  busy = c.id
  let r = await api<{ code?: string; stepUp?: { id: string; publicKey: { challenge: string } } }>(
    'PUT',
    `/api/admin/checks/${c.id}`,
    { level },
  )
  // Lowering a check asks for the passkey again, for exactly this change (M7 step-up).
  if (r.status === 428 && r.body.stepUp) {
    const a = await assertWithPasskey(r.body.stepUp.publicKey)
    if (!a.ok) {
      busy = null
      notes[c.id] = { text: s.acStepUp, ok: false }
      return
    }
    r = await api('PUT', `/api/admin/checks/${c.id}`, {
      level,
      stepUp: { id: r.body.stepUp.id, ...a.assertion },
    })
  }
  busy = null
  if (r.ok) {
    checks = checks.map((x) => (x.id === c.id ? { ...x, level } : x))
    notes[c.id] = { text: cfill(s.acSaved, { name: nameOf(c.id), level: s.level[level] ?? level }), ok: true }
  } else {
    notes[c.id] = {
      text: r.status === 409 ? cfill(s.acRefused, { name: nameOf(c.id) }) : s.acFailedSave,
      ok: false,
    }
  }
}

async function setHeal(value: string) {
  if (busy || value === heal) return
  busy = 'failure-analysis'
  const r = await api('PUT', '/api/admin/checks/failure-analysis', { value })
  busy = null
  if (r.ok) {
    heal = value
    notes['failure-analysis'] = { text: cfill(s.acSaved, { name: s.acHeal, level: s.heal[value] ?? value }), ok: true }
  } else notes['failure-analysis'] = { text: s.acFailedSave, ok: false }
}
</script>

<AdminShell
  heading={s.acHeading}
  kicker={s.acKicker}
  sub={s.acSub}
  active="checks"
  did={s.acDid}
  state={!loaded ? 'loading' : failed ? 'failed' : 'ok'}
>
  {#snippet head()}
    <span class="row"><span class="chip">{s.acDefault}</span></span>
  {/snippet}
          {#each [{ key: 'floor', name: s.acFloorGroup, guards: s.acFloorGuards, list: floor }, { key: 'other', name: s.acOtherGroup, guards: s.acOtherGuards, list: other }] as g (g.key)}
            <section class="grp" aria-labelledby="g-{g.key}">
              <div class="grph">
                <h2 id="g-{g.key}" class="h3s">{g.name}</h2>
                <span class="small muted">{g.guards}</span>
              </div>
              {#each g.list as c (c.id)}
                <div class="ckrow" data-testid="check-{c.id}">
                  <div class="stack" style="gap: 3px">
                    <b class="cname">{nameOf(c.id)}</b>
                    <span class="small muted">{s.acGuards}: {s.guards[c.id] ?? c.id}</span>
                  </div>
                  <div class="row" style="gap: 4px">
                    <span class="chip">{s.where[c.runsOn] ?? c.runsOn}</span>
                  </div>
                  <div class="stack" style="gap: 2px">
                    <span class="label small-label">{s.acLast}</span>
                    <span class="mono small">{c.last ? `${s.status[c.last.status] ?? c.last.status} · ${when(c.last.at)}` : s.acLastNone}</span>
                  </div>
                  <div class="ctl">
                    {#if c.floor}
                      <span class="floorlock" title={s.acLockedTitle}><Icon name="lock" small />{s.acLocked}</span>
                    {/if}
                    <div class="lv" role="group" aria-label={cfill(s.acLevelOf, { name: nameOf(c.id) })}>
                      {#each LEVELS as l (l)}
                        <button
                          type="button"
                          class:on={c.level === l}
                          class:w={l === 'warn'}
                          class:o={l === 'off'}
                          aria-pressed={c.level === l}
                          disabled={c.floor || busy === c.id}
                          onclick={() => setLevel(c, l)}>{s.level[l]}</button
                        >
                      {/each}
                    </div>
                  </div>
                  {#if notes[c.id]}
                    <p class="msg full" class:okmsg={notes[c.id]?.ok} role={notes[c.id]?.ok ? 'status' : 'alert'}>{notes[c.id]?.text}</p>
                  {/if}
                </div>
              {/each}
            </section>
          {/each}

          <section class="stack" aria-labelledby="heal-h" style="gap: 20px">
            <div class="row" style="justify-content: space-between; align-items: flex-end">
              <div class="stack" style="gap: 4px">
                <span class="label">{s.acHealKicker}</span>
                <h2 id="heal-h" class="h2s">{s.acHeal}</h2>
              </div>
              <div class="lv" role="group" aria-label={s.acHealAria}>
                {#each HEAL as h (h)}
                  <button
                    type="button"
                    class:on={heal === h}
                    class:o={h === 'off'}
                    aria-pressed={heal === h}
                    disabled={busy === 'failure-analysis'}
                    onclick={() => setHeal(h)}>{s.heal[h]}</button
                  >
                {/each}
              </div>
            </div>
            {#if notes['failure-analysis']}
              <p class="msg" class:okmsg={notes['failure-analysis']?.ok} role={notes['failure-analysis']?.ok ? 'status' : 'alert'}>{notes['failure-analysis']?.text}</p>
            {/if}
            <p class="muted" style="max-width: 780px">{s.acHealText}</p>

            <ol class="flow" aria-label={s.flow}>
              <li><span class="n">01</span><b>{s.flow1}</b><span class="small muted">{s.flow1t}</span></li>
              <li><span class="n">02</span><b>{s.flow2}</b><span class="small muted">{s.flow2t}</span></li>
              <li><span class="n">03</span><b>{s.flow3}</b><span class="small muted">{s.flow3t}</span></li>
              <li><span class="n">04</span><b>{s.flow4}</b><span class="small muted">{s.flow4t}</span></li>
            </ol>

            <div class="outs">
              <div><span class="chip ai">{s.outsFix}</span><span class="small">{s.outsFixT}</span></div>
              <div><span class="chip sig">{s.outsHold}</span><span class="small">{s.outsHoldT}</span></div>
              <div><span class="chip"><Icon name="lock" small />{s.outsNoLet}</span><span class="small">{s.outsNoLetT}</span></div>
            </div>
          </section>

  {#snippet bar()}
    <span class="conseq">{s.acConseq}</span>
    <a class="btn" href="/admin/failures" use:link>{s.acNavFailures}</a>
  {/snippet}
</AdminShell>

<style>
.grp { display: flex; flex-direction: column; }
.grph { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; padding-bottom: 8px; border-bottom: 1px solid var(--ink); }
.h3s { font-family: var(--font-title); font-weight: 400; font-size: 21px; letter-spacing: -0.01em; }
.ckrow { display: grid; grid-template-columns: minmax(0, 2.3fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(220px, auto); gap: 10px 20px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--rule); }
.cname { font-size: 14.5px; font-weight: 600; }
.small-label { font-size: 10.5px; }
.ctl { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
.full { grid-column: 1 / -1; }
.lv { display: flex; border: 1px solid var(--rule-strong); background: var(--sheet); padding: 2px; gap: 2px; justify-self: end; }
.lv button { min-height: 40px; min-width: 64px; padding: 0 10px; border: 0; background: none; cursor: pointer; font-family: var(--font-mono); font-size: 12px; color: var(--ink); transition: background var(--t-ui), color var(--t-ui); }
.lv button:hover:not(:disabled) { background: var(--fill); }
.lv button.on { background: var(--ink); color: var(--sheet); }
.lv button.on.w { background: var(--warn-bg); color: var(--warn-ink); box-shadow: inset 0 0 0 1px var(--warn-border); }
.lv button.on.o { background: var(--fill); color: var(--ink); box-shadow: inset 0 0 0 1px var(--caption); }
.lv button:disabled:not(.on) { color: var(--caption); cursor: not-allowed; }
.lv button:disabled.on { cursor: not-allowed; }
.floorlock { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border: 1px solid var(--ink); font-family: var(--font-mono); font-size: 12px; }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
.msg.okmsg { background: var(--sheet); border-color: var(--ink); color: var(--ink); }
.flow { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); border-top: 1px solid var(--ink); }
.flow li { padding: 12px 14px 12px 0; display: flex; flex-direction: column; gap: 4px; }
.flow .n { font-family: var(--font-mono); font-size: 11px; color: var(--caption); }
.flow b { font-size: 14.5px; font-weight: 600; }
.outs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 16px; }
.outs > div { border: 1px solid var(--rule); background: var(--sheet); padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.outs .chip { align-self: flex-start; }
@media (max-width: 900px) { .ckrow { grid-template-columns: 1fr; } .lv { justify-self: start; } .ctl { justify-content: flex-start; } }
</style>
