<script lang="ts">
// Brand and rules (plan §5.1-5.4; design/prototype/BrandRules.dc.html): fonts, palette, derived
// colours, contrast, motion and the version history. The guide is install-wide; Admins edit,
// Creators read. Derived colours use the same shared module as the validator (rule 11).
import { contrastRatio, deriveHex } from '@site-studio/shared/colour'
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import TopBar from '../components/TopBar.svelte'
import { api } from '../lib/api.ts'
import { bfill, bs } from '../lib/brand-strings.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Colour = { hex: string; role: string }
type Derived = { hex: string; recipe: string; use: string; pinned?: boolean }
type Motion = Record<string, Record<string, number | string>>
type Guide = {
  version: number
  fonts: string[]
  dominant: string
  colors: Record<string, Colour>
  derived: Derived[]
  motion: Motion
}
type Version = { n: number; by: string; at: string; summary: string; from: number | null }
type Overview = {
  empty: boolean
  fonts: { added: string[]; removed: string[]; dominant: { from: string; to: string } | null }
  colours: {
    added: { name: string; hex: string }[]
    removed: { name: string; hex: string }[]
    changed: { name: string; from: Colour; to: Colour }[]
  }
  derived: {
    added: Derived[]
    removed: Derived[]
    changed: { recipe: string; use: string; from: Derived; to: Derived }[]
  }
  motion: {
    added: { key: string; value: unknown }[]
    removed: { key: string; value: unknown }[]
    changed: { key: string; from: unknown; to: unknown }[]
  }
}

const s = $derived(bs())
const isAdmin = $derived(session.user?.role === 'admin')

let base = $state<Guide | null>(null)
let draft = $state<Guide | null>(null)
let version = $state(0)
let versions = $state<Version[]>([])
let affected = $state(0)
let failed = $state(false)
let busy = $state(false)
let message = $state<{ text: string; ok: boolean } | null>(null)
let problems = $state<string[]>([])
let stale = $state(false)
let overview = $state<Overview | null>(null)

// The derived-colour builder.
let pickA = $state('')
let pickB = $state('white')
let pct = $state(20)
let useFor = $state('')
let builderError = $state('')

let reduced = $state(false)
$effect(() => {
  const mq = matchMedia('(prefers-reduced-motion: reduce)')
  reduced = mq.matches
  const on = () => (reduced = mq.matches)
  mq.addEventListener('change', on)
  return () => mq.removeEventListener('change', on)
})

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

async function load() {
  const [g, v, a] = await Promise.all([
    api<{ version: number; guide: Guide }>('GET', '/api/brand/guide'),
    api<{ versions: Version[] }>('GET', '/api/brand/guide/versions'),
    api<{ projects: unknown[] }>('GET', '/api/brand/guide/affected'),
  ])
  failed = !g.ok
  if (!g.ok) return
  base = g.body.guide
  draft = clone(g.body.guide)
  version = g.body.version
  versions = v.body.versions ?? []
  affected = a.body.projects?.length ?? 0
  const names = Object.keys(draft.colors)
  if (!names.includes(pickA)) pickA = names[0] ?? ''
}
$effect(() => {
  load()
})

const dirty = $derived(!!draft && JSON.stringify(draft) !== JSON.stringify(base))
const colourNames = $derived(draft ? Object.keys(draft.colors) : [])
const mixWith = $derived(
  draft
    ? [...new Set([...colourNames, 'white', 'black'])]
    : [],
)
const recipe = $derived(`${pct}% ${pickA} + ${pickB}`)
const built = $derived(draft && pickA ? deriveHex(recipe, draft.colors) : null)

const signoff = $derived(
  (draft?.derived ?? [])
    .map((d, i) => ({ d, i, computed: draft ? deriveHex(d.recipe, draft.colors) : null }))
    .filter((x) => x.computed !== x.d.hex.toLowerCase()),
)
const needsDecision = $derived(signoff.some((x) => x.computed === null || !x.d.pinned))

const easingOk = (v: unknown) =>
  typeof v === 'string' && typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', v)
const motionBad = $derived(
  !!draft &&
    Object.entries(draft.motion.easing ?? {}).some(([, v]) => !easingOk(v)),
)

const canSave = $derived(isAdmin && dirty && !needsDecision && !motionBad && !busy)

// ---- the colours the contrast table uses ----
const swatches = $derived(
  draft
    ? [
        ...Object.entries(draft.colors).map(([name, c]) => ({ name, hex: c.hex })),
        ...draft.derived.map((d) => ({ name: d.recipe, hex: d.hex })),
      ]
    : [],
)
const ratioOf = (a: string, b: string) => contrastRatio(a, b)

function say(text: string, ok = true) {
  message = { text, ok }
}
const problem = (code: unknown) => {
  const key = `err.${String(code)}` as keyof typeof s
  return typeof s[key] === 'string' ? (s[key] as string) : s['err.other']
}

function addDerived() {
  if (!draft || !built) return
  builderError = ''
  const use = useFor.trim()
  if (!use) {
    builderError = s.useRequired
    return
  }
  if (draft.derived.some((d) => d.recipe === recipe && d.use === use)) {
    builderError = s.duplicate
    return
  }
  draft.derived.push({ hex: built, recipe, use })
  say(bfill(s.added, { recipe, hex: built }))
  useFor = ''
}

function removeDerived(i: number) {
  draft?.derived.splice(i, 1)
}

function takeOklab(i: number, computed: string | null) {
  const d = draft?.derived[i]
  if (!d || !computed) return
  d.hex = computed
  delete d.pinned
}
function pin(i: number) {
  const d = draft?.derived[i]
  if (d) d.pinned = true
}

async function save() {
  if (!draft || !canSave) return
  busy = true
  message = null
  problems = []
  stale = false
  const r = await api<{
    version?: Version
    guide?: Guide
    overview?: Overview
    code?: string
    errors?: string[]
  }>('POST', '/api/brand/guide', { guide: $state.snapshot(draft), basedOn: version })
  busy = false
  if (r.ok && r.body.version && r.body.guide) {
    overview = r.body.overview ?? null
    say(bfill(s.saved, { n: r.body.version.n }))
    await load()
    return
  }
  stale = r.body.code === 'stale'
  problems = (r.body.errors ?? []).map(String)
  say(problem(r.body.code), false)
}

async function rollback(n: number) {
  if (busy) return
  busy = true
  message = null
  const r = await api<{ version?: Version; overview?: Overview; code?: string }>(
    'POST',
    `/api/brand/guide/rollback/${n}`,
    {},
  )
  busy = false
  if (r.ok && r.body.version) {
    overview = r.body.overview ?? null
    say(bfill(s.rolledBack, { n: r.body.version.n, from: n }))
    await load()
  } else say(problem(r.body.code), false)
}

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ')
const roleName = (r: string) => s.roles[r] ?? r
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))
const unitOf = (group: string) => (group === 'durations' ? s.ms : group === 'distances' ? s.px : '')
const shown = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v))
const standardEasing = $derived(
  draft ? String(Object.values(draft.motion.easing ?? {})[0] ?? 'ease-out') : 'ease-out',
)
</script>

<div class="app">
  <TopBar />
  <main class="main" style="border-top: 1px solid var(--rule-strong)">
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{s.title}</h1>
        <p class="muted">{s.sub}</p>
      </div>
      <div class="row" style="gap: 10px">
        {#if version}<span class="chip ok">{bfill(s.version, { n: version })}</span>{/if}
        {#if dirty}<span class="chip warn">{s.unsaved}</span>{/if}
      </div>
    </div>
    <nav class="subnav" aria-label={s.sections}>
      <a href="/brand" use:link aria-current="page">{s.subRules}</a>
      {#if isAdmin}<a href="/brand/assets" use:link>{s.subAssets}</a>{/if}
    </nav>

    {#if !isAdmin}<p class="small muted">{s.readOnly}</p>{/if}
    {#if message}<p role="alert" class="msg" class:okmsg={message.ok}>{message.text}{#if stale}
        <button type="button" class="btn quiet" onclick={() => location.reload()}>{s.reload}</button>{/if}</p>{/if}
    {#if problems.length}
      <ul class="msg problems">{#each problems as p (p)}<li>{p}</li>{/each}</ul>
    {/if}
    {#if failed}<p role="alert" class="msg">{s.loadError}</p>{/if}

    {#if draft}
      <section class="sec" aria-labelledby="h-type">
        <div class="intro">
          <h2 id="h-type" class="h2s">{s.typography}</h2>
          <p class="small muted">{s.typographyNote}</p>
          <p class="small muted">{s.fontsNote}</p>
        </div>
        <div class="body">
          {#each draft.fonts as f (f)}
            <div class="fontrow">
              <div class="stack" style="gap: 4px">
                <b class="mono" style="font-weight: 500">{f}</b>
                {#if f === draft.dominant}<span class="chip ok">{s.dominantChip}</span>{/if}
              </div>
              <p class="specimen" style="font-family: '{f}', ui-sans-serif, Arial, sans-serif">{s.specimen}</p>
              {#if f !== draft.dominant && isAdmin}
                <button type="button" class="btn" onclick={() => draft && (draft.dominant = f)}
                  >{s.makeDominant}<span class="sr"> {f}</span></button
                >
              {/if}
            </div>
          {/each}
        </div>
      </section>

      <section class="sec" aria-labelledby="h-col">
        <div class="intro">
          <h2 id="h-col" class="h2s">{s.colours}</h2>
          <p class="small muted">{s.coloursNote}</p>
        </div>
        <div class="body">
          <div class="rows">
            {#each Object.entries(draft.colors) as [name, c] (name)}
              <div class="r">
                <span class="sw" style="background: {c.hex}" aria-hidden="true"></span>
                <b class="mono" style="font-weight: 500; flex: 1 1 140px">{name}</b>
                <span class="mono small">{c.hex}</span>
                <label class="sr" for="role-{name}">{s.role}: {name}</label>
                <select id="role-{name}" class="input rolesel" disabled={!isAdmin} bind:value={c.role}>
                  {#each Object.keys(s.roles) as r (r)}<option value={r}>{roleName(r)}</option>{/each}
                </select>
              </div>
            {/each}
          </div>
        </div>
      </section>

      <section class="sec" aria-labelledby="h-der">
        <div class="intro">
          <h2 id="h-der" class="h2s">{s.derived}</h2>
          <p class="small muted">{s.derivedNote}</p>
        </div>
        <div class="body">
          <div class="rows" aria-label={s.derived}>
            {#each draft.derived as d, i (d.recipe + d.use)}
              <div class="r">
                <span class="sw" style="background: {d.hex}" aria-hidden="true"></span>
                <span class="mono" style="flex: 1 1 200px">{d.recipe}</span>
                <span class="mono small">{d.hex}</span>
                <span class="chip">{d.use}</span>
                {#if d.pinned}<span class="chip warn">{s.pinnedChip}</span>{/if}
                {#if isAdmin}
                  <button type="button" class="btn quiet" onclick={() => removeDerived(i)}
                    >{s.removeDerived}<span class="sr"> {d.recipe}</span></button
                  >
                {/if}
              </div>
            {:else}
              <div class="r muted">{s.noDerived}</div>
            {/each}
          </div>

          {#if isAdmin}
            <form class="card builder" aria-labelledby="h-build" onsubmit={(e) => { e.preventDefault(); addDerived() }}>
              <div class="card-b">
                <h3 id="h-build" class="label">{s.builder}</h3>
                <div class="grid2">
                  <div class="field">
                    <label for="b-a">{s.pickA}</label>
                    <select id="b-a" class="input" bind:value={pickA}>
                      {#each colourNames as n (n)}<option value={n}>{n}</option>{/each}
                    </select>
                  </div>
                  <div class="field">
                    <label for="b-b">{s.pickB}</label>
                    <select id="b-b" class="input" bind:value={pickB}>
                      {#each mixWith as n (n)}<option value={n}>{n}</option>{/each}
                    </select>
                  </div>
                </div>
                <div class="field">
                  <label for="b-pct">{s.amount}: <b class="mono" data-testid="pct">{pct}%</b></label>
                  <input id="b-pct" class="range" type="range" min="0" max="100" step="1" bind:value={pct} />
                </div>
                <div class="live" aria-live="polite">
                  <span class="sw big" style="background: {built ?? 'transparent'}" aria-hidden="true"></span>
                  <div class="stack" style="gap: 2px">
                    <span class="small muted">{s.recipe}</span>
                    <b class="mono" data-testid="recipe" style="font-weight: 500">{recipe}</b>
                  </div>
                  <div class="stack" style="gap: 2px">
                    <span class="small muted">{s.hex}</span>
                    <b class="mono" data-testid="built-hex" style="font-weight: 500">{built ?? ''}</b>
                  </div>
                </div>
                <div class="field">
                  <label for="b-use">{s.use}</label>
                  <input id="b-use" class="input" placeholder={s.usePh} bind:value={useFor} />
                </div>
                {#if builderError}<p role="alert" class="small" style="color: var(--signal-ink)">{builderError}</p>{/if}
              </div>
              <div class="card-f">
                <button type="submit" class="btn" disabled={!built}>{s.addDerived}</button>
              </div>
            </form>
          {/if}
        </div>
      </section>

      <section class="sec" aria-labelledby="h-sign">
        <div class="intro">
          <h2 id="h-sign" class="h2s">{s.signoff}</h2>
          <p class="small muted">{s.signoffNote}</p>
        </div>
        <div class="body">
          {#if signoff.length === 0}
            <p class="muted">{s.signoffNone}</p>
          {:else}
            {#if needsDecision}<p class="small" style="color: var(--signal-ink)">{s.signoffBlock}</p>{/if}
            <div class="rows">
              {#each signoff as x (x.i)}
                <div class="r">
                  <span class="mono" style="flex: 1 1 200px">{x.d.recipe} · {x.d.use}</span>
                  <span class="mono small">{bfill(s.signoffStored, { hex: x.d.hex })}</span>
                  <span class="mono small">
                    {x.computed ? bfill(s.signoffComputed, { hex: x.computed }) : s.signoffCannot}
                  </span>
                  {#if x.d.pinned}<span class="chip warn">{s.pinnedChip}</span>{/if}
                  {#if isAdmin}
                    {#if x.computed}
                      <button type="button" class="btn" onclick={() => takeOklab(x.i, x.computed)}>{s.takeOklab}</button>
                    {/if}
                    {#if !x.d.pinned}
                      <button type="button" class="btn" onclick={() => pin(x.i)}>{s.pinOld}</button>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      <section class="sec" aria-labelledby="h-con">
        <div class="intro">
          <h2 id="h-con" class="h2s">{s.contrast}</h2>
          <p class="small muted">{s.contrastNote}</p>
          <span class="chip">{s.aa}</span>
        </div>
        <div class="body" style="overflow-x: auto" role="region" aria-label={s.contrast} tabindex="0">
          <table class="ctab">
            <caption class="sr">{s.contrast}</caption>
            <thead>
              <tr>
                <th scope="col">{s.contrastText}</th>
                {#each swatches as bg (bg.name)}<th scope="col">{bg.name}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each swatches as fg (fg.name)}
                <tr>
                  <th scope="row">{fg.name}</th>
                  {#each swatches as bg (bg.name)}
                    <td>
                      {#if fg.name === bg.name}
                        <span class="muted" aria-label="-">–</span>
                      {:else}
                        {@const r = ratioOf(fg.hex, bg.hex)}
                        <span class="cell" title={bfill(s.contrastCell, { fg: fg.name, bg: bg.name, ratio: r.toFixed(2) })}>
                          <span class="pair" style="background: {bg.hex}" aria-hidden="true"
                            ><span style="background: {fg.hex}"></span></span
                          >
                          <span class="mono small">{r.toFixed(2)}</span>
                          <span class="chip" class:sig={r < 4.5}>{r >= 4.5 ? s.aaPass : s.aaFail}</span>
                        </span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="sec" aria-labelledby="h-mot">
        <div class="intro">
          <h2 id="h-mot" class="h2s">{s.motion}</h2>
          <p class="small muted">{s.motionNote}</p>
          {#if reduced}<p class="small muted">{s.reduced}</p>{/if}
        </div>
        <div class="body">
          {#each Object.entries(draft.motion) as [group, tokens] (group)}
            <div class="stack" style="gap: 6px">
              <h3 class="label">{s.groups[group] ?? group}</h3>
              <div class="rows">
                {#each Object.keys(tokens) as key (key)}
                  <div class="r">
                    <label class="mono" for="mo-{group}-{key}" style="flex: 0 1 120px">{key}</label>
                    {#if group === 'easing'}
                      <input
                        id="mo-{group}-{key}"
                        class="input motion"
                        disabled={!isAdmin}
                        aria-invalid={!easingOk(draft.motion[group]?.[key])}
                        bind:value={tokens[key]}
                      />
                    {:else}
                      <input
                        id="mo-{group}-{key}"
                        class="input motion"
                        type="number"
                        min="0"
                        disabled={!isAdmin}
                        bind:value={tokens[key]}
                      />
                      <span class="mono small">{unitOf(group)}</span>
                    {/if}
                    {#if group === 'easing' && !easingOk(draft.motion[group]?.[key])}
                      <span class="small" style="color: var(--signal-ink)">{s.badEasing}</span>
                    {/if}
                    <span
                      class="track"
                      role="img"
                      aria-label={bfill(s.previewOf, { key })}
                      style="--d: {group === 'durations' ? num(tokens[key]) : 700}ms; --e: {group === 'easing' ? String(tokens[key]) : standardEasing}; --x: {group === 'distances' ? num(tokens[key]) : 0}px"
                    >
                      <span class="dot {group}" class:run={!reduced}></span>
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </section>

      <section class="sec" aria-labelledby="h-his" id="history">
        <div class="intro">
          <h2 id="h-his" class="h2s">{s.history}</h2>
          <p class="small muted">{s.historyNote}</p>
        </div>
        <div class="body">
          {#if overview}
            <div class="card ink rise" aria-labelledby="h-ov">
              <div class="card-b">
                <h3 id="h-ov" class="label">{s.overview}</h3>
                {#if overview.empty}
                  <p class="small muted">{s.ovNothing}</p>
                {/if}
                {#if overview.fonts.dominant}
                  <p class="small">{bfill(s.ovDominant, overview.fonts.dominant)}</p>
                {/if}
                <ul class="ov small">
                  {#each overview.fonts.added as f (f)}<li>{s.ovFonts}: {s.ovAdded} {f}</li>{/each}
                  {#each overview.fonts.removed as f (f)}<li>{s.ovFonts}: {s.ovRemoved} {f}</li>{/each}
                  {#each overview.colours.added as c (c.name)}<li>{s.ovColours}: {s.ovAdded} {c.name} {c.hex}</li>{/each}
                  {#each overview.colours.removed as c (c.name)}<li>{s.ovColours}: {s.ovRemoved} {c.name} {c.hex}</li>{/each}
                  {#each overview.colours.changed as c (c.name)}<li>{s.ovColours}: {s.ovChanged} {c.name} {c.from.hex} → {c.to.hex}</li>{/each}
                  {#each overview.derived.added as d (d.recipe + d.use)}<li>{s.ovDerived}: {s.ovAdded} {d.recipe} {d.hex}</li>{/each}
                  {#each overview.derived.removed as d (d.recipe + d.use)}<li>{s.ovDerived}: {s.ovRemoved} {d.recipe} {d.hex}</li>{/each}
                  {#each overview.derived.changed as d (d.recipe + d.use)}<li>{s.ovDerived}: {s.ovChanged} {d.recipe} {d.from.hex} → {d.to.hex}</li>{/each}
                  {#each overview.motion.added as m (m.key)}<li>{s.ovMotion}: {s.ovAdded} {m.key} {shown(m.value)}</li>{/each}
                  {#each overview.motion.removed as m (m.key)}<li>{s.ovMotion}: {s.ovRemoved} {m.key} {shown(m.value)}</li>{/each}
                  {#each overview.motion.changed as m (m.key)}<li>{s.ovMotion}: {s.ovChanged} {m.key} {shown(m.from)} → {shown(m.to)}</li>{/each}
                </ul>
              </div>
            </div>
          {/if}
          <div class="rows">
            {#each versions as v (v.n)}
              <div class="r">
                <b class="mono" style="font-weight: 500; flex: 0 0 56px">v{v.n}</b>
                <span style="flex: 1 1 220px">{v.summary}</span>
                <span class="mono small muted">{v.by} · {when(v.at)}{v.from ? ` · ${bfill(s.from, { n: v.from })}` : ''}</span>
                {#if v.n === version}
                  <span class="chip ok">{s.current}</span>
                {:else if isAdmin}
                  <button type="button" class="btn" disabled={busy} onclick={() => rollback(v.n)}
                    >{s.rollback}<span class="sr"> {v.n}</span></button
                  >
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </section>
    {/if}
  </main>
  <DecisionBar did={s.did}>
    <span class="conseq">{affected === 1 ? s.affectsOne : bfill(s.affects, { n: affected })}</span>
    <button class="btn primary" type="button" disabled={!canSave} onclick={save}
      ><Icon name="check" small />{bfill(s.save, { n: version + 1 })}</button
    >
  </DecisionBar>
</div>

<style>
.subnav { display: flex; flex-wrap: wrap; gap: 2px 4px; border-bottom: 1px solid var(--rule-strong); padding-bottom: 4px; }
.subnav a { min-height: var(--touch); display: flex; align-items: center; padding: 0 10px; text-decoration: none; font-size: 14px; color: var(--caption); }
.subnav a[aria-current="page"] { color: var(--ink); font-weight: 600; }
.sec { display: flex; flex-wrap: wrap; gap: 20px 40px; scroll-margin-top: 16px; }
.intro { flex: 1 1 240px; max-width: 300px; display: flex; flex-direction: column; gap: 10px; }
.body { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.fontrow { display: grid; grid-template-columns: minmax(150px, 200px) 1fr auto; gap: 12px 24px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--rule); }
.specimen { font-size: 20px; line-height: 1.3; margin: 0; overflow-wrap: anywhere; }
.sw { width: 36px; height: 36px; border: 1px solid var(--rule-strong); flex: none; display: inline-block; }
.sw.big { width: 56px; height: 56px; }
.rolesel { width: auto; min-width: 180px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 16px; }
.range { width: 100%; accent-color: var(--ink); min-height: var(--touch); }
.live { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; padding: 12px; background: var(--wall); border: 1px solid var(--rule); }
.ctab { border-collapse: collapse; width: 100%; font-size: 13px; }
.ctab th { font-weight: 500; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--ink); font-family: var(--font-mono); font-size: 11.5px; white-space: nowrap; }
.ctab td { padding: 6px 10px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
.cell { display: flex; align-items: center; gap: 8px; min-width: 150px; }
.pair { width: 32px; height: 32px; border: 1px solid var(--rule-strong); display: grid; place-items: center; flex: none; }
.pair span { width: 14px; height: 14px; display: block; }
.motion { width: 160px; }
.track { position: relative; height: 28px; width: 220px; max-width: 100%; border-bottom: 1px solid var(--rule-strong); margin-left: auto; }
.dot { position: absolute; left: 0; top: 6px; width: 16px; height: 16px; background: var(--site-dark-green); }
.dot.durations { animation: none; }
.dot.durations.run { animation: slide var(--d) var(--e) infinite alternate; }
.dot.easing.run { animation: slide var(--d) var(--e) infinite alternate; }
.dot.distances.run { animation: nudge 900ms ease-out infinite alternate; }
@keyframes slide { from { transform: translateX(0); } to { transform: translateX(196px); } }
@keyframes nudge { from { transform: translateX(0); } to { transform: translateX(var(--x)); } }
.ov { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.msg { border: 1px solid var(--signal); color: var(--signal-ink); padding: 8px 12px; margin: 0; }
.okmsg { border-color: var(--rule-strong); color: var(--ink); }
.problems { padding-left: 28px; }
@media (max-width: 720px) { .fontrow { grid-template-columns: 1fr; } .intro { max-width: none; } }
</style>
