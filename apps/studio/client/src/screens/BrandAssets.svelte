<script lang="ts">
// Brand assets, lean (plan §5.5; design/prototype/BrandAssets.dc.html): the logo with recolouring
// limited to guide colours, and the locked header and footer partials. Variants, lockups and
// exports come later.
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import TopBar from '../components/TopBar.svelte'
import { api, upload } from '../lib/api.ts'
import { bfill, bs } from '../lib/brand-strings.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Part = { index: number; tag: string; fill: string; via: string }
type Logo = { id: number; hash: string; filename: string; parts: Part[]; recipe: Record<string, string> }
type Guide = { colors: Record<string, { hex: string }>; derived: { hex: string; recipe: string }[] }
type PartialName = 'header' | 'footer'
type Issue = { rule: string; message: string }
type PartialState = {
  html: string
  version: number | null
  versions: { n: number; by: string; at: string }[]
  errors: Issue[]
  noNav: boolean
  message: string
}

const s = $derived(bs())
const isAdmin = $derived(session.user?.role === 'admin')

let guide = $state<Guide | null>(null)
let logo = $state<Logo | null>(null)
let recipe = $state<Record<string, string>>({})
let stamp = $state(0)
let busy = $state(false)
let loaded = $state(false)
let message = $state<{ text: string; ok: boolean } | null>(null)
let fileInput: HTMLInputElement | undefined = $state()

const blank = (): PartialState => ({ html: '', version: null, versions: [], errors: [], noNav: false, message: '' })
let partials = $state<Record<PartialName, PartialState>>({ header: blank(), footer: blank() })

const options = $derived([
  ...Object.keys(guide?.colors ?? {}).map((n) => ({ name: n, hex: guide?.colors[n]?.hex ?? '' })),
  ...(guide?.derived ?? []).map((d) => ({ name: d.recipe, hex: d.hex })),
])
const dirty = $derived(!!logo && JSON.stringify(recipe) !== JSON.stringify(logo.recipe))

async function loadPartial(name: PartialName, v?: number) {
  const r = await api<{ html: string; version: number | null; versions: PartialState['versions'] }>(
    'GET',
    `/api/brand/partials/${name}${v ? `?v=${v}` : ''}`,
  )
  if (r.ok) partials[name] = { ...blank(), html: r.body.html, version: r.body.version, versions: r.body.versions }
}

async function load() {
  const [g, l] = await Promise.all([
    api<{ guide: Guide }>('GET', '/api/brand/guide'),
    api<{ logo: Logo | null }>('GET', '/api/brand/logo'),
  ])
  guide = g.body.guide ?? null
  logo = l.body.logo ?? null
  recipe = { ...(logo?.recipe ?? {}) }
  loaded = true
  if (isAdmin) await Promise.all([loadPartial('header'), loadPartial('footer')])
}
$effect(() => {
  void isAdmin
  load()
})

function say(text: string, ok = true) {
  message = { text, ok }
}
const problem = (code: unknown) => {
  const key = `aerr.${String(code)}` as keyof typeof s
  return typeof s[key] === 'string' ? (s[key] as string) : s['aerr.other']
}

async function send(files: FileList | null) {
  const file = files?.[0]
  if (!file || !isAdmin || busy) return
  busy = true
  message = null
  const f = new FormData()
  f.append('file', file)
  const r = await upload<{ logo?: Logo; code?: string }>('/api/brand/logo', f)
  busy = false
  if (fileInput) fileInput.value = ''
  if (r.ok && r.body.logo) {
    logo = r.body.logo
    recipe = {}
    stamp++
    say(bfill(s.logoUploaded, { name: file.name }))
  } else say(`${file.name}: ${problem(r.body.code)}`, false)
}

function choose(index: number, name: string) {
  if (name) recipe[String(index)] = name
  else delete recipe[String(index)]
}

async function saveColours() {
  if (!logo || !dirty || busy) return
  busy = true
  message = null
  const r = await api<{ logo?: Logo; code?: string }>('PUT', `/api/brand/logo/${logo.id}/recipe`, {
    recipe: $state.snapshot(recipe),
  })
  busy = false
  if (r.ok && r.body.logo) {
    logo = r.body.logo
    stamp++
    say(s.coloursSaved)
  } else say(problem(r.body.code), false)
}

async function savePartial(name: PartialName) {
  const p = partials[name]
  if (busy) return
  busy = true
  p.errors = []
  p.noNav = false
  p.message = ''
  const r = await api<{ version?: number; code?: string; errors?: Issue[] }>(
    'PUT',
    `/api/brand/partials/${name}`,
    { html: p.html },
  )
  busy = false
  if (r.ok && r.body.version) {
    await loadPartial(name)
    partials[name].message = bfill(s.partialSaved, { name: s[name], n: r.body.version })
    return
  }
  if (r.body.code === 'invalid-design') p.errors = r.body.errors ?? []
  else if (r.body.code === 'no-nav') p.noNav = true
  else p.message = problem(r.body.code)
}
</script>

<div class="app">
  <TopBar />
  <main class="main" style="border-top: 1px solid var(--rule-strong)">
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        <h1>{s.aTitle}</h1>
        <p class="muted">{s.aSub}</p>
      </div>
    </div>
    <nav class="subnav" aria-label={s.sections}>
      <a href="/brand" use:link>{s.subRules}</a>
      <a href="/brand/assets" use:link aria-current="page">{s.subAssets}</a>
    </nav>
    {#if !isAdmin}<p class="small muted">{s.aReadOnly}</p>{/if}
    {#if message}<p role="alert" class="msg" class:okmsg={message.ok}>{message.text}</p>{/if}

    <section class="split" aria-labelledby="h-logo">
      <div class="grow stack" style="gap: 20px">
        <div class="stack" style="gap: 6px">
          <h2 id="h-logo" class="h2s">{s.logo}</h2>
          <p class="small muted">{s.logoNote}</p>
        </div>
        {#if isAdmin}
          <div class="drop">
            <Icon name="upload" />
            <span class="stack" style="gap: 2px; flex: 1 1 280px"><b style="font-weight: 600">{s.logoUpload}</b></span>
            <input
              bind:this={fileInput}
              class="sr"
              type="file"
              accept="image/svg+xml,.svg"
              aria-label={s.logoUpload}
              tabindex="-1"
              onchange={() => send(fileInput?.files ?? null)}
            />
            <button class="btn" type="button" disabled={busy} onclick={() => fileInput?.click()}>{s.logoChoose}</button>
          </div>
        {/if}
        {#if logo}
          <div class="stack" style="gap: 6px">
            <span class="label">{s.logoPreview}</span>
            <div class="preview"><img src="/api/brand/logo/{logo.id}/preview?v={stamp}" alt={s.logoPreview} /></div>
          </div>
          <div class="stack" style="gap: 6px">
            <h3 class="label">{s.parts}</h3>
            <p class="small muted">{s.partsNote}</p>
            <div class="rows">
              {#each logo.parts as p (p.index)}
                <div class="r">
                  <span class="sw" style="background: {p.fill}" aria-hidden="true"></span>
                  <span class="mono small" style="flex: 1 1 200px">{bfill(s.partLabel, { n: p.index + 1, tag: p.tag })} · {bfill(s.originalFill, { fill: p.fill })}</span>
                  <label class="sr" for="part-{p.index}">{bfill(s.partLabel, { n: p.index + 1, tag: p.tag })}</label>
                  <select
                    id="part-{p.index}"
                    class="input colsel"
                    disabled={!isAdmin}
                    value={recipe[String(p.index)] ?? ''}
                    onchange={(e) => choose(p.index, e.currentTarget.value)}
                  >
                    <option value="">{s.keepOriginal}</option>
                    {#each options as o (o.name)}<option value={o.name}>{o.name} {o.hex}</option>{/each}
                  </select>
                </div>
              {:else}
                <div class="r muted">{s.partsNone}</div>
              {/each}
            </div>
          </div>
        {:else if loaded}
          <p class="muted">{s.logoNone}</p>
        {/if}
      </div>
    </section>

    {#if isAdmin}
      <section class="stack" style="gap: 20px" aria-labelledby="h-par">
        <div class="stack" style="gap: 6px">
          <h2 id="h-par" class="h2s">{s.partials}</h2>
          <p class="small muted">{s.partialsNote}</p>
        </div>
        <div class="cols">
          {#each ['header', 'footer'] as const as name (name)}
            {@const p = partials[name]}
            <form class="card" aria-labelledby="h-{name}" onsubmit={(e) => { e.preventDefault(); savePartial(name) }}>
              <div class="card-h">
                <h3 id="h-{name}" class="label" style="margin: 0">{s[name]}</h3>
                <span class="chip">{p.version ? bfill(s.partialVersion, { n: p.version }) : s.partialNone}</span>
              </div>
              <div class="card-b">
                <div class="field">
                  <label for="html-{name}">{s.html}: {s[name]}</label>
                  <textarea id="html-{name}" class="input code" spellcheck="false" rows="10" bind:value={p.html}></textarea>
                </div>
                {#if p.noNav}<p role="alert" class="msg">{s.noNav}</p>{/if}
                {#if p.errors.length}
                  <div role="alert" class="msg">
                    <b>{s.validatorErrors}</b>
                    <ul>{#each p.errors as e (e.rule + e.message)}<li><span class="mono small">{e.rule}</span> {e.message}</li>{/each}</ul>
                  </div>
                {/if}
                {#if p.message}<p role="status" class="small">{p.message}</p>{/if}
                {#if p.versions.length > 1}
                  <div class="row">
                    {#each p.versions.slice(1) as v (v.n)}
                      <button type="button" class="btn quiet" onclick={() => loadPartial(name, v.n)}>{bfill(s.loadPartial, { n: v.n })}</button>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="card-f">
                <button type="submit" class="btn" disabled={busy || !p.html.trim()}>{bfill(s.savePartial, { name: s[name].toLowerCase() })}</button>
              </div>
            </form>
          {/each}
        </div>
      </section>
    {/if}
  </main>
  <DecisionBar did={s.logoDid}>
    <span class="conseq">{s.logoConseq}</span>
    <button class="btn primary" type="button" disabled={!isAdmin || !dirty || busy} onclick={saveColours}
      ><Icon name="check" small />{s.saveColours}</button
    >
  </DecisionBar>
</div>

<style>
.subnav { display: flex; flex-wrap: wrap; gap: 2px 4px; border-bottom: 1px solid var(--rule-strong); padding-bottom: 4px; }
.subnav a { min-height: var(--touch); display: flex; align-items: center; padding: 0 10px; text-decoration: none; font-size: 14px; color: var(--caption); }
.subnav a[aria-current="page"] { color: var(--ink); font-weight: 600; }
.drop { border: 1px dashed var(--caption); background: var(--sheet); padding: 18px 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; }
.preview { background: var(--mat); padding: 20px; display: grid; place-items: center; min-height: 160px; }
.preview img { max-width: 100%; max-height: 240px; object-fit: contain; }
.sw { width: 36px; height: 36px; border: 1px solid var(--rule-strong); flex: none; display: inline-block; }
.colsel { width: auto; min-width: 240px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 28px; }
.code { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5; min-height: 200px; }
.msg { border: 1px solid var(--signal); color: var(--signal-ink); padding: 8px 12px; margin: 0; }
.msg ul { margin: 6px 0 0; padding-left: 18px; }
.okmsg { border-color: var(--rule-strong); color: var(--ink); }
</style>
