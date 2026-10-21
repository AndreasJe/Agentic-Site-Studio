<script lang="ts">
import { t } from '../lib/i18n.svelte.ts'
import { link } from '../lib/router.svelte.ts'
import Icon from './Icon.svelte'

let {
  id,
  name,
  current,
  tool,
  step = 'brief',
}: { id: string; name: string; current: string | null; tool?: 'revisions'; step?: 'brief' | 'structure' | 'design' | 'review' | undefined } = $props()

// The workflow spine (plan §3). Brief and Structure are links; the rest come with their milestones.
// The current step comes from the screen.
const steps = ['brief', 'structure', 'design', 'review', 'staging', 'publication'] as const
</script>

<div class="pbar">
  <div class="pname">
    <a class="ptitle" href="/p/{id}" use:link>{name}</a>
    <span class="pids"
      ><span class="id">{id}</span>{#if current}<span class="id">{current}</span>{/if}</span
    >
  </div>
  <nav class="spine" aria-label={t('pj.workflow')}>
    <ol>
      {#each steps as s, i (s)}
        <li class:now={s === step}>
          <i></i>
          {#if s === 'brief' || s === 'structure' || s === 'design' || s === 'review'}<a class="st" href="/p/{id}/{s}" use:link aria-current={s === step ? 'step' : undefined}><span class="sl"><span class="n">0{i + 1}</span><b>{t(`pj.${s}`)}</b></span>{#if s === step}<small>{t('pj.now')}</small>{/if}</a>
          {:else}<span class="st"><span class="sl"><span class="n">0{i + 1}</span><b>{t(`pj.${s}`)}</b></span></span>{/if}
        </li>
      {/each}
    </ol>
  </nav>
  <div class="ptools" role="group" aria-label={t('pj.tools')}>
    <a class="tool" href="/p/{id}/structure" use:link><Icon name="structure" small />{t('pj.sitemap')}</a>
    <a
      class="tool"
      href="/p/{id}/revisions"
      use:link
      aria-current={tool === 'revisions' ? 'page' : undefined}
      ><Icon name="revisions" small />{t('pj.revisions')}</a
    >
  </div>
</div>
