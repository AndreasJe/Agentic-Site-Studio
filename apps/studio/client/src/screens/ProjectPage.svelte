<script lang="ts">
// The frame for everything under /p/:project: top bar, project bar, then the screen.
import Icon from '../components/Icon.svelte'
import ProjectBar from '../components/ProjectBar.svelte'
import TopBar from '../components/TopBar.svelte'
import { api } from '../lib/api.ts'
import { t } from '../lib/i18n.svelte.ts'
import { link } from '../lib/router.svelte.ts'
import Brief from './Brief.svelte'
import DesignEditor from './DesignEditor.svelte'
import DesignOverview from './DesignOverview.svelte'
import NewPage from './NewPage.svelte'
import Review from './Review.svelte'
import Revisions from './Revisions.svelte'
import Structure from './Structure.svelte'

let {
  id,
  tab,
  artboard = 0,
  rev,
}: {
  id: string
  tab: 'home' | 'revisions' | 'brief' | 'structure' | 'new-page' | 'design' | 'design-editor' | 'review'
  artboard?: number
  rev?: string
} = $props()

type Info = { name: string; current: string | null }
let info = $state<Info | null>(null)
let missing = $state(false)

// The project's name comes from the projects list (members only); the current revision from
// the timeline. A project you can't see answers 404 and looks the same as one that isn't there.
async function load(pid: string) {
  const [list, rev] = await Promise.all([
    api<{ projects: { id: string; name: string }[] }>('GET', '/api/projects'),
    api<{ current: string | null }>('GET', `/api/p/${pid}/revisions`),
  ])
  const project = list.body.projects?.find((p) => p.id === pid)
  if (!project || !rev.ok) {
    missing = true
    return
  }
  info = { name: project.name, current: rev.body.current }
}

$effect(() => {
  missing = false
  info = null
  load(id)
})
</script>

<div class="app">
  <TopBar />
  {#if missing}
    <main class="main">
      <p role="alert">{t('pj.notFound')}</p>
      <a class="btn" href="/projects" use:link>{t('pj.back')}</a>
    </main>
  {:else if info}
    <ProjectBar {id} name={info.name} current={info.current} tool={tab === 'revisions' ? 'revisions' : undefined} step={tab === 'structure' || tab === 'new-page' ? 'structure' : tab === 'design' || tab === 'design-editor' ? 'design' : tab === 'review' ? 'review' : 'brief'} />
    {#if tab === 'revisions'}
      <Revisions {id} current={info.current} onchange={() => load(id)} />
    {:else if tab === 'brief'}
      <Brief {id} />
    {:else if tab === 'structure'}
      <Structure {id} />
    {:else if tab === 'design'}
      <DesignOverview {id} />
    {:else if tab === 'design-editor'}
      <DesignEditor {id} {artboard} current={info.current} />
    {:else if tab === 'review'}
      <Review {id} {rev} />
    {:else if tab === 'new-page'}
      <NewPage {id} />
    {:else}
      <main class="main">
        <div class="pagehead">
          <div class="stack" style="gap: 6px">
            <h1>{info.name}</h1>
            <p class="muted">{t('pj.home.sub')}</p>
          </div>
        </div>
        <section class="card" style="max-width: 640px" aria-labelledby="home-h">
          <div class="card-h"><Icon name="revisions" /><h2 id="home-h" class="h2s">{t('pj.revisions')}</h2></div>
          <div class="card-b">
            <div class="facts">
              <div><span class="label">{t('pr.id')}</span><span class="id" style="align-self: flex-start">{id}</span></div>
              <div>
                <span class="label">{t('pj.currentRevision')}</span>
                {#if info.current}<span class="id" style="align-self: flex-start">{info.current}</span>
                {:else}<span class="muted">{t('pj.noRevision')}</span>{/if}
              </div>
            </div>
          </div>
          <div class="card-f">
            <span class="note">{t('pj.home.revisionsNote')}</span>
            <a class="btn" href="/p/{id}/revisions" use:link>{t('pj.home.revisions')}</a>
          </div>
        </section>
      </main>
    {/if}
  {/if}
</div>
