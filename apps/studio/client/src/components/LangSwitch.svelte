<script lang="ts">
import { i18n, type Lang, setLanguage, t } from '../lib/i18n.svelte.ts'
import { session } from '../lib/session.svelte.ts'

const langs: Lang[] = ['en', 'da']
</script>

<div class="seg" role="group" aria-label={t('lang.label')}>
  {#each langs as lang (lang)}
    <button
      type="button"
      aria-pressed={i18n.lang === lang}
      onclick={() => setLanguage(lang, !!session.user)}>{lang.toUpperCase()}</button
    >
  {/each}
</div>
