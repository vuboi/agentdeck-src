<script lang="ts">
  import { ZIcon } from '@shival99/z-ui-svelte';
  import type { ZIconName } from '@shival99/z-ui-svelte';

  // An empty or failed state of a developer-tools pane: an icon, a line, and optionally a hint, centred.
  let { icon, title, hint = '', tone = 'muted', variant = 'default' }: { icon: string; title: string; hint?: string; tone?: 'muted' | 'error'; variant?: 'default' | 'plain' } = $props();
  const iconContainerClass = $derived(variant === 'plain' ? (tone === 'error' ? 'grid size-12 place-items-center text-destructive' : 'grid size-12 place-items-center text-muted-foreground') : `grid size-11 place-items-center rounded-full ${tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`);
  const iconSize = $derived(variant === 'plain' ? '32' : '22');
  const iconClass = $derived(variant === 'plain' ? 'size-8' : 'size-5.5');
</script>

<div class="flex h-full min-h-24 flex-col items-center justify-center gap-1.5 p-4 text-center font-sans">
  <span class={iconContainerClass}>
    <ZIcon zType={icon as ZIconName} zSize={iconSize} class={iconClass} />
  </span>
  <p class="m-0 text-sm font-medium {tone === 'error' ? 'text-destructive' : 'text-foreground'}">{title}</p>
  {#if hint}<p class="m-0 max-w-64 text-xs text-muted-foreground">{hint}</p>{/if}
</div>
