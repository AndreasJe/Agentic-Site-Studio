<script lang="ts">
import type { Snippet } from 'svelte'
import { t } from '../lib/i18n.svelte.ts'

// The sticky bottom bar. `did` says what the AI did (the half-filled disc is its mark); the
// children are the consequence and the actions, ending with the one primary button.
let { did, children }: { did: string; children: Snippet } = $props()
</script>

<div class="decide" role="region" aria-label={t('decide.aria')}>
  <span class="did"
    ><svg class="aim" viewBox="0 0 12 12" aria-hidden="true"><use href="/icons.svg#ai-mark" /></svg
    >{did}</span
  >
  <div class="acts">{@render children()}</div>
</div>
