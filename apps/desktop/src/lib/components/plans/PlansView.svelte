<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { ZButton, ZIcon, createVirtualizer } from '@shival99/z-ui-svelte';
    import type { ZDropdownMenuItem, ZIconName } from '@shival99/z-ui-svelte';
    import ProjectSelect from '../ui/ProjectSelect.svelte';
    import PickerPopover, { type PickerItem } from '../ui/PickerPopover.svelte';
    import MenuButton from '../ui/MenuButton.svelte';
    import AgentLogo from '../ui/AgentLogo.svelte';
    import MarkdownPreviewModal from '../ui/MarkdownPreviewModal.svelte';
    import { workspace } from '../../chat/sessions.svelte';
    import { readProjectFile } from '../../files/files';
    import { inTauri } from '../../app/platform/history';
    import { listen } from '../../app/platform/tauri-event';
    import { toast } from '../../app/platform/toast';
    import { TRIGGER_RING } from '../../app/ui/popover';
    import { openProjectFile } from '../../files/file-viewer.svelte';
    import { samePath } from '../../files/paths';
    import {
        loadMorePlanPage,
        loadPlanPage,
        planPages,
        type PlanRow,
    } from '../../plans/plans.svelte';

    // A plan opens in a modal, as an activity log entry does: its text, and what to do with it. The text is read first,
    // so the modal opens at its full size with the content in it (not empty, then grown).
    let viewing = $state<PlanRow | null>(null);
    let viewOpen = $state(false);
    let viewText = $state('');
    let viewSeq = 0;
    async function openPlan(row: PlanRow) {
        const seq = ++viewSeq;
        try {
            const text = await readProjectFile(row.root, row.plan.path);
            if (seq !== viewSeq) return;
            viewing = row;
            viewText = text;
            viewOpen = true;
        } catch (error) {
            if (seq !== viewSeq) return;
            toast.error(`Could not open plan: ${String(error)}`);
        }
    }
    // The search button of the file view looks through the plans, by title, with the project name after it.
    let {
        findOpen = $bindable(false),
        from = null,
    }: { findOpen?: boolean; from?: HTMLElement | null } = $props();
    const findItems = $derived<PickerItem<PlanRow>[]>(
        planPages.local.items.map((row) => ({
            id: `${row.root}:${row.plan.path}`,
            label: row.plan.title,
            hint: projectName(row.root),
            icon: 'lucideFileText' as ZIconName,
            data: row,
        })),
    );
    const projectName = (root: string) =>
        workspace.projects.find((item) => item.path === root)?.name ??
        root.split(/[\\/]/).filter(Boolean).pop() ??
        root;
    const STATUSES: { value: string; label: string; icon: ZIconName }[] = [
        { value: '', label: 'All', icon: 'lucideListChecks' },
        { value: 'draft', label: 'Draft', icon: 'lucideFileText' },
        { value: 'approved', label: 'Approved', icon: 'lucideCheck' },
        { value: 'doing', label: 'Doing', icon: 'lucidePlay' },
        { value: 'done', label: 'Done', icon: 'lucideCircleCheck' },
        { value: 'dropped', label: 'Dropped', icon: 'lucideX' },
    ];
    let project = $state<string | null>(null);
    let status = $state('');
    let filterOpen = $state(false);
    let filterAnchor = $state<HTMLElement | null>(null);
    const projectOptions = $derived(
        workspace.projects.map((item) => item.path),
    );
    const roots = $derived(
        project !== null && projectOptions.includes(project)
            ? [project]
            : projectOptions,
    );
    const local = $derived(planPages.local.items);
    const loading = $derived(planPages.local.loading);
    const listError = $derived(planPages.local.error);
    const filterItems = $derived(
        STATUSES.map((item) => ({
            id: item.value,
            label: item.label,
            icon: item.icon as ZIconName,
            selected: status === item.value,
            data: item.value,
        })),
    );

    function refresh() {
        const selectedRoots = roots;
        const selectedStatus = status;
        void loadPlanPage('local', selectedRoots, selectedStatus);
    }
    $effect(() => {
        void roots;
        void status;
        untrack(refresh);
    });
    onMount(() => {
        if (!inTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<{ root: string }>('plan-changed', ({ payload }) => {
            if (roots.some((item) => samePath(item, payload.root))) refresh();
        })
            .then((stop) => {
                if (disposed) stop();
                else unlisten = stop;
            })
            .catch((error) =>
                toast.error(
                    `Could not listen for plan changes: ${String(error)}`,
                ),
            );
        return () => {
            disposed = true;
            unlisten?.();
        };
    });

    async function setStatus(row: PlanRow, value: string) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('plans_set_status', {
                root: row.root,
                id: row.plan.id,
                status: value,
            });
            refresh();
        } catch (error) {
            toast.error(`Could not update plan: ${String(error)}`);
        }
    }
    function menu(row: PlanRow): ZDropdownMenuItem[] {
        return [
            {
                label: 'Open',
                icon: 'lucideFileText',
                onClick: () => openProjectFile(row.plan.path, row.root),
            },
            {
                label: 'Copy path',
                icon: 'lucideCopy',
                onClick: () =>
                    void navigator.clipboard.writeText(row.plan.path).then(
                        () => toast.success('Path copied'),
                        () => toast.error('Could not copy path'),
                    ),
            },
            ...(!row.plan.readOnly && row.plan.status === 'draft'
                ? [
                      {
                          label: 'Approve',
                          icon: 'lucideCheck' as ZIconName,
                          onClick: () => void setStatus(row, 'approved'),
                      },
                  ]
                : []),
            ...(!row.plan.readOnly
                ? [
                      {
                          label: 'Set status',
                          icon: 'lucideListChecks' as ZIconName,
                          submenu: STATUSES.slice(2).map((item) => ({
                              label: item.label,
                              icon: item.icon,
                              checked: row.plan.status === item.value,
                              onClick: () => void setStatus(row, item.value),
                          })),
                      },
                  ]
                : []),
        ];
    }

    const ROW_HEIGHT = 48;
    const rowKey = (row: PlanRow | undefined, index: number) =>
        row ? `${row.root}:${row.plan.id}` : String(index);
    let scroller = $state<HTMLDivElement>();
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: 0,
        getScrollElement: () => scroller ?? null,
        estimateSize: () => ROW_HEIGHT,
        getItemKey: (index) => rowKey(local[index], index),
        overscan: 8,
    });
    $effect(() => {
        const count = local.length;
        const element = scroller;
        untrack(() =>
            $virtualizer.setOptions({
                count,
                getScrollElement: () => element ?? null,
                estimateSize: () => ROW_HEIGHT,
                getItemKey: (index) => rowKey(local[index], index),
                overscan: 8,
            }),
        );
    });
    const shown = $derived($virtualizer.getVirtualItems());
    const total = $derived($virtualizer.getTotalSize());
    function measureRow(node: HTMLDivElement) {
        $virtualizer.measureElement(node);
    }
    // Rows are read a page at a time: when the rendered rows reach the end of those read, read the next page.
    $effect(() => {
        const last = shown.at(-1)?.index ?? -1;
        if (last >= local.length - 10)
            untrack(() => void loadMorePlanPage('local'));
    });
</script>

{#snippet planRow(row: PlanRow)}
    <div class="flex items-center gap-2 border-b border-border px-2">
        <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
            onclick={() => void openPlan(row)}
        >
            {#if row.plan.agent}
                <AgentLogo agent={row.plan.agent} class="size-4 shrink-0" />
            {:else}
                <ZIcon
                    zType="lucideFileText"
                    class="size-4 shrink-0 text-muted-foreground"
                />
            {/if}
            <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium"
                    >{row.plan.title}</span
                >
                <span class="block truncate text-xs text-muted-foreground"
                    >{projectName(row.root)}</span
                >
            </span>
        </button>
        <MenuButton items={menu(row)} label={`Actions for ${row.plan.title}`} />
    </div>
{/snippet}

<div
    class="flex h-full min-h-0 flex-1 flex-col text-sm"
    role="tabpanel"
    aria-label="Plans"
>
    <div
        class="tool-header flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-1.5"
    >
        <ProjectSelect
            bind:value={project}
            options={projectOptions}
            label={(root) =>
                workspace.projects.find((item) => item.path === root)?.name ??
                root}
            class="min-w-0! flex-1"
        />
        <ZButton
            bind:ref={filterAnchor}
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="h-7 gap-1 px-2 {filterOpen ? TRIGGER_RING : ''}"
            aria-label="Filter plans by status"
            aria-haspopup="listbox"
            aria-expanded={filterOpen}
            onclick={() => (filterOpen = !filterOpen)}
        >
            {STATUSES.find((item) => item.value === status)?.label}
            <ZIcon zType="lucideChevronDown" class="size-3.5" />
        </ZButton>
        <PickerPopover
            anchor={filterAnchor}
            bind:open={filterOpen}
            items={filterItems}
            size="sm"
            local
            keys
            width={160}
            label="Plan status"
            position="bottom-right"
            onpick={(item) => {
                status = item.data;
                filterOpen = false;
            }}
        />
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-7! p-0"
            disabled={loading || roots.length === 0}
            aria-label="Refresh plans"
            title="Refresh plans"
            onclick={refresh}
        >
            <ZIcon zType="lucideRefreshCw" class="size-4" />
        </ZButton>
    </div>
    <div
        bind:this={scroller}
        class="min-h-0 flex-1 overflow-y-auto"
        aria-busy={loading}
    >
        {#if listError}
            <p class="m-0 p-3 text-xs text-destructive" role="alert">
                Could not load plans: {listError}
            </p>
        {/if}
        {#if local.length === 0 && (loading || !listError)}
            <div
                class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
            >
                <ZIcon
                    zType="lucideClipboardList"
                    zSize="24"
                    class="opacity-60"
                />
                <p class="m-0 max-w-56 text-sm leading-normal" role="status">
                    {loading
                        ? 'Loading plans…'
                        : 'No plans yet. Ask an agent to /plan something.'}
                </p>
            </div>
        {:else}
            <div class="relative" style:height="{total}px">
                {#each shown as item (item.key)}
                    {#if local[item.index]}
                        <div
                            class="absolute inset-x-0 top-0"
                            style:transform="translateY({item.start}px)"
                            data-index={item.index}
                            use:measureRow
                        >
                            {@render planRow(local[item.index])}
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}
    </div>
</div>

<PickerPopover
    anchor={from}
    bind:open={findOpen}
    items={findItems}
    search
    label="Find a plan"
    placeholder="Search plans by title"
    empty="No plans"
    size="sm"
    position="bottom-right"
    onpick={(item) => {
        findOpen = false;
        void openPlan(item.data);
    }}
/>

{#if viewing}<MarkdownPreviewModal
        bind:open={viewOpen}
        title={`${viewing.plan.title} · ${viewing.plan.status}`}
        text={viewText}
        name={viewing.plan.title}
        note="a project plan"
    />{/if}
