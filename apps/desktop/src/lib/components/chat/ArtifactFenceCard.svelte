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
    import type { CommandBlock } from '../../chat/content/blocks';
    import {
        workspace,
        activeSession,
        sessionCwd,
    } from '../../chat/sessions.svelte';
    import { toast } from '../../app/platform/toast';

    let {
        response,
        fence,
        sessionId,
    }: { response: object; fence: ArtifactFence; sessionId: string } = $props();
    let item: CommandBlock | null = $state(null);
    onMount(() => {
        const session = workspace.sessions.find(
            (candidate) => candidate.id === sessionId,
        );
        const root = session && sessionCwd(session);
        if (!root) return;
        void fenceRequest(response, fence.start, async () => {
            const { invoke } = await import('@tauri-apps/api/core');
            const info = await invoke<{ id: string }>('artifacts_create', {
                root,
                title: fence.title,
                kind: fence.kind,
                content: fence.content,
                agent: activeSession()?.agent ?? 'codex',
                chat: sessionId,
            });
            return {
                kind: 'command',
                id: `artifact-fence:${sessionId}:${info.id}`,
                command: `artifact_create ${JSON.stringify({ id: info.id, title: fence.title, kind: fence.kind })}`,
                output: `artifact ${info.id} v1 (fallback)`,
                status: 'ok',
            };
        })
            .then((result) => {
                item = result;
            })
            .catch((error) =>
                toast.error(`Could not save artifact fence: ${String(error)}`),
            );
    });
</script>

{#if item}<CanvasCard {item} {sessionId} />{:else}<div
        class="flex items-center gap-2 border border-border px-3 py-2 text-xs text-muted-foreground"
        role="status"
    >
        <ZIcon zType="lucidePanelsTopLeft" class="size-4" />Saving {fence.title} to
        Canvas…
    </div>{/if}
