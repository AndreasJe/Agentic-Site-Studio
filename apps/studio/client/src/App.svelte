<script lang="ts">
import { match, navigate, route } from './lib/router.svelte.ts'
import { loadSession, session } from './lib/session.svelte.ts'
import BrandAssets from './screens/BrandAssets.svelte'
import AddressRequest from './screens/AddressRequest.svelte'
import AdminChecks from './screens/AdminChecks.svelte'
import AdminDeployment from './screens/AdminDeployment.svelte'
import AdminGovernance from './screens/AdminGovernance.svelte'
import AdminInbox from './screens/AdminInbox.svelte'
import AdminLanguages from './screens/AdminLanguages.svelte'
import AdminMail from './screens/AdminMail.svelte'
import AdminReview from './screens/AdminReview.svelte'
import AdminUsers from './screens/AdminUsers.svelte'
import AdminFailure from './screens/AdminFailure.svelte'
import BrandRules from './screens/BrandRules.svelte'
import Media from './screens/Media.svelte'
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
  {:else if current.name === 'brand'}
    <BrandRules />
  {:else if current.name === 'brand-assets'}
    <BrandAssets />
  {:else if current.name === 'media'}
    <Media />
  {:else if current.name === 'project'}
    <ProjectPage id={current.id} tab="home" />
  {:else if current.name === 'revisions'}
    <ProjectPage id={current.id} tab="revisions" />
  {:else if current.name === 'brief'}
    <ProjectPage id={current.id} tab="brief" />
  {:else if current.name === 'structure'}
    <ProjectPage id={current.id} tab="structure" />
  {:else if current.name === 'design'}
    <ProjectPage id={current.id} tab="design" />
  {:else if current.name === 'design-editor'}
    <ProjectPage id={current.id} tab="design-editor" artboard={current.artboard} />
  {:else if current.name === 'review'}
    <ProjectPage id={current.id} tab="review" rev={current.rev} />
  {:else if current.name === 'staging'}
    <ProjectPage id={current.id} tab="staging" />
  {:else if current.name === 'admin-inbox'}
    <AdminInbox />
  {:else if current.name === 'admin-review'}
    {#key current.id}<AdminReview id={current.id} />{/key}
  {:else if current.name === 'admin-address'}
    {#key current.address}<AddressRequest project={current.project} name={current.address} />{/key}
  {:else if current.name === 'admin-deployment'}
    <AdminDeployment />
  {:else if current.name === 'admin-governance'}
    <AdminGovernance />
  {:else if current.name === 'admin-users'}
    <AdminUsers />
  {:else if current.name === 'admin-mail'}
    <AdminMail />
  {:else if current.name === 'admin-languages'}
    <AdminLanguages />
  {:else if current.name === 'admin-checks'}
    <AdminChecks />
  {:else if current.name === 'admin-failures'}
    <AdminFailure run={null} />
  {:else if current.name === 'admin-failure'}
    <AdminFailure run={current.run} />
  {:else if current.name === 'new-page'}
    <ProjectPage id={current.id} tab="new-page" />
  {/if}
{/if}
