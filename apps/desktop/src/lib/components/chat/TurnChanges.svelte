<script lang="ts">
    import { SvelteMap } from 'svelte/reactivity';
    import { slide } from 'svelte/transition';
    import { ZIcon } from '@shival99/z-ui-svelte';
    import type { Block, FileChange } from '../../chat/mock';
    import { toolOf } from '../../chat/content/blocks';
    import { openProjectFile } from '../../files/file-viewer.svelte';
    import { displayPath } from '../../files/paths';
    import { diffStyle } from '../../files/diff-style.svelte';
    import DiffLine from '../files/DiffLine.svelte';
    import DiffSplit from '../files/DiffSplit.svelte';
    import DiffHunks from '../files/DiffHunks.svelte';
    import DiffStyleButton from '../files/DiffStyleButton.svelte';

    let {
        blocks,
        projectRoot = '',
    }: { blocks: Block[]; projectRoot?: string } = $props();
    let open = $state(false);
    let selected = $state('');

    // Keep one entry per file. Cumulative provider snapshots replace earlier values; tool-level deltas are summed.
    const files = $derived.by(() => {
        const grouped = new SvelteMap<
            string,
            {
                change: FileChange;
                added: number;
                removed: number;
                deleted: boolean;
                cumulative: boolean;
            }
        >();
        for (const block of blocks) {
            if (block.kind !== 'command') continue;
            const change = block.change;
            if (!change) continue;
            const current = grouped.get(change.path);
            const deleted = toolOf(block.command) === 'Delete';
            const cumulative = change.cumulative !== false;
            grouped.set(
                change.path,
                cumulative
                    ? {
                          change,
                          added: change.added,
                          removed: change.removed,
                          deleted: deleted || (current?.deleted ?? false),
                          cumulative: true,
                      }
                    : {
                          change,
                          added: (current?.added ?? 0) + change.added,
                          removed: (current?.removed ?? 0) + change.removed,
                          deleted: deleted || (current?.deleted ?? false),
                          cumulative: false,
                      },
            );
        }
        return [...grouped.values()].sort((a, b) =>
            a.change.path.localeCompare(b.change.path),
        );
    });
    const added = $derived(files.reduce((sum, file) => sum + file.added, 0));
    const removed = $derived(
        files.reduce((sum, file) => sum + file.removed, 0),
    );

    function rows(change: FileChange) {
        const lines = (text: string) =>
            text
                ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
                : [];
        return [
            ...lines(change.before).map((text) => ({
                kind: 'del' as const,
                text,
            })),
            ...lines(change.after).map((text) => ({
                kind: 'add' as const,
                text,
            })),
        ];
    }
</script>

{#if files.length}
    <section
        class="mt-2 overflow-hidden rounded-lg border border-border bg-card text-sm shadow-[var(--shadow-card)]"
        aria-label="Files changed in this reply"
        in:slide={{ duration: 200 }}
    >
        <div class="flex items-center pr-2">
            <button
                type="button"
                class="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/50"
                aria-expanded={open}
                onclick={() => (open = !open)}
            >
                <ZIcon
                    zType="lucideGitCompare"
                    class="size-4 shrink-0 text-muted-foreground"
                />
                <span class="font-semibold"
                    >Edited {files.length}
                    {files.length === 1 ? 'file' : 'files'}</span
                >
                <span class="tabular-nums text-emerald-500">+{added}</span>
                <span class="tabular-nums text-destructive">−{removed}</span>
                <ZIcon
                    zType="lucideChevronDown"
                    class="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 {open
                        ? 'rotate-180'
                        : ''}"
                />
            </button>
            {#if open}<DiffStyleButton />{/if}
        </div>
        {#if open}
            <div
                class="overflow-hidden border-t border-border"
                transition:slide={{ duration: 200 }}
            >
                {#if diffStyle.value === 'unified'}
                    <!-- One stream: the lines of every file one after another, each file under its own heading. -->
                    <div
                        class="max-h-96 overflow-auto bg-background py-1 font-mono text-[0.6875rem] leading-relaxed"
                    >
                        {#each files as file (file.change.path)}
                            {@const label = displayPath(
                                projectRoot,
                                file.change.path,
                            )}
                            <div
                                class="sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-border bg-muted px-3 font-sans text-xs"
                            >
                                <span
                                    class="min-w-0 flex-1 truncate font-mono"
                                    title={file.change.path}>{label}</span
                                >
                                <span class="tabular-nums text-emerald-500"
                                    >+{file.added}</span
                                >
                                <span class="tabular-nums text-destructive"
                                    >−{file.removed}</span
                                >
                            </div>
                            {#if !file.change.before && !file.change.after}
                                <div class="px-3 py-2 text-muted-foreground">
                                    The provider reported the file change
                                    without preview content.
                                </div>
                            {:else}
                                {#each rows(file.change) as row, index (`${file.change.path}:${index}`)}
                                    <DiffLine {row} />
                                {/each}
                            {/if}
                        {/each}
                    </div>
                {:else}
                    {#each files as file (file.change.path)}
                        {@const label = displayPath(
                            projectRoot,
                            file.change.path,
                        )}
                        <div
                            class="border-b border-border last:border-b-0"
                            in:slide={{ duration: 180 }}
                        >
                            <div
                                class="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
                            >
                                <ZIcon
                                    zType={file.deleted
                                        ? 'lucideTrash2'
                                        : file.change.create
                                          ? 'lucideFilePlus'
                                          : 'lucideFile'}
                                    class="size-3.5 shrink-0 text-muted-foreground"
                                />
                                <button
                                    type="button"
                                    class="min-w-0 flex-1 cursor-pointer truncate text-left font-mono underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
                                    title={file.change.path}
                                    aria-label={`Open file ${label}`}
                                    onclick={() =>
                                        openProjectFile(
                                            file.change.path,
                                            projectRoot,
                                            'changes',
                                        )}>{label}</button
                                >
                                {#if diffStyle.value === 'stats'}
                                    <span
                                        class="flex shrink-0 items-center gap-2"
                                    >
                                        <span class="tabular-nums text-emerald-500"
                                            >+{file.added}</span
                                        >
                                        <span class="tabular-nums text-destructive"
                                            >−{file.removed}</span
                                        >
                                    </span>
                                {:else}
                                    <button
                                        type="button"
                                        class="flex shrink-0 cursor-pointer items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        aria-label={`Show changes for ${file.change.path}`}
                                        aria-expanded={selected ===
                                            file.change.path}
                                        onclick={() =>
                                            (selected =
                                                selected === file.change.path
                                                    ? ''
                                                    : file.change.path)}
                                    >
                                        <span class="tabular-nums text-emerald-500"
                                            >+{file.added}</span
                                        >
                                        <span class="tabular-nums text-destructive"
                                            >−{file.removed}</span
                                        >
                                        <ZIcon
                                            zType="lucideChevronRight"
                                            class="size-3 shrink-0 text-muted-foreground transition-transform {selected ===
                                            file.change.path
                                                ? 'rotate-90'
                                                : ''}"
                                        />
                                    </button>
                                {/if}
                            </div>
                            {#if diffStyle.value !== 'stats' && selected === file.change.path}
                                <div
                                    class="max-h-72 overflow-auto border-t border-border/60 bg-background"
                                    transition:slide={{ duration: 180 }}
                                >
                                    {#if !file.change.before && !file.change.after}
                                        <div
                                            class="px-3 py-2 font-sans text-sm text-muted-foreground"
                                        >
                                            The provider reported the file
                                            change without preview content.
                                        </div>
                                    {:else if diffStyle.value === 'split'}
                                        <DiffSplit rows={rows(file.change)} />
                                    {:else}
                                        <DiffHunks rows={rows(file.change)} />
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </section>
{/if}
