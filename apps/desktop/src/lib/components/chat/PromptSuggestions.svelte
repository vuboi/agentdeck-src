<script lang="ts">
    import { ZButton, ZIcon } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';

    // The prompts the CLI predicted after the answer. A click sends the prompt; once one is sent, the list is a record:
    // the sent one stays marked and the others cannot be sent again.
    let {
        items,
        chosen,
        onpick,
    }: {
        items: string[];
        chosen?: number;
        onpick: (text: string, index: number) => void;
    } = $props();
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
            disabled={chosen !== undefined}
            aria-pressed={chosen === index}
            class="max-w-full justify-start {chosen === index
                ? '!opacity-100 bg-primary/15 text-primary'
                : ''}"
            onclick={() => onpick(item, index)}
        >
            <ZIcon
                zType={'lucideCornerDownLeft' as ZIconName}
                class="size-3.5 shrink-0"
            />
            <span class="min-w-0 truncate">{item}</span>
        </ZButton>
    {/each}
</div>
