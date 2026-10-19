<script lang="ts">
import { match, navigate, route } from './lib/router.svelte.ts'
import { loadSession, session } from './lib/session.svelte.ts'
import ProjectPage from './screens/ProjectPage.svelte'
import Projects from './screens/Projects.svelte'
import SignIn from './screens/SignIn.svelte'

loadSession()

const current = $derived(match(route.path))

// Signed out: only /sign-in. Signed in: /sign-in and / go to the projects.
$effect(() => {
  if (!session.ready) return
  if (!session.user && current.name !== 'sign-in') navigate('/sign-in', true)
  else if (
    session.user &&
    (current.name === 'sign-in' || current.name === 'not-found' || route.path === '/')
  )
    navigate('/projects', true)
})
</script>

{#if session.ready}
  {#if !session.user}
    {#if current.name === 'sign-in'}<SignIn />{/if}
  {:else if current.name === 'projects'}
    <Projects />
  {:else if current.name === 'project'}
    <ProjectPage id={current.id} tab="home" />
  {:else if current.name === 'revisions'}
    <ProjectPage id={current.id} tab="revisions" />
  {/if}
{/if}
