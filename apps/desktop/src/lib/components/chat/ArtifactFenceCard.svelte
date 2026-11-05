<script lang="ts" module>
    import { SvelteMap } from 'svelte/reactivity';
    type ArtifactCommand = {
        kind: 'command';
        id: string;
        command: string;
        output: string;
        status: 'ok';
    };
    const created = new WeakMap<
        object,
        SvelteMap<number, Promise<ArtifactCommand>>
    >();
    /** Replies that finished before the app started were already saved (or deleted on purpose): never create them again. */
    const APP_STARTED = Date.now();
    export function fenceRequest(
        response: object,
        start: number,
        make: () => Promise<ArtifactCommand>,
    ) {
        let byOffset = created.get(response);
        if (!byOffset) {
            byOffset = new SvelteMap();
            created.set(response, byOffset);
        }
        let result = byOffset.get(start);
        if (!result) {
            result = make();
            byOffset.set(start, result);
        }
        return result;
    }
</script>

<script lang="ts">
    import { onMount } from 'svelte';
    import { ZIcon } from '@shival99/z-ui-svelte';
    import CanvasCard from './CanvasCard.svelte';
    import type { ArtifactFence } from '../../canvas/fence';
    import type { ArtifactInfo } from '../../canvas/canvas.svelte';
    import type { CommandBlock } from '../../chat/content/blocks';
    import { workspace, sessionCwd } from '../../chat/sessions.svelte';
    import { toast } from '../../app/platform/toast';

    let {
        response,
        fence,
        sourceKey,
        sessionId,
        startedAt,
    }: {
        response: object;
        fence: ArtifactFence;
        sourceKey: string;
        sessionId: string;
        /** When the reply started (ms): only a reply from this app run saves its fence by itself. */
        startedAt?: number;
    } = $props();
    let item: CommandBlock | null = $state(null);
    let unsaved = $state(false);

    const session = $derived(
        workspace.sessions.find((candidate) => candidate.id === sessionId),
    );

    function commandOf(info: {
        id: string;
        versions: { n: number }[];
    }): ArtifactCommand {
        return {
            kind: 'command',
            id: `artifact-fence:${sessionId}:${info.id}`,
            command: `artifact_create ${JSON.stringify({ id: info.id, title: fence.title, kind: fence.kind })}`,
            output: `artifact ${info.id} v${info.versions.at(-1)?.n ?? 1} (fallback)`,
            status: 'ok',
        };
    }

    function save(root: string) {
        unsaved = false;
        void fenceRequest(response, fence.start, async () => {
            const { invoke } = await import('@tauri-apps/api/core');
            const info = await invoke<{
                id: string;
                versions: { n: number }[];
            }>('artifacts_create', {
                root,
                title: fence.title,
                kind: fence.kind,
                content: fence.content,
                agent: session?.agent ?? '',
                chat: sessionId,
                sourceKey,
            });
            return commandOf(info);
        })
            .then((result) => {
                item = result;
            })
            .catch((error) =>
                toast.error(`Could not save artifact fence: ${String(error)}`),
            );
    }

    onMount(() => {
        const root = session && sessionCwd(session);
        if (!root) return;
        if ((startedAt ?? 0) >= APP_STARTED) {
            save(root);
            return;
        }
        // An older reply: show the artifact it saved, if it still exists, and leave saving again to the user.
        void import('@tauri-apps/api/core')
            .then(({ invoke }) =>
                invoke<ArtifactInfo[]>('artifacts_list', { root }),
            )
            .then((items) => {
                const found = items.find(
                    (info) => info.sourceKey === sourceKey,
                );
                if (found) item = commandOf(found);
                else unsaved = true;
            })
            .catch(() => {
                unsaved = true;
            });
    });
</script>

{#if item}<CanvasCard {item} {sessionId} />{:else if unsaved}<button
        type="button"
        class="flex w-full items-center gap-2 border border-border px-3 py-2 text-left text-sm hover:bg-muted/40"
        onclick={() => {
            const root = session && sessionCwd(session);
            if (root) save(root);
        }}
        aria-label={`Save ${fence.title} to Canvas`}
    >
        <ZIcon
            zType="lucidePanelsTopLeft"
            class="size-4 shrink-0 text-muted-foreground"
        />
        <span class="min-w-0 flex-1 truncate font-medium">{fence.title}</span>
        <span class="shrink-0 text-xs text-muted-foreground"
            >Save to Canvas</span
        >
    </button>{:else}<div
        class="flex items-center gap-2 border border-border px-3 py-2 text-xs text-muted-foreground"
        role="status"
    >
        <ZIcon zType="lucidePanelsTopLeft" class="size-4" />Saving {fence.title} to
        Canvas…
    </div>{/if}
