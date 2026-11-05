<script lang="ts">
    import { ZButton, ZIcon, zModalService } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
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
        readArtifact,
        selectArtifact,
        stateFor,
        type ArtifactInfo,
    } from '../../canvas/canvas.svelte';
    import { previewDocument } from '../../canvas/preview';

    let project: string | null = $state(null);
    let artifactOpen = $state(false);
    let artifactAnchor = $state<HTMLElement | null>(null);
    let versionOpen = $state(false);
    let versionAnchor = $state<HTMLElement | null>(null);
    let codeMode = $state(false);
    let saving = $state(false);
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
    const artifactState = $derived(
        root
            ? stateFor(root)
            : {
                  items: [],
                  selected: '',
                  version: null,
                  content: '',
                  loading: false,
                  error: '',
              },
    );
    const current = $derived(
        artifactState.items.find((item) => item.id === artifactState.selected),
    );
    const version = $derived(
        current?.versions.find((item) => item.n === artifactState.version) ??
            current?.versions.at(-1),
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
    function picked(item: PickerItem<ArtifactInfo>) {
        if (root) selectArtifact(root, item.data.id);
        artifactOpen = false;
    }
    function pickedVersion(item: PickerItem<{ n: number }>) {
        if (root && current) void readArtifact(root, current.id, item.data.n);
        versionOpen = false;
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
        class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2"
    >
        <ProjectSelect
            bind:value={project}
            options={projectOptions}
            label={(path) =>
                workspace.projects.find((item) => item.path === path)?.name ??
                path}
            class="min-w-0! flex-1"
        />
        <ZButton
            bind:ref={artifactAnchor}
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="min-w-0 max-w-52 gap-2 {artifactOpen ? TRIGGER_ON : ''}"
            aria-label="Choose artifact"
            aria-haspopup="listbox"
            aria-expanded={artifactOpen}
            onclick={() => (artifactOpen = !artifactOpen)}
        >
            <span class="truncate">{current?.title ?? 'Choose artifact'}</span
            ><ZIcon zType="lucideChevronDown" class="size-3.5 shrink-0" />
        </ZButton>
        <PickerPopover
            anchor={artifactAnchor}
            bind:open={artifactOpen}
            items={artifactItems}
            size="md"
            search
            local
            width={260}
            label="Artifacts"
            empty="No artifacts yet"
            position="bottom-left"
            onpick={picked}
        />
        <ZButton
            bind:ref={versionAnchor}
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="gap-1 {versionOpen ? TRIGGER_ON : ''}"
            aria-label="Choose artifact version"
            aria-haspopup="listbox"
            aria-expanded={versionOpen}
            disabled={!current}
            onclick={() => (versionOpen = !versionOpen)}
        >
            v{version?.n ?? '—'}<ZIcon
                zType="lucideChevronDown"
                class="size-3.5"
            />
        </ZButton>
        <PickerPopover
            anchor={versionAnchor}
            bind:open={versionOpen}
            items={versionItems}
            size="sm"
            local
            width={210}
            label="Artifact versions"
            empty="No versions"
            position="bottom-left"
            onpick={pickedVersion}
        />
        <span class="flex-1"></span>
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-7! p-0"
            aria-label={codeMode ? 'Show preview' : 'Show source'}
            title={codeMode ? 'Show preview' : 'Show source'}
            disabled={!current}
            onclick={() => (codeMode = !codeMode)}
            ><ZIcon
                zType={codeMode ? 'lucideEye' : 'lucideCode'}
                class="size-4"
            /></ZButton
        >
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-7! p-0"
            aria-label="Copy artifact"
            title="Copy"
            disabled={!current}
            onclick={() => void copy()}
            ><ZIcon zType="lucideCopy" class="size-4" /></ZButton
        >
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-7! p-0"
            aria-label="Save artifact as file"
            title="Save as file…"
            disabled={!current || saving}
            onclick={() => void saveCopy()}
            ><ZIcon zType="lucideDownload" class="size-4" /></ZButton
        >
        {#if current?.kind === 'html'}<ZButton
                zWave={false}
                zType="ghost"
                zSize="sm"
                class="size-7! p-0"
                aria-label="Open HTML in Preview"
                title="Open in Preview"
                onclick={openPreview}
                ><ZIcon zType="lucideExternalLink" class="size-4" /></ZButton
            >{/if}
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-7! p-0"
            aria-label="Delete artifact"
            title="Delete"
            disabled={!current}
            onclick={() => remove()}
            ><ZIcon zType="lucideTrash2" class="size-4" /></ZButton
        >
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-7! p-0"
            aria-label="Refresh artifacts"
            title="Refresh"
            disabled={!root || artifactState.loading}
            onclick={() => root && void loadArtifacts(root, true)}
            ><ZIcon zType="lucideRefreshCw" class="size-4" /></ZButton
        >
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
    {:else}
        <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
        >
            <ZIcon zType="lucidePanelsTopLeft" class="size-8 opacity-60" />
            <p class="m-0 max-w-56 text-sm leading-normal">
                {artifactState.loading
                    ? 'Loading artifacts…'
                    : 'No artifacts yet. Ask an agent to create one.'}
            </p>
        </div>
    {/if}
</div>
