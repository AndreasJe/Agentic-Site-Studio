<script lang="ts">
// The frame of every M7 Admin screen: top bar, page head, the Admin side nav (when `active` is
// set) and the decision bar. Admin only: anyone else sees one sentence.
import type { Snippet } from 'svelte'
import { ad } from '../lib/admin-strings.ts'
import '../lib/admin.css'
import { link } from '../lib/router.svelte.ts'
import { session } from '../lib/session.svelte.ts'
import DecisionBar from './DecisionBar.svelte'
import Icon from './Icon.svelte'
import TopBar from './TopBar.svelte'

type Props = {
  heading: string
  kicker?: string
  sub?: string
  /** Which side-nav entry is current; leave out for screens that open from Waiting for you. */
  active?: string
  did: string
  state?: 'loading' | 'ok' | 'failed'
  children: Snippet
  head?: Snippet
  bar: Snippet
}
let { heading, kicker, sub, active, did, state = 'ok', children, head, bar }: Props = $props()

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')
const entries = $derived([
  { key: 'deployment', href: '/admin/deployment', icon: 'server', label: s.navDeployment },
  { key: 'governance', href: '/admin/governance', icon: 'shield', label: s.navGovernance },
  { key: 'checks', href: '/admin/checks', icon: 'checklist', label: s.navChecks },
  { key: 'failures', href: '/admin/failures', icon: 'warn', label: s.navFailures },
  { key: 'users', href: '/admin/users', icon: 'users', label: s.navUsers },
  { key: 'mail', href: '/admin/mail', icon: 'mail', label: s.navMail },
  { key: 'backups', href: '/admin/backups', icon: 'backup', label: s.navBackups },
  { key: 'models', href: '/admin/models', icon: 'model', label: s.navModels },
  { key: 'usage', href: '/admin/usage', icon: 'chart', label: s.navUsage },
  { key: 'languages', href: '/admin/languages', icon: 'globe', label: s.navLanguages },
  { key: 'projects', href: '/admin/projects', icon: 'structure', label: s.navProjects },
  { key: 'setup', href: '/admin/setup', icon: 'checklist', label: s.navSetup },
])
</script>

<div class="app adm">
  <TopBar />
  <main class="main">
    <div class="pagehead">
      <div class="stack" style="gap: 6px">
        {#if kicker}<span class="label">{kicker}</span>{/if}
        <h1>{heading}</h1>
        {#if sub}<p class="muted" style="max-width: 760px">{sub}</p>{/if}
      </div>
      {#if head}{@render head()}{/if}
    </div>

    {#if !isAdmin}
      <p role="alert">{s.forbidden}</p>
    {:else if state === 'failed'}
      <p role="alert">{s.loadError}</p>
    {:else if state === 'loading'}
      <p class="muted" role="status">{s.loading}</p>
    {:else if active}
      <div class="split">
        <nav class="sidenav" aria-label={s.navLabel}>
          {#each entries as e (e.key)}
            <a href={e.href} use:link aria-current={active === e.key ? 'page' : undefined}
              ><Icon name={e.icon} small />{e.label}</a
            >
          {/each}
          <span class="later"><Icon name="lock" small />{s.navLater} · {s.later}</span>
        </nav>
        <div class="content">{@render children()}</div>
      </div>
    {:else}
      {@render children()}
    {/if}
  </main>

  <DecisionBar {did}>{@render bar()}</DecisionBar>
</div>
