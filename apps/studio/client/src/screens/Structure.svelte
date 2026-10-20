<script lang="ts">
// The Structure workspace (plan §10.2–10.5; design/prototype/Structure.dc.html): the tree on the
// left, menus on the right, the selected page's inheritance below. Every change goes through the
// API; the server's refusals are shown as plain messages. The AI only proposes.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import { api } from '../lib/api.ts'
import { link } from '../lib/router.svelte.ts'
import {
  hiddenBy,
  LIMITS,
  type MenuItem,
  type MenuName,
  MENUS,
  menusHolding,
  PATTERNS,
  type Page,
  type Pattern,
  pathOf,
  page as pageOf,
  type StructureView,
  treeOf,
} from '../lib/structure.ts'
import { fill, st } from '../lib/structure-strings.ts'

let { id }: { id: string } = $props()

type PageProposal = {
  title: string
  slug: string
  parent: string | null
  type: string
  placement: string
  reason: string
}
type Proposal = {
  kind: string
  root: string
  reasons: string[]
  before: MenuItem[]
  after: MenuItem[]
  pages: PageProposal[]
}

let view = $state<StructureView | null>(null)
let selected = $state<string | null>(null)
let message = $state<{ text: string; ok: boolean } | null>(null)
let msgMenu = $state<MenuName | null>(null)
let over = $state<MenuName | null>(null)
let copied = $state(false)
let target = $state<MenuName>('main')
let moveUnder = $state('')
let proposal = $state<Proposal | null>(null)
let aiBusy = $state<string | null>(null)

const s = $derived(st())
const str = $derived(view?.structure ?? null)
const sel = $derived(str && selected ? (pageOf(str, selected) ?? null) : null)
const selRoot = $derived(sel?.root ?? str?.roots[0]?.address ?? '')
const menus = $derived(str?.menus[selRoot])
const parentOf = (p: Page) => (p.parent && str ? pageOf(str, p.parent) : undefined)
const limits = $derived(str ? LIMITS[str.pattern] : null)

async function load() {
  const r = await api<StructureView>('GET', `/api/p/${id}/structure`)
  if (!r.ok) return
  view = r.body
  selected ??= r.body.structure.pages[0]?.id ?? null
}
$effect(() => {
  load()
})

type Reply = StructureView & { code?: string; message?: string }

/** One structure change. Returns true when the server accepted it. */
async function act(action: string, body: object, menu: MenuName | null = null) {
  const r = await api<Reply>('POST', `/api/p/${id}/structure/${action}`, body)
  msgMenu = menu
  if (!r.ok) {
    message = { text: r.body.message ?? s.aiFailed, ok: false }
    return false
  }
  view = r.body
  message = null
  return true
}

async function addToMenu(menu: MenuName, pageId: string | undefined) {
  const p = pageId && str ? pageOf(str, pageId) : undefined
  if (!p) return
  const ok = await act('add-to-menu', { root: selRoot, menu, page: p.id }, menu)
  if (ok) message = { text: fill(s.added, { title: p.title, menu: s.menuNames[menu] ?? menu }), ok: true }
}

function drop(e: DragEvent, menu: MenuName) {
  e.preventDefault()
  over = null
  addToMenu(menu, e.dataTransfer?.getData('text/plain') ?? '')
}

async function setHidden(p: Page, hidden: boolean) {
  await act('set-hidden', { id: p.id, hidden })
}

async function move(p: Page, parent: string | null) {
  const ok = await act('move-page', { id: p.id, parent, root: p.root })
  if (ok) message = { text: fill(s.moved, { title: p.title }), ok: true }
}

function moveIn(p: Page) {
  if (!str) return
  const sibs = str.pages.filter((x) => x.root === p.root && x.parent === p.parent)
  const prev = sibs[sibs.findIndex((x) => x.id === p.id) - 1]
  if (prev) move(p, prev.id)
}
const canIn = (p: Page) =>
  !!str &&
  str.pages.filter((x) => x.root === p.root && x.parent === p.parent).findIndex((x) => x.id === p.id) > 0
const moveOut = (p: Page) => move(p, parentOf(p)?.parent ?? null)

function belowPage(p: Page): Set<string> {
  const out = new Set<string>([p.id])
  for (let grew = true; grew; ) {
    grew = false
    for (const x of str?.pages ?? [])
      if (x.parent && out.has(x.parent) && !out.has(x.id)) {
        out.add(x.id)
        grew = true
      }
  }
  return out
}
const underOptions = $derived(
  sel && str ? str.pages.filter((x) => x.root === sel.root && !belowPage(sel).has(x.id)) : [],
)

async function copyLink(p: Page) {
  try {
    await navigator.clipboard.writeText(`https://${pathOf(str as NonNullable<typeof str>, p.id)}`)
  } catch {
    // The clipboard can be blocked; the address is also shown on the page.
  }
  copied = true
  setTimeout(() => (copied = false), 2000)
}

async function remove(p: Page) {
  if (await act('delete-page', { id: p.id })) selected = str?.roots[0]?.home ?? null
}

function aiError(status: number, body: { message?: string }) {
  return status === 503 ? s.noModel : status === 502 ? s.aiFailed : (body.message ?? s.aiFailed)
}

// Server shapes: draft and suggest-missing give { proposals: PageProposal[] }; propose-menu gives
// { root, menu, before, after, reasons }.
function normalise(kind: string, raw: Record<string, unknown>): Proposal {
  const list = (v: unknown) => (Array.isArray(v) ? v : [])
  return {
    kind,
    root: String(raw.root ?? ''),
    reasons: list(raw.reasons).map(String),
    before: list(raw.before) as MenuItem[],
    after: list(raw.after) as MenuItem[],
    pages: list(raw.proposals) as PageProposal[],
  }
}

async function ai(kind: 'draft' | 'suggest-missing' | 'propose-menu') {
  aiBusy = kind
  message = null
  const r = await api<Record<string, unknown> & { message?: string }>(
    'POST',
    `/api/p/${id}/structure/${kind}`,
    kind === 'propose-menu' ? { root: selRoot } : {},
  )
  aiBusy = null
  if (!r.ok) {
    message = { text: aiError(r.status, r.body), ok: false }
    return
  }
  proposal = normalise(kind, r.body)
}

async function applyProposal() {
  if (!proposal) return
  const body =
    proposal.kind === 'propose-menu'
      ? { menu: { root: proposal.root, after: proposal.after } }
      : { pages: proposal.pages }
  const r = await api<Reply>('POST', `/api/p/${id}/structure/apply`, body)
  if (!r.ok) {
    message = { text: r.status === 400 ? (r.body.message ?? s.aiFailed) : aiError(r.status, r.body), ok: false }
    return
  }
  proposal = null
  message = { text: s.proposalApplied, ok: true }
  view = r.body
}

async function accept(body: { ids: string[] } | { all: true }, title?: string) {
  const r = await api<Reply>('POST', `/api/p/${id}/structure/accept`, body)
  if (!r.ok) {
    message = { text: r.body.message ?? s.aiFailed, ok: false }
    return
  }
  view = r.body
  message = title ? { text: fill(s.accepted, { title }), ok: true } : null
}

async function removeItem(m: MenuName, it: MenuItem) {
  const ok = await act('remove-from-menu', { root: selRoot, menu: m, page: it.page, url: it.url }, m)
  if (ok) message = { text: fill(s.removed, { label: it.label, menu: menuName(m).toLowerCase() }), ok: true }
}

async function reorder(p: Page, direction: 'up' | 'down') {
  await act('reorder-page', { id: p.id, direction })
}
const sibsOf = (p: Page) =>
  str ? str.pages.filter((x) => x.root === p.root && x.parent === p.parent && !str.roots.some((r) => r.home === x.id)) : []
const canUp = (p: Page) => sibsOf(p).findIndex((x) => x.id === p.id) > 0
const canDown = (p: Page) => {
  const sibs = sibsOf(p)
  return sibs.findIndex((x) => x.id === p.id) < sibs.length - 1
}

const labelsOf = (items: MenuItem[]): string[] => items.flatMap((i) => [i.label, ...labelsOf(i.children ?? [])])
const isNew = (label: string) => !labelsOf(proposal?.before ?? []).includes(label)

function address(p: Page) {
  return str ? pathOf(str, p.id).replace(/\/$/, '') : ''
}
const pageTitle = (pid?: string) => (pid && str ? (pageOf(str, pid)?.title ?? pid) : '')
const menuName = (m: MenuName) => s.menuNames[m] ?? m
</script>

<main class="main">
  <div class="pagehead">
    <div class="stack" style="gap: 6px">
      <h1>{s.heading}</h1>
      <p class="muted">{s.sub}</p>
    </div>
    <span class="chip">{s.revisionChip}</span>
  </div>

  {#if message && msgMenu === null}<p role="alert" class="msg" class:okmsg={message.ok}>{message.text}</p>{/if}

  {#if view && str}
    <div class="split">
      <section class="grow stack" style="gap: 12px" aria-labelledby="tree-h">
        <div class="row" style="justify-content: space-between">
          <h2 id="tree-h" class="label">
            {s.tree} · {fill(s.treeCount, { pages: str.pages.length, roots: str.roots.length })}
          </h2>
          <span class="small muted">{s.dragHint}</span>
        </div>
        <div class="row" role="group" aria-label={s.tree}>
          <button class="btn" type="button" disabled={!!aiBusy} onclick={() => ai('draft')}
            ><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{aiBusy === 'draft' ? s.working : s.draftStructure}
            <span class="tok">{fill(s.tokens, { n: '1.8' })}</span></button
          >
          <button class="btn" type="button" disabled={!!aiBusy} onclick={() => ai('suggest-missing')}
            ><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{aiBusy === 'suggest-missing' ? s.working : s.suggestMissing}
            <span class="tok">{fill(s.tokens, { n: '0.9' })}</span></button
          >
          <button class="btn" type="button" disabled={!!aiBusy} onclick={() => ai('propose-menu')}
            ><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{aiBusy === 'propose-menu' ? s.working : s.proposeMenu}
            <span class="tok">{fill(s.tokens, { n: '1.2' })}</span></button
          >
        </div>

        {#if proposal}
          <section class="card ink rise" aria-labelledby="prop-h">
            <div class="card-h">
              <span class="chip"><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg>{s.proposedByAi}</span>
            </div>
            <div class="card-b">
              <h2 id="prop-h" class="sr">{s.proposedByAi}</h2>
              {#if proposal.before.length || proposal.after.length}
                <div class="ba">
                  {#each [{ k: s.before, items: proposal.before }, { k: s.after, items: proposal.after }] as col (col.k)}
                    <div class="stack" style="gap: 8px">
                      <span class="label">{col.k}</span>
                      <ul class="minibar" aria-label={col.k}>
                        {#each col.items as it (it.label)}
                          <li class:newit={col.k === s.after && isNew(it.label)}>
                            {it.label}{#if col.k === s.after && isNew(it.label)} <span class="mono small">new</span>{/if}
                            {#if it.children?.length}<ul>{#each it.children as c (c.label)}<li>{c.label}</li>{/each}</ul>{/if}
                          </li>
                        {/each}
                      </ul>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if proposal.pages.length}
                <ul>{#each proposal.pages as pg (pg.slug + pg.parent)}<li><b>{pg.title}</b> <span class="mono small">/{pg.slug}</span>{#if pg.reason} <span class="small muted">{pg.reason}</span>{/if}</li>{/each}</ul>
              {/if}
              {#each proposal.reasons as r (r)}<p class="small muted">{s.reason}: {r}</p>{/each}
            </div>
            <div class="card-f">
              <span class="note">{s.proposalNote}</span>
              <button class="btn quiet" type="button" onclick={() => (proposal = null)}>{s.notNow}</button>
              <button class="btn primary" type="button" onclick={applyProposal}>{s.apply}</button>
            </div>
          </section>
        {/if}

        {#if str.pages.some((p) => p.status === 'proposed')}
          <div class="row"><button class="btn" type="button" onclick={() => accept({ all: true })}>{s.acceptAll}</button></div>
        {/if}

        {#each str.roots as root (root.address)}
          {@const pending = str.addressRequests.some((r) => r.status === 'pending' && pageOf(str, r.pageId)?.root === root.address)}
          <div class="rootrow">
            <Icon name="globe" />
            <span class="serif">{root.address}</span>
            <span class="chip">{root.address === str.roots[0]?.address ? s.mainSite : s.otherAddress}</span>
            {#if pending}<span class="chip warn">{s.pending}</span>{/if}
          </div>
          <ul class="tree" aria-label={root.address}>
            {#each treeOf(str, root.address) as n (n.page.id)}
              {@const p = n.page}
              <li>
                <div class="node d{n.depth}" class:sel={selected === p.id} draggable="true" role="presentation"
                  ondragstart={(e) => { e.dataTransfer?.setData('text/plain', p.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy' }}>
                  <span class="grip" aria-hidden="true"><Icon name="drag-handle" small /></span>
                  <span class="num">{n.num}</span>
                  <button class="nodebtn" type="button" aria-pressed={selected === p.id} onclick={() => { selected = p.id; target = 'main'; message = null }}>
                    <b>{p.title}</b><span class="url">{address(p)}</span>
                  </button>
                  <span class="meta">
                    <span class="ptype">{s.types[p.type]}</span>
                    <span class="place">
                      {#if p.placement === 'menu'}<Icon name="structure" small />{:else if p.placement === 'hidden'}<Icon name="hidden" small />{:else}<Icon name="globe" small />{/if}
                      {s.placementShort[p.placement]}
                    </span>
                    <span class="chip">{s.status[p.status]}</span>
                    {#if p.placement === 'hidden'}
                      <button class="btn copy" type="button" onclick={() => copyLink(p)}><Icon name="link" small />{copied && selected === p.id ? s.copied : s.copyLink}</button>
                    {/if}
                  </span>
                </div>
              </li>
            {/each}
          </ul>
        {/each}
      </section>

      <aside class="side stack" style="gap: 24px; flex-basis: 420px">
        <section class="stack" style="gap: 10px" aria-labelledby="pat-h">
          <h2 id="pat-h" class="label">{s.pattern}</h2>
          <div class="pats" role="group" aria-label={s.pattern}>
            {#each PATTERNS as pat (pat)}
              <button class="pat" class:on={str.pattern === pat} type="button" aria-pressed={str.pattern === pat}
                onclick={() => act('set-pattern', { pattern: pat satisfies Pattern })}>
                <b>{s.patterns[pat]}</b>
                <span>{fill(s.patternNote, { depth: LIMITS[pat].main.depth, items: LIMITS[pat].main.items })}</span>
              </button>
            {/each}
          </div>
          <p class="small muted">{s.patternHelp}</p>
        </section>

        <h2 class="label">{fill(s.menusFor, { address: selRoot })}</h2>
        {#each MENUS as m (m)}
          {@const items = menus?.[m] ?? []}
          <section class="stack" style="gap: 10px" aria-label={menuName(m)}>
            <div class="row" style="justify-content: space-between">
              <h3 class="label">{menuName(m)}</h3>
              <span class="mono small">{fill(s.menuCount, { n: items.length, max: limits?.[m].items ?? 0 })}</span>
            </div>
            <div class="drop" class:over={over === m} role="group" aria-label={fill(s.dropAria, { menu: menuName(m) })}
              ondragover={(e) => { e.preventDefault(); over = m }} ondragleave={() => (over = null)} ondrop={(e) => drop(e, m)}>
              {#each items as it, i (it.label + i)}
                <div class="mi"><Icon name="link" small /><span class="mlabel">{it.label}</span><span class="tgt">{it.page ? address(pageOf(str, it.page) ?? sel ?? str.pages[0]!) : it.url}</span>
                  <button class="btn quiet" type="button" aria-label={fill(s.removeItemAria, { label: it.label, menu: menuName(m).toLowerCase() })} onclick={() => removeItem(m, it)}>{s.removeItem}</button></div>
                {#each it.children ?? [] as c (c.label)}<span class="subline">{c.label} · {s.submenu}</span>{/each}
              {/each}
              <span class="small muted" style="text-align: center; padding: 6px">{s.dropHere}</span>
            </div>
            {#if message && msgMenu === m}<p role="alert" class="msg" class:okmsg={message.ok}>{message.text}</p>{/if}
          </section>
        {/each}
      </aside>
    </div>

    {#if sel}
      {@const hb = hiddenBy(str, sel.id)}
      {@const holding = menusHolding(str, sel.id)}
      {@const isHome = str.roots.some((r) => r.home === sel.id)}
      {@const par = parentOf(sel)}
      <section class="stack" style="gap: 12px" aria-labelledby="inh-h">
        <div class="row" style="justify-content: space-between; align-items: flex-end">
          <div class="stack" style="gap: 2px">
            <span class="label">{s.inhFor}</span>
            <h2 id="inh-h" class="h2s">{sel.title} <span class="mono" style="font-size: 14px; color: var(--caption)">{address(sel)}</span></h2>
          </div>
          <div class="row">
            {#if sel.status === 'proposed'}
              <button class="btn primary" type="button" onclick={() => accept({ ids: [sel.id] }, sel.title)}>{s.accept}</button>
            {/if}
            {#if sel.placement === 'hidden'}
              <button class="btn" type="button" onclick={() => copyLink(sel)}>{copied ? s.copied : s.copyLink}</button>
            {/if}
            {#if !isHome}
              {#if sel.placement === 'hidden'}
                <button class="btn" type="button" onclick={() => setHidden(sel, false)}>{s.show}</button>
              {:else}
                <button class="btn" type="button" onclick={() => setHidden(sel, true)}>{s.hide}</button>
              {/if}
            {/if}
            <label class="sr" for="addto">{fill(s.menuToAdd, { title: sel.title })}</label>
            <select class="input" id="addto" style="width: auto; min-width: 200px" bind:value={target}>
              {#each MENUS as m (m)}<option value={m}>{menuName(m)} · {selRoot}</option>{/each}
            </select>
            <button class="btn" type="button" onclick={() => addToMenu(target, sel.id)}>{fill(s.addTo, { menu: menuName(target).toLowerCase() })}</button>
          </div>
        </div>
        <div class="inh">
          <div><span class="what">{s.inhAddress}</span><span class="val">{par ? fill(s.addrChild, { path: address(sel) }) : fill(s.addrRoot, { root: sel.root })}</span></div>
          <div><span class="what">{s.inhVisibility}</span><span class="val">{hb ? (hb.id === sel.id ? s.visHidden : fill(s.visInherited, { parent: hb.title })) : s.visVisible}</span></div>
          <div><span class="what">{s.inhMenu}</span><span class="val">{isHome ? s.menuHome : holding.length ? fill(s.menuIn, { menus: holding.map((m) => menuName(m).toLowerCase()).join(', ') }) : s.menuNone}</span></div>
          <div><span class="what">{s.inhDesign}</span><span class="val">{fill(sel.placement === 'own-address' ? s.designOwn : s.designType, { type: s.types[sel.type] ?? sel.type })}</span></div>
          <div><span class="what">{s.inhCrumbs}</span><span class="val">{[...(par ? [par.title] : []), sel.title].join(' › ')}</span><span class="dif">{s.crumbsGen}</span></div>
        </div>

        {#if !isHome}
          <div class="stack" style="gap: 8px" role="group" aria-label={fill(s.moveHeading, { title: sel.title })}>
            <h3 class="label">{fill(s.moveHeading, { title: sel.title })}</h3>
            <div class="row">
              <button class="btn" type="button" disabled={!canUp(sel)} onclick={() => reorder(sel, 'up')}>{s.moveUp}</button>
              <button class="btn" type="button" disabled={!canDown(sel)} onclick={() => reorder(sel, 'down')}>{s.moveDown}</button>
              <button class="btn" type="button" disabled={!canIn(sel)} onclick={() => moveIn(sel)}>{s.moveIn}</button>
              <button class="btn" type="button" disabled={!sel.parent} onclick={() => moveOut(sel)}>{s.moveOut}</button>
              <label class="sr" for="moveunder">{s.moveUnder}</label>
              <select class="input" id="moveunder" style="width: auto; min-width: 200px" bind:value={moveUnder}>
                <option value="">{s.moveRoot}</option>
                {#each underOptions as o (o.id)}<option value={o.id}>{o.title}</option>{/each}
              </select>
              <button class="btn" type="button" onclick={() => move(sel, moveUnder || null)}>{s.moveGo}</button>
              <button class="btn quiet" type="button" onclick={() => remove(sel)}>{s.deletePage}</button>
            </div>
            <p class="small muted">{s.moveInHelp}</p>
          </div>
        {/if}
      </section>
    {/if}

    <section class="stack" style="gap: 8px" aria-labelledby="chk-h">
      <h2 id="chk-h" class="label">{s.checks} · {s.checksNote}</h2>
      <div class="checks">
        {#if view.findings.length}
          {#each view.findings as f (f.message)}<span><Icon name="warn" small />{f.message}</span>{/each}
        {:else}
          <span><Icon name="check" small />{s.checksOk}</span>
        {/if}
      </div>
    </section>
  {/if}
</main>

<DecisionBar did={s.did}>
  <span class="conseq">{s.conseq}</span>
  <a class="btn primary" href="/p/{id}/pages/new" use:link>{s.newPage}</a>
</DecisionBar>

<style>
.tree { list-style: none; margin: 0; padding: 0; }
.rootrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 20px 0 10px; border-bottom: 1px solid var(--ink); }
.rootrow .serif { font-family: var(--font-title); font-size: 24px; line-height: 1.1; }
.node { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--rule); }
.node.sel { background: var(--sheet); outline: 1px solid var(--ink); outline-offset: -1px; }
.grip { cursor: grab; color: var(--caption); display: flex; align-items: center; min-height: 44px; padding-left: 6px; }
.num { width: 34px; font-family: var(--font-mono); font-size: 12px; color: var(--caption); flex: none; }
.node.d2 .num { width: 58px; padding-left: 24px; }
.node.d3 .num { width: 82px; padding-left: 48px; }
.node.d4 .num { width: 106px; padding-left: 72px; }
.nodebtn { flex: 1 1 200px; min-width: 0; min-height: 44px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; background: none; border: 0; padding: 0; text-align: left; cursor: pointer; }
.nodebtn:focus-visible { outline: var(--focus); outline-offset: var(--focus-offset); }
.nodebtn b { font-weight: 600; font-size: 14.5px; }
.nodebtn .url { font-family: var(--font-mono); font-size: 11.5px; color: var(--caption); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.ptype { font-size: 12.5px; color: var(--caption); min-width: 104px; }
.place { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; min-width: 122px; }
.copy { min-height: 44px; padding: 0 10px; font-size: 13px; }
.inh { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); border-top: 1px solid var(--ink); }
.inh > div { padding: 14px 16px 14px 0; border-bottom: 1px solid var(--rule); display: flex; flex-direction: column; gap: 6px; }
.inh .what { font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--caption); }
.inh .val { font-size: 14px; }
.inh .dif { font-size: 12.5px; color: var(--caption); }
.pats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 6px; }
.pat { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 58px; padding: 8px 12px; border: 1px solid var(--rule-strong); background: var(--sheet); cursor: pointer; text-align: left; }
.pat b { font-size: 13.5px; font-weight: 600; }
.pat span { font-family: var(--font-mono); font-size: 11px; color: var(--caption); }
.pat.on { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.drop { border: 1px dashed var(--quiet); padding: 10px; display: flex; flex-direction: column; gap: 6px; background: var(--wall); }
.drop.over { background: var(--sheet); border-color: var(--ink); border-style: solid; }
.mi { display: flex; align-items: center; gap: 8px; background: var(--sheet); border: 1px solid var(--rule); padding: 8px 10px; }
.mi .mlabel { flex: 1 1 auto; font-size: 14px; }
.mi .tgt { font-family: var(--font-mono); font-size: 11px; color: var(--caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
.subline { font-size: 12.5px; color: var(--caption); padding: 2px 0 4px 34px; }
.ba { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 12px; }
.minibar { list-style: none; margin: 0; background: #fff; border: 1px solid var(--rule); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
.minibar ul { padding-left: 16px; }
.minibar li.newit { border-bottom: 2px solid var(--ink); }
.checks { display: flex; flex-direction: column; border-top: 1px solid var(--rule); }
.checks span { display: flex; gap: 8px; align-items: center; font-size: 13px; padding: 7px 0; border-bottom: 1px solid var(--rule); }
.msg { font-size: 13px; padding: 8px 10px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-ink); }
.msg.okmsg { background: var(--sheet); border-color: var(--ink); color: var(--ink); }
</style>
