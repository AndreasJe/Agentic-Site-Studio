<script lang="ts">
// The custom sprite (public/icons.svg). Decorative: the visible label carries the meaning.
let { name, small = false }: { name: string; small?: boolean } = $props()
</script>

<svg class="ic" class:sm={small} viewBox="0 0 20 20" aria-hidden="true"
  ><use href="/icons.svg#ic-{name}" /></svg
>
