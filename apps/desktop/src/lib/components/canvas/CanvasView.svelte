<script lang="ts">
    import {
        ZButton,
        ZIcon,
        ZSelect,
        zModalService,
    } from '@shival99/z-ui-svelte';
    import type { ZDropdownMenuItem, ZIconName } from '@shival99/z-ui-svelte';
    import MenuButton from '../ui/MenuButton.svelte';
    import ProjectSelect from '../ui/ProjectSelect.svelte';
    import PickerPopover from '../ui/PickerPopover.svelte';
    import type { PickerItem } from '../ui/PickerPopover.svelte';
    import CodeView from '../files/CodeView.svelte';
    import {
        workspace,
        activeSession,
        sessionCwd,
    } from '../../chat/sessions.svelte';
    import { toast } from '../../app/platform/toast';
    import { TRIGGER_ON } from '../../app/ui/popover';
    import { joinPath } from '../../files/paths';
    import Markdown from '../ui/Markdown.svelte';
    import {
        loadArtifacts,
        loadMoreArtifacts,
        readArtifact,
        selectArtifact,
        setArtifactQuery,
        canvasState,
        type ArtifactInfo,
        type ArtifactState,
    } from '../../canvas/canvas.svelte';
    import { previewDocument } from '../../canvas/preview';

    let project: string | null = $state(null);
    let artifactOpen = $state(false);
    let artifactAnchor = $state<HTMLElement | null>(null);
    let codeMode = $state(false);
    let saving = $state(false);
    let artifactQuery = $state('');
    const activeRoot = $derived(
        activeSession() ? sessionCwd(activeSession()!) : null,
    );
    const projectOptions: string[] = $derived([
        ...new Set([
            ...workspace.projects.map((item) => item.path),
            ...(activeRoot ? [activeRoot] : []),
        ]),
    ]);
    const root: string = $derived(
        project !== null && projectOptions.includes(project)
            ? project
            : (activeRoot ?? projectOptions[0] ?? ''),
    );
    // A derived value must not write state: `stateFor` creates the entry, so it runs in the effects below instead.
    const emptyArtifacts: ArtifactState = {
        items: [],
        query: '',
        cursor: null,
        paging: false,
        selected: '',
        version: null,
        content: '',
        loading: false,
        error: '',
    };
    const artifactState = $derived(
        root ? (canvasState[root] ?? emptyArtifacts) : emptyArtifacts,
    );
    const current = $derived(
        artifactState.items.find((item) => item.id === artifactState.selected),
    );
    const version = $derived(
        current?.versions.find((item) => item.n === artifactState.version) ??
            current?.versions.at(-1),
    );
    // Header actions in visual order, which is also the order they are kept in: when the row narrows, the last ones
    // go first (refresh, then delete, ...). The ones that do not fit move into one menu.
    let actionsRoom = $state<number>();
    const ACTION_ORDER = [
        'source',
        'copy',
        'save',
        'preview',
        'delete',
        'refresh',
    ] as const;
    type ActionId = (typeof ACTION_ORDER)[number];
    // Same sizes as the tool tabs: a 32px button and the 4px gap after it. The menu button takes one slot as well.
    const GAP = 4;
    const TAB = 32 + GAP;
    const actionIds = $derived(
        ACTION_ORDER.filter(
            (id) => id !== 'preview' || current?.kind === 'html',
        ),
    );
    const keptIds = $derived.by(() => {
        // Not measured yet: show every action, as the tool tabs do.
        if (actionsRoom === undefined) return new Set<ActionId>(actionIds);
        // n slots need n * TAB - GAP px; when some do not fit, one slot goes to the menu.
        const fit = Math.floor((actionsRoom + GAP) / TAB);
        const count =
            actionIds.length <= fit ? actionIds.length : Math.max(0, fit - 1);
        return new Set<ActionId>(actionIds.slice(0, count));
    });
    const hiddenIds = $derived(actionIds.filter((id) => !keptIds.has(id)));
    const actionItems = $derived<Record<ActionId, ZDropdownMenuItem>>({
        source: {
            label: codeMode ? 'Show preview' : 'Show source',
            icon: (codeMode ? 'lucideEye' : 'lucideCode') as ZIconName,
            iconSize: 12,
            disabled: !current,
            onClick: () => (codeMode = !codeMode),
        },
        copy: {
            label: 'Copy artifact',
            icon: 'lucideCopy' as ZIconName,
            iconSize: 12,
            disabled: !current,
            onClick: () => void copy(),
        },
        save: {
            label: 'Save as file…',
            icon: 'lucideDownload' as ZIconName,
            iconSize: 12,
            disabled: !current || saving,
            onClick: () => void saveCopy(),
        },
        preview: {
            label: 'Open in Preview',
            icon: 'lucideExternalLink' as ZIconName,
            iconSize: 12,
            onClick: openPreview,
        },
        delete: {
            label: 'Delete',
            icon: 'lucideTrash2' as ZIconName,
            iconSize: 12,
            divide: 'before',
            disabled: !current,
            onClick: () => remove(),
        },
        refresh: {
            label: 'Refresh',
            icon: 'lucideRefreshCw' as ZIconName,
            iconSize: 12,
            disabled: !root || artifactState.loading,
            onClick: () => root && void loadArtifacts(root, true),
        },
    });
    const menuItems = $derived(hiddenIds.map((id) => actionItems[id]));
    const visibleActions = $derived(
        actionIds
            .filter((id) => keptIds.has(id))
            .map((id) => ({ id, ...actionItems[id] })),
    );
    const artifactItems = $derived(
        artifactState.items.map((item) => ({
            id: item.id,
            label: item.title,
            hint: `${item.kind} · v${item.versions.at(-1)?.n ?? 1}`,
            icon: item.agent ? undefined : ('lucidePanelsTopLeft' as ZIconName),
            agent: item.agent as never,
            selected: item.id === artifactState.selected,
            data: item,
        })),
    );
    const versionItems = $derived(
        (current?.versions ?? [])
            .slice()
            .reverse()
            .map((item) => ({
                id: String(item.n),
                label: `v${item.n}`,
                hint: [
                    new Date(item.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                    }),
                    item.note,
                ]
                    .filter(Boolean)
                    .join(' · '),
                icon: 'lucideHistory' as ZIconName,
                selected: item.n === artifactState.version,
                data: item,
            })),
    );

    $effect(() => {
        if (project === null) project = activeRoot ?? projectOptions[0] ?? null;
    });
    $effect(() => {
        if (root) void loadArtifacts(root);
    });
    $effect(() => {
        if (root) setArtifactQuery(root, artifactQuery);
    });
    function picked(item: PickerItem<ArtifactInfo>) {
        if (root) selectArtifact(root, item.data.id);
        artifactOpen = false;
    }
    function pickedVersion(item: PickerItem<{ n: number }>) {
        if (root && current) void readArtifact(root, current.id, item.data.n);
    }
    async function copy() {
        try {
            await navigator.clipboard.writeText(artifactState.content);
            toast.success('Artifact copied');
        } catch (error) {
            toast.error(String(error));
        }
    }
    async function saveCopy() {
        if (!root || !current || !version) return;
        saving = true;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const saved = await invoke<string | null>('file_copy_as', {
                path: joinPath(current.path, version.file),
            });
            if (saved) toast.success(`Saved artifact to ${saved}`);
            else toast.info('Save cancelled');
        } catch (error) {
            toast.error(`Could not save artifact: ${String(error)}`);
        } finally {
            saving = false;
        }
    }
    async function remove() {
        if (!root || !current) return;
        zModalService.danger({
            zTitle: `Delete ${current.title}?`,
            zContent: 'All saved versions will be deleted from docs/artifacts.',
            zConfirmStyle: 'dialog',
            zOkText: 'Delete',
            zOkIcon: 'lucideTrash2',
            zCancelText: 'Cancel',
            zWidth: '400px',
            onOk: async () => {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('artifacts_delete', { root, id: current.id });
                    artifactState.items = artifactState.items.filter(
                        (item) => item.id !== current.id,
                    );
                    artifactState.selected = artifactState.items[0]?.id ?? '';
                    artifactState.content = '';
                    artifactState.version = null;
                    if (artifactState.selected)
                        await readArtifact(root, artifactState.selected);
                } catch (error) {
                    toast.error(`Could not delete artifact: ${String(error)}`);
                }
            },
        });
    }
    function openPreview() {
        if (current?.kind !== 'html') return;
        toast.info(
            'HTML artifacts stay inside Canvas so their sandbox stays in place.',
        );
    }
    const safeSource = $derived(
        current && (current.kind === 'html' || current.kind === 'svg')
            ? previewDocument(artifactState.content, current.kind)
            : '',
    );
</script>

<div
    class="flex h-full min-h-0 flex-1 flex-col text-sm"
    role="tabpanel"
    aria-label="Canvas"
>
    <div
        class="tool-header flex shrink-0 items-center gap-1 border-b border-border px-1.5"
    >
        <div class="flex min-w-0 flex-[3] items-center gap-1">
            <ProjectSelect
                variant="select"
                bind:value={project}
                options={projectOptions}
                label={(path) =>
                    workspace.projects.find((item) => item.path === path)
                        ?.name ?? path}
                class="w-full! max-w-none! min-w-0 flex-1"
            />
            <ZButton
                bind:ref={artifactAnchor}
                zWave={false}
                zType="outline"
                zSize="sm"
                class="h-8 min-w-0 flex-1 justify-between! gap-2 px-2.5 text-sm font-normal {artifactOpen
                    ? TRIGGER_ON
                    : ''}"
                aria-label="Choose artifact"
                aria-haspopup="listbox"
                aria-expanded={artifactOpen}
                onclick={() => (artifactOpen = !artifactOpen)}
            >
                <span
                    class="flex min-w-0 flex-1 items-center justify-between gap-2"
                >
                    <span class="truncate"
                        >{current?.title ?? 'Choose artifact'}</span
                    >
                    <ZIcon
                        zType="lucideChevronDown"
                        class="size-3.5 shrink-0 text-muted-foreground"
                    />
                </span>
            </ZButton>
            <span class="flex min-w-0 flex-1">
                <ZSelect
                    zSize="sm"
                    class="h-8 w-full min-w-0 text-sm"
                    zPosition="bottom-left"
                    zPlaceholder="Version"
                    zShowSearch={false}
                    zDropdownWidth={210}
                    zOptions={versionItems.map((item) => ({
                        label: item.label,
                        value: item.id,
                    }))}
                    value={version ? String(version.n) : undefined}
                    onValueChange={(next) => {
                        const item = versionItems.find(
                            (entry) => entry.id === next,
                        );
                        if (item) pickedVersion(item);
                    }}
                />
            </span>
        </div>
        <PickerPopover
            anchor={artifactAnchor}
            bind:open={artifactOpen}
            bind:query={artifactQuery}
            items={artifactItems}
            size="md"
            search
            heightReduction={140}
            width={260}
            label="Artifacts"
            empty={artifactQuery ? 'No matching artifacts' : 'No artifacts yet'}
            loading={artifactState.loading}
            position="bottom-left"
            onmore={() => root && void loadMoreArtifacts(root)}
            onpick={picked}
        />
        <div
            class="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden"
            bind:clientWidth={actionsRoom}
        >
            {#each visibleActions as action (action.id)}
                <ZButton
                    zWave={false}
                    zType="ghost"
                    zSize="sm"
                    class="size-8! shrink-0 p-0 !bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary"
                    aria-label={action.label}
                    title={action.label}
                    disabled={action.disabled}
                    onclick={() => action.onClick?.()}
                    ><ZIcon
                        zType={action.icon as ZIconName}
                        class="size-4"
                    /></ZButton
                >
            {/each}
            {#if hiddenIds.length}
                <div
                    class="flex items-center [&_button]:size-7! [&_button]:p-0 [&_button]:!bg-transparent [&_button]:!text-muted-foreground [&_button:hover]:!bg-primary/10 [&_button:hover]:!text-primary [&_button[aria-expanded=true]]:!bg-primary/15 [&_button[aria-expanded=true]]:!text-primary [&_button]:outline-none [&_button]:focus-visible:ring-0"
                >
                    <MenuButton
                        items={menuItems}
                        icon="lucideMenu"
                        label="Artifact actions"
                        width={200}
                    />
                </div>
            {/if}
        </div>
    </div>
    {#if artifactState.error}<p
            class="m-0 border-b border-border p-3 text-xs text-destructive"
            role="alert"
        >
            {artifactState.error}
        </p>{/if}
    {#if current}
        <div
            class="min-h-0 flex-1 overflow-auto"
            aria-busy={artifactState.loading}
        >
            {#if codeMode || current.kind === 'code'}<CodeView
                    text={artifactState.content}
                    lang={current.kind === 'code'
                        ? current.language
                        : current.kind}
                />
            {:else if current.kind === 'html' || current.kind === 'svg'}<iframe
                    title={current.title}
                    sandbox="allow-scripts"
                    srcdoc={safeSource}
                    class="h-full min-h-0 w-full flex-1 border-0 bg-white"
                ></iframe>
            {:else}<div class="min-h-full p-4">
                    <Markdown text={artifactState.content} />
                </div>{/if}
        </div>
    {:else if artifactState.loading}
        <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
        >
            <p class="m-0 max-w-56 text-sm leading-normal">
                Loading artifacts…
            </p>
        </div>
    {:else}
        <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
        >
            <ZIcon
                zType={'lucidePanelsTopLeft' as ZIconName}
                zSize="28"
                class="size-7 opacity-60"
            />
            <h2 class="text-sm font-medium text-foreground">
                No artifacts yet
            </h2>
            <p class="m-0 max-w-60 text-sm leading-normal">
                Ask an agent to create one.
            </p>
        </div>
    {/if}
</div>
