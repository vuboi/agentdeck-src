<script lang="ts">
    import type { DiffRow } from '../../files/diff';

    // One added, removed or unchanged line with its numbers in the old and the new file. Shared by the change styles
    // that draw lines without the virtual list of DiffView.
    let { row }: { row: DiffRow } = $props();
    const tone = {
        add: 'bg-emerald-500/15',
        del: 'bg-red-500/15',
        ctx: '',
        hunk: '',
    } as const;
    const sign = { add: '+', del: '−', ctx: ' ', hunk: '' } as const;
    const gutter = {
        add: 'text-emerald-500',
        del: 'text-red-500',
        ctx: 'text-muted-foreground/60',
        hunk: '',
    } as const;
</script>

<div class="flex min-w-max whitespace-pre {tone[row.kind]}">
    <span
        class="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none"
        >{row.old ?? ''}</span
    >
    <span
        class="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none"
        >{row.now ?? ''}</span
    >
    <span
        class="w-5 shrink-0 text-center font-bold select-none {gutter[
            row.kind
        ]}">{sign[row.kind]}</span
    >
    <span class="pr-6">{row.text}</span>
</div>
