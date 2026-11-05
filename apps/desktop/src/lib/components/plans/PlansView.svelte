<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { ZButton, ZIcon } from '@shival99/z-ui-svelte';
    import type { ZDropdownMenuItem, ZIconName } from '@shival99/z-ui-svelte';
    import ProjectSelect from '../ui/ProjectSelect.svelte';
    import PickerPopover from '../ui/PickerPopover.svelte';
    import MenuButton from '../ui/MenuButton.svelte';
    import AgentLogo from '../ui/AgentLogo.svelte';
    import { workspace } from '../../chat/sessions.svelte';
    import { ago } from '../../chat/content/blocks';
    import { ticker } from '../../app/platform/clock.svelte';
    import { inTauri } from '../../app/platform/history';
    import { listen } from '../../app/platform/tauri-event';
    import { toast } from '../../app/platform/toast';
    import { TRIGGER_ON } from '../../app/ui/popover';
    import { openProjectFile } from '../../files/file-viewer.svelte';
    import { relativeTo, samePath } from '../../files/paths';
    import {
        loadPlans,
        plansCache,
        type PlanInfo,
    } from '../../plans/plans.svelte';

    type Row = { plan: PlanInfo; root: string };
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
    const loading = $derived(roots.some((root) => plansCache[root]?.loading));
    const errors = $derived(
        roots.flatMap((root) =>
            plansCache[root]?.error
                ? [{ root, error: plansCache[root].error }]
                : [],
        ),
    );
    const rows = $derived(
        roots
            .flatMap((root) =>
                (plansCache[root]?.items ?? []).map((plan) => ({ plan, root })),
            )
            .filter(({ plan }) => !status || plan.status === status),
    );
    const local = $derived(
        rows.filter(({ plan }) => !plan.id.startsWith('claude-global/')),
    );
    // Each root includes the same global directory; show each global file once in the shared section.
    const global = $derived(
        rows.filter(
            ({ plan }, index) =>
                plan.id.startsWith('claude-global/') &&
                rows.findIndex((row) => row.plan.path === plan.path) === index,
        ),
    );
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
        for (const root of roots) void loadPlans(root, true);
    }
    $effect(() => {
        const selectedRoots = roots;
        untrack(() => {
            for (const root of selectedRoots) void loadPlans(root, true);
        });
    });
    onMount(() => {
        if (!inTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<{ root: string }>('plan-changed', ({ payload }) => {
            const root = roots.find((item) => samePath(item, payload.root));
            if (root) void loadPlans(root, true);
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

    async function setStatus(row: Row, value: string) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('plans_set_status', {
                root: row.root,
                id: row.plan.id,
                status: value,
            });
            await loadPlans(row.root, true);
        } catch (error) {
            toast.error(`Could not update plan: ${String(error)}`);
        }
    }
    function menu(row: Row): ZDropdownMenuItem[] {
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
</script>

{#snippet planRow(row: Row)}
    <div class="flex items-center gap-2 border-b border-border px-2">
        <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
            onclick={() => openProjectFile(row.plan.path, row.root)}
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
                <span
                    class="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]"
                >
                    {row.plan.status} · {row.plan.done}/{row.plan.total} steps · {ago(
                        row.plan.updated,
                        ticker.min,
                    )} · {relativeTo(row.root, row.plan.path)}
                </span>
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
        class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2"
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
            class="h-7 gap-1 px-2 {filterOpen ? TRIGGER_ON : ''}"
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
    <div class="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {#each errors as item (item.root)}
            <p class="m-0 p-3 text-xs text-destructive" role="alert">
                Could not load plans for {workspace.projects.find(
                    (project) => project.path === item.root,
                )?.name ?? item.root}: {item.error}
            </p>
        {/each}
        {#if local.length === 0 && (loading || errors.length === 0)}
            <div
                class="flex flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
            >
                <ZIcon zType="lucideClipboardList" class="size-8 opacity-60" />
                <p class="m-0 max-w-56 text-sm leading-normal" role="status">
                    {loading
                        ? 'Loading plans…'
                        : 'No plans yet. Ask an agent to /plan something.'}
                </p>
            </div>
        {:else}
            {#each local as row (`${row.root}:${row.plan.id}`)}
                {@render planRow(row)}
            {/each}
        {/if}
        <details class="border-t border-border">
            <summary
                class="cursor-pointer px-2 py-2 text-xs font-medium text-muted-foreground outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
                >Claude (global)</summary
            >
            {#each global as row (row.plan.path)}
                {@render planRow(row)}
            {:else}
                <p class="m-0 px-2 py-2 text-xs text-muted-foreground">
                    No global plans.
                </p>
            {/each}
        </details>
    </div>
</div>
