<script lang="ts">
    import { ZButton, ZIcon } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';

    // The prompts the CLI predicted after the answer: a click fills the composer, the user still sends it.
    let { items, onpick }: { items: string[]; onpick: (text: string) => void } =
        $props();
</script>

<div
    class="flex flex-wrap gap-2 pt-1"
    role="group"
    aria-label="Suggested prompts"
>
    {#each items as item, index (index)}
        <ZButton
            zWave={false}
            zType="outline"
            zSize="sm"
            type="button"
            title={item}
            class="max-w-full justify-start"
            onclick={() => onpick(item)}
        >
            <ZIcon
                zType={'lucideCornerDownLeft' as ZIconName}
                class="size-3.5 shrink-0"
            />
            <span class="min-w-0 truncate">{item}</span>
        </ZButton>
    {/each}
</div>
