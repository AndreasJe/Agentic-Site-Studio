<script lang="ts">
import { t } from '../lib/i18n.svelte.ts'
import { link } from '../lib/router.svelte.ts'
import Icon from './Icon.svelte'

let {
  id,
  name,
  current,
  tool,
}: { id: string; name: string; current: string | null; tool?: 'revisions' } = $props()

// The workflow spine (plan §3). Only revisions are built, so the steps are not links yet and
// the current step is Brief. [Real step state comes with the Brief, Structure … milestones.]
const steps = ['brief', 'structure', 'design', 'review', 'staging', 'publication'] as const
const nowStep = 'brief'
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
      {#each steps as step, i (step)}
        <li class:now={step === nowStep} aria-current={step === nowStep ? 'step' : undefined}>
          <i></i>
          <span class="sl"><span class="n">0{i + 1}</span><b>{t(`pj.${step}`)}</b></span>
          {#if step === nowStep}<small>{t('pj.now')}</small>{/if}
        </li>
      {/each}
    </ol>
  </nav>
  <div class="ptools" role="group" aria-label={t('pj.tools')}>
    <a
      class="tool"
      href="/p/{id}/revisions"
      use:link
      aria-current={tool === 'revisions' ? 'page' : undefined}
      ><Icon name="revisions" small />{t('pj.revisions')}</a
    >
  </div>
</div>
