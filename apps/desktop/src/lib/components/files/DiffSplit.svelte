<script lang="ts">
    import type { DiffRow } from '../../files/diff';

    // The old file on the left, the new file on the right, a removed line facing the added line that replaced it.
    // Lines that only changed side (a block of removals with no additions) leave the other side empty.
    let { rows }: { rows: DiffRow[] } = $props();

    type Pair =
        | { kind: 'hunk'; text: string }
        | { kind: 'line'; left?: DiffRow; right?: DiffRow };

    const pairs = $derived.by(() => {
        const out: Pair[] = [];
        let removed: DiffRow[] = [];
        let added: DiffRow[] = [];
        const flush = () => {
            const count = Math.max(removed.length, added.length);
            for (let at = 0; at < count; at++)
                out.push({ kind: 'line', left: removed[at], right: added[at] });
            removed = [];
            added = [];
        };
        for (const row of rows) {
            if (row.kind === 'del') removed.push(row);
            else if (row.kind === 'add') added.push(row);
            else {
                flush();
                if (row.kind === 'hunk')
                    out.push({ kind: 'hunk', text: row.text });
                else out.push({ kind: 'line', left: row, right: row });
            }
        }
        flush();
        return out;
    });
</script>

{#snippet cell(row: DiffRow | undefined, side: 'left' | 'right')}
    {@const number = row ? (side === 'left' ? row.old : row.now) : undefined}
    {@const changed = row !== undefined && row.kind !== 'ctx'}
    <div
        class="flex min-w-0 whitespace-pre-wrap break-all {row === undefined
            ? 'bg-muted/40'
            : changed
              ? side === 'left'
                  ? 'bg-red-500/15'
                  : 'bg-emerald-500/15'
              : ''}"
    >
        <span
            class="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none"
            >{number ?? ''}</span
        >
        <span class="min-w-0 flex-1 pr-2">{row?.text ?? ''}</span>
    </div>
{/snippet}

<div class="min-h-full bg-background font-mono text-sm leading-5">
    {#each pairs as pair, index (index)}
        {#if pair.kind === 'hunk'}
            <div
                class="bg-primary/10 px-3 whitespace-pre-wrap text-muted-foreground"
            >
                {pair.text}
            </div>
        {:else}
            <div class="grid grid-cols-2 divide-x divide-border">
                {@render cell(pair.left, 'left')}
                {@render cell(pair.right, 'right')}
            </div>
        {/if}
    {/each}
</div>
