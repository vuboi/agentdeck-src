<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { ZIcon, type ZIconName } from '@shival99/z-ui-svelte';
    import { groupHunks, type DiffRow } from '../../files/diff';
    import DiffLine from './DiffLine.svelte';

    // A list of the hunks with their counts. A hunk opens on click to show its lines.
    let { rows }: { rows: DiffRow[] } = $props();
    const hunks = $derived(groupHunks(rows));
    const opened = new SvelteSet<number>();

    function toggle(index: number) {
        if (opened.has(index)) opened.delete(index);
        else opened.add(index);
    }
</script>

<div class="font-mono text-sm leading-5">
    {#each hunks as hunk, index (index)}
        <div class="border-b border-border last:border-b-0">
            <button
                type="button"
                class="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left outline-none hover:bg-primary/10"
                aria-expanded={opened.has(index)}
                onclick={() => toggle(index)}
            >
                <ZIcon
                    zType={(opened.has(index)
                        ? 'lucideChevronDown'
                        : 'lucideChevronRight') as ZIconName}
                    class="size-3.5 shrink-0 text-muted-foreground"
                />
                <span
                    class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                    >{hunk.header || 'Change'}</span
                >
                <span class="tabular-nums text-emerald-500">+{hunk.added}</span>
                <span class="tabular-nums text-red-500">−{hunk.removed}</span>
            </button>
            {#if opened.has(index)}
                <div class="overflow-x-auto pb-1">
                    {#each hunk.rows as row, line (line)}
                        <DiffLine {row} />
                    {/each}
                </div>
            {/if}
        </div>
    {/each}
</div>
