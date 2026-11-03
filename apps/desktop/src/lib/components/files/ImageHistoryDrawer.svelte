<script lang="ts">
    import { untrack } from 'svelte';
    import {
        ZButton,
        ZDrawer,
        ZIcon,
        ZTabs,
        createVirtualizer,
    } from '@shival99/z-ui-svelte';
    import type { ImageHistoryRun } from '../../chat/agent';
    import { fetchImageDataUrl, readImageDataUrl } from '../../chat/agent';
    import { openImages } from '../../browser/preview.svelte';
    import {
        gen,
        loadMoreHistory,
        openRun,
        clearTemporaryPromptHistory,
    } from '../../files/image-gen.svelte';
    import {
        loadImagePrompts,
        removeImagePrompt,
        type ImagePrompt,
    } from '../../files/image-prompt-library.svelte';
    import { toast } from '../../app/platform/toast';
    import DevEmpty from '../browser/DevEmpty.svelte';
    import {
        dayLabel,
        statusLabel,
        timeLabel,
    } from './image-generator-options';

    let {
        open = $bindable(false),
        onselect,
    }: { open?: boolean; onselect?: (prompt: string) => void } = $props();

    const history = $derived(gen.history);
    const activeRunId = $derived(gen.activeRunId);
    let promptLibrary = $state<ImagePrompt[]>([]);
    let expanded = $state<Record<string, boolean>>({});
    let saving = $state<Record<string, boolean>>({});
    let downloadingAll = $state(false);
    let historyTab = $state<'history' | 'used'>('history');
    let dateFilter = $state<'all' | 'day' | 'month' | 'year'>('all');
    let historyScrollTop = $state(0);

    type HistoryItem =
        | { kind: 'day'; key: string; label: string }
        | { kind: 'run'; key: string; run: ImageHistoryRun }
        | { kind: 'prompt'; key: string; prompt: ImagePrompt };
    const DAY_HEIGHT = 28;
    const RUN_HEIGHT = 78;
    const PROMPT_HEIGHT = 66;
    const dateFilterTabs = [
        { value: 'all', label: 'All' },
        { value: 'day', label: 'Day' },
        { value: 'month', label: 'Month' },
        { value: 'year', label: 'Year' },
    ];
    const historyTabs = [
        { value: 'used', label: 'Prompt used' },
        { value: 'history', label: 'Prompt history' },
    ];
    function matchesDateFilter(timestamp: number) {
        if (dateFilter === 'all') return true;
        const date = new Date(timestamp);
        const now = new Date();
        if (dateFilter === 'day')
            return date.toDateString() === now.toDateString();
        if (dateFilter === 'month')
            return (
                date.getFullYear() === now.getFullYear() &&
                date.getMonth() === now.getMonth()
            );
        return date.getFullYear() === now.getFullYear();
    }
    const historyItems = $derived.by(() => {
        const items: HistoryItem[] = [];
        let day = '';
        if (historyTab === 'used') {
            for (const run of history.filter((item) =>
                matchesDateFilter(item.created_at),
            )) {
                const label = dayLabel(run.created_at);
                if (label !== day) {
                    day = label;
                    items.push({ kind: 'day', key: `day:${label}`, label });
                }
                items.push({ kind: 'run', key: run.id, run });
            }
        } else {
            const prompts = promptLibrary.filter((item) =>
                matchesDateFilter(item.createdAt),
            );
            for (const prompt of prompts) {
                const label = dayLabel(prompt.createdAt);
                if (label !== day) {
                    day = label;
                    items.push({ kind: 'day', key: `day:${label}`, label });
                }
                items.push({
                    kind: 'prompt',
                    key: `prompt:${prompt.id}`,
                    prompt,
                });
            }
        }
        return items;
    });
    const activeTabCount = $derived(
        historyTab === 'used' ? history.length : promptLibrary.length,
    );
    // TanStack Virtual (through z-ui), as the chat uses: only the rows in view are mounted.
    let historyScroller = $state<HTMLDivElement | undefined>();
    function drawerViewport() {
        return historyScroller?.closest<HTMLElement>('.z-overlay-scroll')
            ?.firstElementChild as HTMLDivElement | null;
    }
    const historyKey = (index: number) => historyItems[index]?.key ?? index;
    const historyHeight = (index: number) => {
        const item = historyItems[index];
        if (item?.kind === 'day') return DAY_HEIGHT;
        return item?.kind === 'prompt' ? PROMPT_HEIGHT : RUN_HEIGHT;
    };
    const historyVirtualizer = createVirtualizer<
        HTMLDivElement,
        HTMLDivElement
    >({
        count: 0,
        getScrollElement: drawerViewport,
        estimateSize: historyHeight,
        getItemKey: historyKey,
        overscan: 6,
    });
    $effect(() => {
        const count = historyItems.length;
        const viewport = drawerViewport();
        untrack(() =>
            $historyVirtualizer.setOptions({
                count,
                getScrollElement: () => viewport,
                estimateSize: historyHeight,
                getItemKey: historyKey,
                overscan: 6,
            }),
        );
    });
    const historyRows = $derived($historyVirtualizer.getVirtualItems());
    const pinnedDay = $derived.by(() => {
        if (historyScrollTop <= 2) return null;
        const firstVisible = historyRows[0]?.index ?? 0;
        for (let index = firstVisible; index >= 0; index--) {
            const item = historyItems[index];
            if (item?.kind === 'day') return item.label;
        }
        return null;
    });

    $effect(() => {
        void gen.promptHistoryVersion;
        if (open)
            void loadImagePrompts().then((items) => (promptLibrary = items));
    });

    function toggle(key: string) {
        expanded[key] = !expanded[key];
    }

    function measureRow(node: HTMLDivElement) {
        $historyVirtualizer.measureElement(node);
    }

    function onHistoryScroll() {
        const viewport = drawerViewport();
        if (!viewport) return;
        historyScrollTop = viewport.scrollTop;
        if (gen.historyLoading || !gen.historyHasMore) return;
        const distanceToBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (distanceToBottom < 220) void loadMoreHistory();
    }

    $effect(() => {
        const viewport = drawerViewport();
        if (!viewport) return;
        viewport.addEventListener('scroll', onHistoryScroll, { passive: true });
        return () => viewport.removeEventListener('scroll', onHistoryScroll);
    });
    $effect(() => {
        const viewport = drawerViewport();
        if (!open || !viewport || gen.historyLoading || !gen.historyHasMore)
            return;
        if (viewport.scrollHeight <= viewport.clientHeight + 220)
            void loadMoreHistory();
    });

    function downloadText(name: string, value: string) {
        const url = URL.createObjectURL(
            new Blob([value], { type: 'text/plain;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        URL.revokeObjectURL(url);
    }

    async function downloadImage(path: string, name: string) {
        saving[name] = true;
        try {
            const src = /^https?:\/\//i.test(path)
                ? await fetchImageDataUrl(path)
                : await readImageDataUrl(path);
            const link = document.createElement('a');
            link.href = src;
            link.download = name;
            link.click();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            saving[name] = false;
        }
    }

    async function downloadRun(run: ImageHistoryRun) {
        if (!run.images.length) {
            downloadText(`image-prompt-${run.id}.txt`, run.prompt);
            return;
        }
        for (const image of run.images) {
            const extension = image.path.split('.').pop() || 'png';
            await downloadImage(
                image.path,
                `image-${run.id}-${image.variant}.${extension}`,
            );
        }
    }

    async function downloadAll() {
        if (downloadingAll) return;
        downloadingAll = true;
        try {
            for (const run of history) await downloadRun(run);
            for (const prompt of promptLibrary)
                downloadText(`image-prompt-${prompt.id}.txt`, prompt.prompt);
        } finally {
            downloadingAll = false;
        }
    }

    async function viewRun(run: ImageHistoryRun) {
        try {
            const images = await Promise.all(
                run.images.map(async (image) => ({
                    src: /^https?:\/\//i.test(image.path)
                        ? await fetchImageDataUrl(image.path)
                        : await readImageDataUrl(image.path),
                    name: `image-${run.id}-${image.variant}.png`,
                })),
            );
            if (!images.length) {
                toast.info('This run has no generated images');
                return;
            }
            open = false;
            openImages(images, 0);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    async function deletePrompt(id: string) {
        promptLibrary = await removeImagePrompt(id);
    }

    async function clearAll() {
        for (const item of promptLibrary) await removeImagePrompt(item.id);
        promptLibrary = [];
        clearTemporaryPromptHistory();
    }

    async function openHistoryRun(run: ImageHistoryRun) {
        open = false;
        onselect?.(run.prompt);
        await openRun(run);
    }

    function selectPrompt(prompt: string) {
        onselect?.(prompt);
        open = false;
    }

    function selectRun(run: ImageHistoryRun) {
        onselect?.(run.prompt);
        openHistoryRun(run);
    }
</script>

{#snippet footer()}
    <div class="flex items-center gap-2">
        <ZButton
            zWave={false}
            zType="outline"
            zSize="sm"
            class="h-8 gap-1.5 px-2.5 text-sm"
            disabled={!promptLibrary.length}
            onclick={() => void clearAll()}
        >
            <ZIcon zType="lucideTrash2" class="size-3.5" /> Clear all
        </ZButton>
        <ZButton
            zWave={false}
            zSize="sm"
            class="ml-auto h-8 gap-1.5 px-3 text-sm"
            disabled={downloadingAll ||
                (!history.length && !promptLibrary.length)}
            onclick={() => void downloadAll()}
        >
            <ZIcon zType="lucideDownload" class="size-3.5" /> Download all
        </ZButton>
    </div>
{/snippet}

{#snippet header()}
    <div class="flex w-full min-w-0 flex-col gap-3">
        <div
            class="-mx-4 flex w-[calc(100%+2rem)] min-w-0 items-center gap-2 border-b border-border px-4 pb-3 text-base font-semibold"
        >
            <ZIcon zType="lucideHistory" class="size-4 shrink-0 text-primary" />
            <span class="truncate text-base font-semibold">Image history</span>
            <span
                class="shrink-0 text-[10px] font-normal tabular-nums text-muted-foreground"
                >{activeTabCount}</span
            >
            <span class="flex-1"></span>
            <ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class="size-7! bg-muted/60! p-0!"
                aria-label="Close"
                onclick={() => (open = false)}
            >
                <ZIcon zType="lucideX" class="size-4" />
            </ZButton>
        </div>
        <ZTabs
            zTabs={historyTabs}
            zType="segmented"
            zSize="sm"
            zTabsOnly
            zNavFullWidth
            zCache={false}
            class="w-full shrink-0 [&_.z-tab-item]:flex-1 [&_.z-tab-item-label]:text-center"
            activeTab={historyTab}
            onTabChange={(value) => (historyTab = value as typeof historyTab)}
        />
        <ZTabs
            zTabs={dateFilterTabs}
            zType="segmented"
            zSize="sm"
            zTabsOnly
            zNavFullWidth
            zCache={false}
            class="w-full shrink-0 [&_.z-tab-item]:flex-1 [&_.z-tab-item-label]:text-center"
            activeTab={dateFilter}
            onTabChange={(value) => (dateFilter = value as typeof dateFilter)}
        />
    </div>
{/snippet}

<ZDrawer
    bind:open
    zPlacement="right"
    zWidth="420px"
    zFloating
    zClosable={false}
    class="image-history-drawer"
    zTitle="Image history"
    {header}
    {footer}
    zScrollMode="inner"
    zBodyClass="p-0"
>
    <div class="relative flex h-full min-h-0 flex-col">
        {#if historyItems.length === 0}
            <DevEmpty
                icon="lucideImages"
                title="No history yet"
                hint="Each run you generate is kept here."
            />
        {:else}
            <div
                bind:this={historyScroller}
                class="min-h-0 flex-1"
                aria-label="Image history"
            >
                <div class="px-3 py-2">
                    <div
                        class="relative w-full"
                        style:height="{$historyVirtualizer.getTotalSize()}px"
                    >
                        {#each historyRows as row (row.key)}
                            {@const item = historyItems[row.index]}
                            {#if item?.kind === 'day'}
                                <div
                                    class="absolute top-0 left-0 w-full"
                                    style:height="{row.size}px"
                                    style:transform="translateY({row.start}px)"
                                >
                                    <div
                                        class="flex h-full w-full items-center gap-2 px-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
                                    >
                                        <span class="shrink-0"
                                            >{item.label}</span
                                        >
                                        <span
                                            class="h-px flex-1 bg-border"
                                            aria-hidden="true"
                                        ></span>
                                    </div>
                                </div>
                            {:else if item?.kind === 'run'}
                                {@const key = `run:${item.run.id}`}
                                <div
                                    class="absolute top-0 left-0 w-full pb-1"
                                    data-index={row.index}
                                    style:transform="translateY({row.start}px)"
                                    {@attach measureRow}
                                >
                                    <div
                                        class="cursor-pointer rounded-md border bg-card/40 transition-colors hover:border-primary/50 {activeRunId ===
                                            item.run.id || expanded[key]
                                            ? 'border-primary/45 bg-primary/10'
                                            : 'border-border/70'}"
                                        role="button"
                                        tabindex="0"
                                        aria-expanded={expanded[key] ?? false}
                                        onclick={() => toggle(key)}
                                        onkeydown={(event) =>
                                            (event.key === 'Enter' ||
                                                event.key === ' ') &&
                                            toggle(key)}
                                    >
                                        <div
                                            class="flex min-w-0 items-center gap-1 px-3 py-2"
                                        >
                                            <span
                                                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                                            >
                                                {#if activeRunId === item.run.id}<ZIcon
                                                        zType="lucideCheck"
                                                        class="size-3.5 shrink-0 text-primary"
                                                    />{/if}
                                                <span
                                                    class="min-w-0 flex-1 truncate text-sm"
                                                    >{item.run.prompt}</span
                                                >
                                                <span
                                                    class="shrink-0 text-[10px] text-muted-foreground tabular-nums"
                                                    >{timeLabel(
                                                        item.run.created_at,
                                                    )}</span
                                                >
                                            </span>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                                aria-label="Select image run"
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    selectRun(item.run);
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideChevronRight"
                                                    class="size-3.5 transition-transform {expanded[
                                                        key
                                                    ]
                                                        ? 'rotate-90'
                                                        : ''}"
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                                aria-label="View generated images"
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    void viewRun(item.run);
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideImages"
                                                    class="size-3.5"
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                                aria-label="Download images"
                                                disabled={!!saving[item.run.id]}
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    void downloadRun(item.run);
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideDownload"
                                                    class="size-3.5"
                                                />
                                            </button>
                                        </div>
                                        <div
                                            class="px-3 pb-1 text-[10px] text-muted-foreground"
                                        >
                                            {item.run.models.length} model{item
                                                .run.models.length === 1
                                                ? ''
                                                : 's'} · {item.run.images
                                                .length} image{item.run.images
                                                .length === 1
                                                ? ''
                                                : 's'}{#if statusLabel(item.run.status)}
                                                · {statusLabel(
                                                    item.run.status,
                                                )}{/if}
                                        </div>
                                        <div
                                            class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none {expanded[
                                                key
                                            ]
                                                ? 'grid-rows-[1fr]'
                                                : 'grid-rows-[0fr]'}"
                                        >
                                            <div
                                                class="min-h-0 overflow-hidden"
                                            >
                                                <div
                                                    class="border-t border-border/60 px-2 py-2 text-xs leading-snug whitespace-pre-wrap text-foreground"
                                                >
                                                    {item.run.prompt}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            {:else if item?.kind === 'prompt'}
                                {@const key = `prompt:${item.prompt.id}`}
                                <div
                                    class="absolute top-0 left-0 w-full pb-1"
                                    data-index={row.index}
                                    style:transform="translateY({row.start}px)"
                                    {@attach measureRow}
                                >
                                    <div
                                        class="rounded-lg border bg-card/40 transition-colors hover:border-primary/50 {expanded[
                                            key
                                        ] ||
                                        gen.temporaryPromptHistory.includes(
                                            item.prompt.prompt,
                                        )
                                            ? 'border-primary/45 bg-primary/10'
                                            : 'border-border/70'}"
                                    >
                                        <div
                                            class="flex min-w-0 cursor-pointer items-center gap-1 px-3 py-2"
                                            role="button"
                                            tabindex="0"
                                            aria-expanded={expanded[key] ??
                                                false}
                                            onclick={() => toggle(key)}
                                            onkeydown={(event) =>
                                                (event.key === 'Enter' ||
                                                    event.key === ' ') &&
                                                toggle(key)}
                                        >
                                            <span
                                                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                                            >
                                                {#if gen.temporaryPromptHistory.includes(item.prompt.prompt)}<ZIcon
                                                        zType="lucideCheck"
                                                        class="size-3.5 shrink-0 text-primary"
                                                    />{/if}
                                                <ZIcon
                                                    zType="lucideMessageSquareText"
                                                    class="size-3.5 shrink-0 text-muted-foreground"
                                                />
                                                <span
                                                    class="min-w-0 flex-1 truncate text-sm"
                                                    >{item.prompt.prompt}</span
                                                >
                                                <span
                                                    class="shrink-0 text-[10px] tabular-nums text-muted-foreground"
                                                    >{timeLabel(
                                                        item.prompt.createdAt,
                                                    )}</span
                                                >
                                            </span>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                                aria-label="Toggle prompt details"
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    toggle(key);
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideChevronRight"
                                                    class="size-3.5 transition-transform {expanded[
                                                        key
                                                    ]
                                                        ? 'rotate-90'
                                                        : ''}"
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                                aria-label="Use prompt"
                                                title="Use prompt"
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    selectPrompt(
                                                        item.prompt.prompt,
                                                    );
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideTextCursorInput"
                                                    class="size-3.5"
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                                                aria-label="Download prompt"
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    downloadText(
                                                        `image-prompt-${item.prompt.id}.txt`,
                                                        item.prompt.prompt,
                                                    );
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideDownload"
                                                    class="size-3.5"
                                                />
                                            </button>
                                            <button
                                                type="button"
                                                class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                aria-label="Delete prompt"
                                                title="Delete prompt"
                                                onclick={(event) => {
                                                    event.stopPropagation();
                                                    void deletePrompt(
                                                        item.prompt.id,
                                                    );
                                                }}
                                            >
                                                <ZIcon
                                                    zType="lucideTrash2"
                                                    class="size-3.5"
                                                />
                                            </button>
                                        </div>
                                        <div
                                            class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none {expanded[
                                                key
                                            ]
                                                ? 'grid-rows-[1fr]'
                                                : 'grid-rows-[0fr]'}"
                                        >
                                            <div
                                                class="min-h-0 overflow-hidden"
                                            >
                                                <div
                                                    class="mx-3 border-t border-border/60 px-1 py-2 text-xs leading-snug whitespace-pre-wrap text-foreground"
                                                >
                                                    {item.prompt.prompt}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            {/if}
                        {/each}
                    </div>
                </div>
                {#if gen.historyLoading && history.length > 0}
                    <p
                        class="m-0 px-2 py-2 text-center text-[0.6875rem] text-muted-foreground"
                        aria-live="polite"
                    >
                        Loading older image history…
                    </p>
                {/if}
            </div>
            {#if pinnedDay}
                <div
                    class="pointer-events-none absolute top-0 right-3 left-3 z-30 flex h-7 items-center gap-2 border-b border-border/70 bg-background px-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase shadow-sm"
                >
                    <span class="shrink-0">{pinnedDay}</span>
                    <span class="h-px flex-1 bg-border" aria-hidden="true"
                    ></span>
                </div>
            {/if}
        {/if}
    </div>
</ZDrawer>

<style>
    :global([data-testid='z-drawer'].image-history-drawer .z-overlay-scroll) {
        --scrollbar-track-thickness: 6px;
    }
</style>
