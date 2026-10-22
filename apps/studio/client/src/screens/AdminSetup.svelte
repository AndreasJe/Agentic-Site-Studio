<script lang="ts">
// Setup checklist (plan §22.2; design/prototype/AdminSetup.dc.html; M8.5). Admin only. Every item
// is computed by the server from real state; the screen can only look again and link to the
// place where the work is done.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Item = { id: string; done: boolean; link: string }

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let items = $state<Item[]>([])

async function load() {
  const r = await api<{ items: Item[] }>('GET', '/api/admin/setup')
  if (!r.ok) {
    view = 'failed'
    return
  }
  items = r.body.items
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const done = $derived(items.filter((i) => i.done).length)
const nameOf = (id: string) => s.suItems[id]?.[0] ?? id
</script>

<AdminShell
  heading={s.suHeading}
  kicker={s.kicker}
  sub={s.suSub}
  active="setup"
  did={s.suDid}
  state={view}
>
  <section class="sec" aria-labelledby="su-h">
    <div class="sec-h">
      <h2 id="su-h" class="h2s" data-testid="su-progress">{afill(s.suProgress, { n: done, m: items.length })}</h2>
    </div>
    <div class="m8-meter" aria-hidden="true"><i style="width: {items.length ? (done / items.length) * 100 : 0}%"></i></div>
    <ul class="rows" style="list-style: none; margin: 0; padding: 0" data-testid="su-list">
      {#each items as it (it.id)}
        <li class="m8-item">
          <span class="chip" class:ok={it.done}><Icon name={it.done ? 'check' : 'checklist'} small />{it.done ? s.suDone : s.suTodo}</span>
          <span class="m8-text"><b>{nameOf(it.id)}</b><span class="small muted">{s.suItems[it.id]?.[1] ?? ''}</span></span>
          <a class="btn quiet" href={it.link} use:link aria-label={afill(s.suOpenAria, { item: nameOf(it.id) })}>{s.suOpen}</a>
        </li>
      {/each}
    </ul>
  </section>

  {#snippet bar()}
    <span class="conseq">{s.suConseq}</span>
    <button type="button" class="btn primary" onclick={load}>{s.suRefresh}</button>
  {/snippet}
</AdminShell>
