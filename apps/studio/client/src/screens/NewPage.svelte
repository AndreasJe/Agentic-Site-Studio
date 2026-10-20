<script lang="ts">
// New page (plan §10.1, §10.3, §10.4; design/prototype/NewPage.dc.html): page type, placement,
// a mini-brief, and one chip that always says where the page will live. No AI work here.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { navigate, link } from '../lib/router.svelte.ts'
import {
  DEFAULT_PLACEMENT,
  type Placement,
  pathOf,
  type PageType,
  type StructureView,
  TYPES,
} from '../lib/structure.ts'
import { fill, st } from '../lib/structure-strings.ts'

let { id }: { id: string } = $props()

const PLACES: Placement[] = ['menu', 'hidden', 'own-address']
const RESERVED = ['www', 'api', 'admin', 'preview', 'staging', 'studio']

let view = $state<StructureView | null>(null)
let type = $state<PageType>('core')
let chosen = $state<Placement | null>(null)
let title = $state('')
let slugText = $state('')
let slugEdited = $state(false)
let parent = $state('')
let sub = $state('')
let reserve = $state(false)
let note = $state('')
let goal = $state('')
let visitorAction = $state('')
let expires = $state('')
let message = $state('')
let busy = $state(false)

const s = $derived(st())
const place = $derived(chosen ?? DEFAULT_PLACEMENT[type])
const showExpiry = $derived(type === 'campaign' || type === 'landing')
const root = $derived(view?.structure.roots[0]?.address ?? '')

async function load() {
  const r = await api<StructureView>('GET', `/api/p/${id}/structure`)
  if (r.ok) view = r.body
}
$effect(() => {
  load()
})

const slugify = (v: string) =>
  v
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
const slug = $derived(slugEdited ? slugText : slugify(title))

function pickType(t: PageType) {
  type = t
  chosen = null
  // A customer story sits under Customers when the site has such a page.
  if (t === 'customer-story' && !parent)
    parent = view?.structure.pages.find((p) => p.slug === 'customers')?.id ?? ''
}

const address = $derived.by(() => {
  if (place === 'own-address') return `${sub.trim() || '[name]'}.${root}`
  const base = view && parent ? pathOf(view.structure, parent) : `${root}/`
  return `${base.replace(/\/$/, '')}/${slug || '[slug]'}`
})

const name = $derived(sub.trim().toLowerCase())
// The name check: the server has the last word; this answers while typing.
const nameState = $derived.by((): { ok: boolean; text: string } => {
  if (!name) return { ok: false, text: s.nameType }
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, text: s.nameChars }
  const vars = { name, root }
  if (RESERVED.includes(name)) return { ok: false, text: fill(s.nameReserved, vars) }
  const taken =
    view?.structure.roots.some((r) => r.address.split('.')[0] === name) ||
    view?.structure.addressRequests.some((r) => r.name === name && r.status !== 'declined')
  return taken ? { ok: false, text: fill(s.nameTaken, vars) } : { ok: true, text: fill(s.nameFree, vars) }
})

async function create() {
  message = ''
  if (!title.trim()) return void (message = s.needTitle)
  if (type === 'campaign' && !expires) return void (message = s.needExpiry)
  if (place === 'own-address' && !nameState.ok) return void (message = nameState.text)
  busy = true
  const brief = { goal: goal.trim(), visitorAction: visitorAction.trim(), ...(expires ? { expires } : {}) }
  const r = await api<{ id?: string; message?: string }>('POST', `/api/p/${id}/structure/add-page`, {
    title,
    slug,
    type,
    placement: place,
    status: 'decided',
    ...(place === 'own-address' || !parent ? {} : { parent }),
    ...(brief.goal || brief.visitorAction || brief.expires ? { miniBrief: brief } : {}),
  })
  if (r.ok && r.body.id && place === 'own-address' && reserve) {
    const q = await api<{ message?: string }>('POST', `/api/p/${id}/structure/request-address`, {
      name,
      pageId: r.body.id,
      note,
    })
    if (!q.ok) message = q.body.message ?? ''
  }
  busy = false
  if (!r.ok) message = r.body.message ?? ''
  else if (!message) navigate(`/p/${id}/structure`)
}
</script>

<main class="main">
  <div class="pagehead">
    <div class="stack" style="gap: 6px">
      <h1>{s.npHeading}</h1>
      <p class="muted">{s.npSub}</p>
    </div>
    <span class="chip where" id="where" aria-live="polite"
      ><Icon name="globe" small />{fill(s.willLive, { address })}</span
    >
  </div>

  {#if message}<p role="alert" class="msg">{message}</p>{/if}

  <section class="step" aria-labelledby="s1-h">
    <span class="stepn" aria-hidden="true">1</span>
    <div class="stack">
      <div class="row" style="justify-content: space-between; align-items: flex-end">
        <div class="stack" style="gap: 2px">
          <h2 id="s1-h" class="h2s">{s.step1}</h2>
          <p class="small muted">{s.step1Sub}</p>
        </div>
        <div class="field" style="min-width: 260px">
          <label for="title-in">{s.workingTitle}</label>
          <input id="title-in" class="input" bind:value={title} />
        </div>
      </div>
      <div class="cards" role="group" aria-label={s.step1}>
        {#each TYPES as t (t)}
          {@const info = s.typeInfo[t]}
          <button class="tcard" class:on={type === t} type="button" aria-pressed={type === t} onclick={() => pickType(t)}>
            <b>{s.types[t]}</b>
            <span class="kv"><span>{s.freedom}</span><span>{info?.freedom}</span></span>
            <span class="kv"><span>{s.defaultPlacement}</span><span>{s.placements[DEFAULT_PLACEMENT[t]]}</span></span>
            <span class="kv"><span>{s.expires}</span><span>{info?.expires}</span></span>
            <span class="kv"><span>{s.restricted}</span><span>{info?.images}</span></span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  <section class="step" aria-labelledby="s2-h">
    <span class="stepn" aria-hidden="true">2</span>
    <div class="stack">
      <div class="stack" style="gap: 2px">
        <h2 id="s2-h" class="h2s">{s.step2}</h2>
        <p class="small muted">{s.step2Sub}</p>
      </div>
      <div class="cards" role="group" aria-label={s.placementGroup}>
        {#each PLACES as pl (pl)}
          <button class="tcard" class:on={place === pl} type="button" aria-pressed={place === pl} onclick={() => (chosen = pl)}>
            <span class="pic" aria-hidden="true"><Icon name={pl === 'menu' ? 'structure' : pl === 'hidden' ? 'hidden' : 'globe'} /></span>
            <span class="row" style="justify-content: space-between"
              ><b>{s.placements[pl]}</b>{#if DEFAULT_PLACEMENT[type] === pl}<span class="chip">{s.isDefault}</span>{/if}</span
            >
            <span class="small muted">{s.placementDesc[pl]}</span>
            <span class="mono small muted">{s.placementWho[pl]}</span>
          </button>
        {/each}
      </div>

      {#if place !== 'own-address'}
        <div class="opts">
          <div class="field">
            <label for="slug-in">{s.slug}</label>
            <input id="slug-in" class="input" value={slug} oninput={(e) => { slugText = e.currentTarget.value; slugEdited = true }} aria-describedby="slug-help" />
            <span id="slug-help" class="small muted">{s.slugHelp}</span>
          </div>
          <div class="field">
            <label for="under-in">{s.under}</label>
            <select id="under-in" class="input" bind:value={parent}>
              <option value="">{s.underNone}</option>
              {#each view?.structure.pages.filter((p) => p.root === root) ?? [] as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
            </select>
            <span class="small muted">{s.underHelp}</span>
          </div>
        </div>
      {:else}
        <div class="opts">
          <div class="field">
            <label for="sub-in">{s.suggestedName}</label>
            <div class="suffix"><input id="sub-in" class="input" bind:value={sub} aria-describedby="avail-line" /><span>.{root}</span></div>
          </div>
          <p id="avail-line" class="avail" aria-live="polite">
            <Icon name={nameState.ok ? 'check' : 'warn'} small /><span>{nameState.text}</span>
          </p>
          <p class="small muted">{s.nameApprove}</p>
          <label class="row" style="gap: 10px; cursor: pointer; min-height: 44px">
            <input type="checkbox" bind:checked={reserve} />
            <span class="stack" style="gap: 0"><b class="small">{s.reserve}</b><span class="small muted">{s.reserveSub}</span></span>
          </label>
          {#if reserve}
            <div class="field">
              <label for="note-in">{s.adminNote}</label>
              <textarea id="note-in" class="input" placeholder={s.adminNotePh} bind:value={note}></textarea>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </section>

  <section class="step" aria-labelledby="s3-h">
    <span class="stepn" aria-hidden="true">3</span>
    <div class="stack">
      <div class="stack" style="gap: 2px">
        <h2 id="s3-h" class="h2s">{s.step3}</h2>
        <p class="small muted">{s.step3Sub}</p>
      </div>
      <div class="stack" style="gap: 16px; max-width: 640px">
        <div class="field">
          <label for="goal-in">{s.goal}</label>
          <textarea id="goal-in" class="input" placeholder={s.goalPh} bind:value={goal}></textarea>
        </div>
        <div class="field">
          <label for="va-in">{s.visitorAction}</label>
          <input id="va-in" class="input" placeholder={s.visitorActionPh} bind:value={visitorAction} />
        </div>
        {#if showExpiry}
          <div class="field">
            <label for="exp-in">{s.expiry} · {type === 'campaign' ? s.expiryRequired : s.expiryOptional}</label>
            <input id="exp-in" class="input" type="date" style="max-width: 240px" bind:value={expires} />
          </div>
        {/if}
      </div>
    </div>
  </section>
</main>

<DecisionBar did={s.npDid}>
  <span class="conseq"
    >{fill(s.npConseq, { title: title.trim() || '…', address })}{place === 'own-address' ? ` ${s.npConseqOwn}` : ''}</span
  >
  <a class="btn" href="/p/{id}/structure" use:link>{s.cancel}</a>
  <button class="btn primary" type="button" disabled={busy} onclick={create}>{busy ? s.creating : s.create}</button>
</DecisionBar>

<style>
.step { display: flex; gap: 16px; align-items: flex-start; border-top: 1px solid var(--rule); padding-top: 20px; }
.stepn { font-family: var(--font-mono); font-size: 12px; border: 1px solid var(--ink); width: 28px; height: 28px; display: grid; place-items: center; flex: none; }
.step > .stack { flex: 1 1 auto; min-width: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr)); gap: 10px; }
.tcard { display: flex; flex-direction: column; align-items: stretch; gap: 8px; padding: 14px; border: 1px solid var(--rule-strong); background: var(--sheet); text-align: left; cursor: pointer; }
.tcard:focus-visible { outline: var(--focus); outline-offset: var(--focus-offset); }
.tcard.on { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.kv { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; }
.kv span:first-child { color: var(--caption); }
.pic { display: grid; place-items: center; height: 64px; background: var(--wall); border: 1px solid var(--rule); }
.opts { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--rule); background: var(--sheet); max-width: 640px; }
.suffix { display: flex; align-items: center; gap: 8px; }
.suffix span { font-family: var(--font-mono); font-size: 13px; color: var(--caption); white-space: nowrap; }
.avail { display: flex; gap: 8px; align-items: center; font-size: 13px; }
.chip.where { border-style: dashed; border-color: var(--ink); padding: 7px 10px; }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
</style>
