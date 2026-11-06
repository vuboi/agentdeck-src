<script lang="ts">
    import { groupHunks, type DiffRow } from '../../files/diff';
    import DiffLine from './DiffLine.svelte';

    // Each hunk is a card: its heading and counts on top, its lines under them.
    let { rows }: { rows: DiffRow[] } = $props();
    const hunks = $derived(groupHunks(rows));
</script>

<div class="flex flex-col gap-2 p-2 font-mono text-sm leading-5">
    {#each hunks as hunk, index (index)}
        <section
            class="shrink-0 overflow-hidden rounded-md border border-border"
        >
            <header
                class="flex h-7 items-center gap-2 border-b border-border bg-muted/40 px-2 font-sans text-xs"
            >
                <span
                    class="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                    >{hunk.header || 'Change'}</span
                >
                <span class="tabular-nums text-emerald-500">+{hunk.added}</span>
                <span class="tabular-nums text-red-500">−{hunk.removed}</span>
            </header>
            <div class="overflow-x-auto py-1">
                {#each hunk.rows as row, line (line)}
                    <DiffLine {row} />
                {/each}
            </div>
        </section>
    {/each}
</div>
