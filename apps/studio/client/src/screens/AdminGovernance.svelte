<script lang="ts">
// Governance (plan §13.9, §16.3, §16.4; design/prototype/AdminGovernance.dc.html; M7.10). Admin
// only. The two-person rule per action, presets that only fill it in, a change waiting for
// signatures, the security floor and the audit log. Every change is signed with passkeys under the
// CURRENT rule: lowering a rule needs as many different Admins as that rule asks for.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { session } from '../lib/session.svelte.ts'
import { type SignOptions, type SigningView, signAndSend, when } from '../lib/signing.ts'

type Policy = { releases: 1 | 2; keys: 1 | 2; domains: 1 | 2 }
type PresetName = 'small-team' | 'standard' | 'strict'
type Gov = {
  policy: Policy
  preset: PresetName | 'custom'
  presets: Record<PresetName, Policy>
  newAdminNeeds: number
  pending: ({ effect: { from?: Policy; to?: Policy } } & SigningView) | null
}
type Entry = { id: number; at: string; who: string; action: string; detail: unknown }

const PARTS = ['releases', 'keys', 'domains'] as const
const NAMES: PresetName[] = ['small-team', 'standard', 'strict']

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')
const me = $derived(session.user?.handle ?? '')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let gov = $state<Gov | null>(null)
let draft = $state<Policy>({ releases: 1, keys: 1, domains: 1 })
let audit = $state<Entry[]>([])
let busy = $state(false)
let msg = $state<{ text: string; ok: boolean } | null>(null)

async function load(resetDraft = true) {
  const [g, a] = await Promise.all([
    api<Gov>('GET', '/api/admin/governance'),
    api<{ entries: Entry[] }>('GET', '/api/admin/audit?limit=100'),
  ])
  if (!g.ok) {
    view = 'failed'
    return
  }
  gov = g.body
  if (resetDraft) draft = { ...g.body.policy }
  audit = a.ok ? (a.body.entries ?? []) : []
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const current = $derived(gov?.policy ?? draft)
const changed = $derived(PARTS.some((k) => draft[k] !== current[k]))
const raiseOnly = $derived(PARTS.every((k) => draft[k] >= current[k]))
const needed = $derived.by(() => {
  let n: number = current.keys
  for (const k of PARTS) if (draft[k] < current[k]) n = Math.max(n, current[k])
  return n
})
const presetNow = $derived.by(() => {
  const p = gov?.presets
  if (!p) return 'custom'
  return NAMES.find((n) => PARTS.every((k) => p[n][k] === draft[k])) ?? 'custom'
})
const short = (p: Policy | undefined) =>
  p ? afill(s.gvPolicyShort, { r: p.releases, k: p.keys, d: p.domains }) : ''
const label = (k: (typeof PARTS)[number]) =>
  k === 'releases' ? s.gvRuleReleases : k === 'keys' ? s.gvRuleKeys : s.gvRuleDomains
const detail = (k: (typeof PARTS)[number]) =>
  k === 'releases' ? s.gvRuleReleasesText : k === 'keys' ? s.gvRuleKeysText : s.gvRuleDomainsText

async function save() {
  if (!changed || busy) return
  busy = true
  msg = { text: s.gvSaving, ok: true }
  const r = await api<SignOptions & { code?: string }>('POST', '/api/admin/governance/policy', { policy: draft })
  if (!r.ok) {
    busy = false
    msg = { text: codeText(r.body.code), ok: false }
    return
  }
  await finish(r.body)
}

async function signPending() {
  if (!gov?.pending || busy) return
  busy = true
  msg = { text: s.gvSaving, ok: true }
  const r = await api<{ options: SignOptions | null; code?: string }>('GET', `/api/admin/signing/${gov.pending.id}`)
  if (!r.ok || !r.body.options) {
    busy = false
    msg = { text: codeText(r.body.code), ok: false }
    return
  }
  await finish(r.body.options)
}

async function finish(options: SignOptions) {
  const done = await signAndSend(options)
  busy = false
  if (!done.ok) {
    msg = { text: codeText(done.code), ok: false }
  } else {
    const sg = done.reply.body.signing
    msg =
      done.reply.body.complete
        ? { text: afill(s.gvSavedDone, { who: me }), ok: true }
        : { text: afill(s.gvSavedHalf, { who: me, n: sg?.signers.length ?? 1, m: sg?.needed ?? needed }), ok: true }
  }
  await load()
}

const conseq = $derived(
  gov?.pending && !changed
    ? s.gvConseqPending
    : !changed
      ? s.gvConseqSame
      : raiseOnly
        ? afill(s.gvConseqRaise, { n: needed })
        : afill(s.gvConseqLower, { n: needed }),
)
const detailText = (d: unknown) => {
  const t = JSON.stringify(d)
  return t.length > 140 ? `${t.slice(0, 140)}…` : t
}
</script>

<AdminShell
  heading={s.gvHeading}
  kicker={s.kicker}
  sub={s.gvSub}
  active="governance"
  did={s.gvDid}
  state={view}
>
  {#snippet head()}
    <span class="row"><span class="label">{s.gvCurrent}</span><span class="chip ok" data-testid="current-preset">{s.gvPreset[gov?.preset ?? 'custom']}</span></span>
  {/snippet}

  <section class="stack" aria-labelledby="pre-h">
    <div class="row" style="justify-content: space-between">
      <h2 id="pre-h" class="h2s">{s.gvPresetH}</h2>
      <span class="small muted">{s.gvPresetNote}</span>
    </div>
    <div class="cols3" style="gap: 16px">
      {#each NAMES as n (n)}
        <button type="button" class="choice" aria-pressed={presetNow === n} onclick={() => gov && (draft = { ...gov.presets[n] })}>
          <span class="row"><b>{s.gvPreset[n]}</b>{#if n === 'small-team'}<span class="chip">{s.gvPresetDefault}</span>{/if}{#if gov?.preset === n}<span class="chip ok">{s.gvPresetSelected}</span>{/if}</span>
          <span class="small">{s.gvPresetText[n]}</span>
          <span class="mono small muted">{short(gov?.presets[n])}</span>
        </button>
      {/each}
    </div>
    {#if presetNow === 'custom'}<p class="small rise"><span class="chip warn">{s.gvPreset.custom}</span></p>{/if}
  </section>

  {#if gov?.pending}
    {@const p = gov.pending}
    <section class="pending" aria-labelledby="pend-h" data-testid="pending-change">
      <b id="pend-h">{s.gvPendingH}</b>
      <span class="small">{afill(s.gvPendingFromTo, { from: short(p.effect.from), to: short(p.effect.to) })}</span>
      <span class="small">{p.signers.length ? afill(s.gvSignedSoFar, { names: p.signers.map((x) => x.adminId).join(', ') }) : s.gvSignedNone} · {afill(s.progress, { n: p.signers.length, m: p.needed })}</span>
      {#if p.signers.some((x) => x.adminId === me)}
        <span class="small">{s.gvSignedYou}</span>
      {:else}
        <div class="row"><button type="button" class="btn" disabled={busy} onclick={signPending}><Icon name="passkey" small />{s.gvSignPending}</button></div>
      {/if}
    </section>
  {/if}

  <section class="stack" style="gap: 8px" aria-labelledby="two-h">
    <h2 id="two-h" class="h2s">{s.gvRuleH}</h2>
    <p class="small muted">{s.gvRuleSub}</p>
    <div class="tblwrap">
      <table class="tbl">
        <thead><tr><th>{s.gvColAction}</th><th>{s.gvColWho}</th></tr></thead>
        <tbody>
          {#each PARTS as k (k)}
            <tr>
              <td>{label(k)}<br /><span class="small muted">{detail(k)}</span></td>
              <td>
                <div class="seg" role="group" aria-label={label(k)}>
                  <button type="button" aria-pressed={draft[k] === 1} onclick={() => (draft[k] = 1)}>{s.gvOne}</button>
                  <button type="button" aria-pressed={draft[k] === 2} onclick={() => (draft[k] = 2)}>{s.gvTwo}</button>
                </div>
              </td>
            </tr>
          {/each}
          <tr><td>{s.gvAlwaysOneText}</td><td><span class="chip"><Icon name="lock" small />{s.gvAlwaysOne}</span></td></tr>
        </tbody>
      </table>
    </div>
    <p class="small muted" data-testid="current-rule">{s.gvCurrent}: {short(gov?.policy)}</p>
    <div class="cols3" style="gap: 20px; margin-top: 8px">
      <div class="walllabel"><h3 class="label">{s.gvDefaultH}</h3><p class="small">{s.gvDefaultText}</p></div>
      <div class="walllabel"><h3 class="label">{s.gvLowerH}</h3><p class="small">{s.gvLowerText}</p></div>
      <div class="walllabel"><h3 class="label">{s.gvNewAdminH}</h3><p class="small">{afill(s.gvNewAdminText, { n: gov?.newAdminNeeds ?? 1 })}</p></div>
    </div>
    {#if msg}<p class="amsg" class:okmsg={msg.ok} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>{/if}
  </section>

  <section class="card ink" aria-labelledby="floor-h">
    <div class="card-h"><Icon name="lock" /><h2 id="floor-h" style="font-size: 16px">{s.gvFloorH}</h2><span class="small muted">{s.gvFloorNote}</span></div>
    <div class="card-b" style="gap: 0">
      {#each s.gvFloor as line (line)}<div class="lockrow"><Icon name="lock" small />{line}</div>{/each}
    </div>
  </section>

  <section class="stack" style="gap: 8px" aria-labelledby="aud-h">
    <h2 id="aud-h" class="h2s">{s.gvAuditH}</h2>
    <p class="small muted">{s.gvAuditSub}</p>
    {#if audit.length === 0}<p class="small muted">{s.gvAuditNone}</p>{:else}
      <div class="tblwrap">
        <table class="tbl" data-testid="audit">
          <thead><tr><th>{s.gvColWhen}</th><th>{s.gvColWhoDid}</th><th>{s.gvColWhat}</th></tr></thead>
          <tbody>
            {#each audit.slice(0, 50) as e (e.id)}
              <tr><td class="mono small">{when(e.at)}</td><td>{e.who}</td><td>{s.gvAudit[e.action] ?? e.action}<br /><span class="mono small muted">{detailText(e.detail)}</span></td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#snippet bar()}
    <span class="conseq">{conseq}</span>
    <button type="button" class="btn" disabled={!changed || busy} onclick={() => gov && (draft = { ...gov.policy })}>{s.gvUndo}</button>
    <button type="button" class="btn primary" disabled={!changed || busy} onclick={save}><Icon name="passkey" small />{s.gvSave}</button>
  {/snippet}
</AdminShell>
