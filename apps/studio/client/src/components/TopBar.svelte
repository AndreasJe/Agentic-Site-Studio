<script lang="ts">
import { t } from '../lib/i18n.svelte.ts'
import { link, route } from '../lib/router.svelte.ts'
import { session, signOut } from '../lib/session.svelte.ts'
import LangSwitch from './LangSwitch.svelte'

// Only screens that are built are shown (decision #41): Projects for now. Admin-only entries
// (Waiting for you, Admin panel) arrive with their screens.
let open = $state(false)
const user = $derived(session.user)
const initials = $derived((user?.name ?? '').slice(0, 2).toUpperCase())
const inProjects = $derived(route.path === '/projects' || route.path.startsWith('/p/'))
</script>

<header class="top">
  <a class="brand" href="/projects" use:link
    ><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><use href="/icons.svg#ic-brand-mark" /></svg
    >Site Studio</a
  >
  <nav class="mainnav" aria-label={t('nav.main')}>
    <a href="/projects" use:link aria-current={inProjects ? 'page' : undefined}
      >{t('nav.projects')}</a
    >
    <a href="/media" use:link aria-current={route.path === '/media' ? 'page' : undefined}
      >{t('nav.media')}</a
    >
  </nav>
  {#if user}
    <div class="top-r">
      <button
        type="button"
        class="avatar"
        aria-haspopup="true"
        aria-expanded={open}
        onclick={() => (open = !open)}><span aria-hidden="true">{initials}</span><span class="sr">{t('nav.menu')}</span></button
      >
      {#if open}
        <div class="menu" role="group" aria-label={t('nav.menu')}>
          <span class="small"
            ><b>{t('nav.signedInAs', { name: user.name })}</b><br /><span class="muted"
              >{user.role === 'admin' ? t('role.admin') : t('role.creator')}</span
            ></span
          >
          <LangSwitch />
          <button type="button" class="btn" onclick={signOut}>{t('nav.signOut')}</button>
        </div>
      {/if}
    </div>
  {/if}
</header>
