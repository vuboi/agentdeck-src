import { SvelteMap } from 'svelte/reactivity';
import { inTauri, isPreviewCopy } from '../app/platform/history';
import { layout } from '../app/ui/layout.svelte';
import { workspace, activeSession, sessionCwd } from '../chat/sessions.svelte';
import { samePath } from '../files/paths';

export type ArtifactVersion = {
    n: number;
    file: string;
    at: string;
    note: string;
};
export type ArtifactInfo = {
    id: string;
    path: string;
    title: string;
    kind: 'html' | 'markdown' | 'svg' | 'code';
    language: string;
    agent: string;
    chat: string;
    /** Set for an artifact saved from a fenced block in a reply. */
    sourceKey?: string;
    created: string;
    updated: string;
    versions: ArtifactVersion[];
};
export type ArtifactState = {
    items: ArtifactInfo[];
    selected: string;
    version: number | null;
    content: string;
    loading: boolean;
    error: string;
};

export const canvasState = $state<Record<string, ArtifactState>>({});
const listRequests = new SvelteMap<string, symbol>();
const readRequests = new SvelteMap<string, symbol>();

// Listen at module scope so artifact creation can activate Canvas even while its tab is not mounted.
if (inTauri() && !isPreviewCopy()) {
    void import('../app/platform/tauri-event')
        .then(({ listen }) =>
            listen<{ root: string; id: string; version: number; chat: string }>(
                'artifact-changed',
                ({ payload }) => {
                    // Rust sends the root with forward slashes; Canvas keys its state by the chat's folder as the UI spells it.
                    const session = activeSession();
                    const activeRoot = session ? sessionCwd(session) : null;
                    const isActiveRoot =
                        !!activeRoot && samePath(activeRoot, payload.root);
                    const root = isActiveRoot
                        ? activeRoot
                        : (Object.keys(canvasState).find((key) =>
                              samePath(key, payload.root),
                          ) ?? payload.root);
                    const state = stateFor(root);
                    if (
                        payload.chat &&
                        payload.chat === workspace.activeId &&
                        isActiveRoot
                    ) {
                        layout.activeTool = 'Canvas';
                        void loadArtifacts(root, true).then(() =>
                            selectArtifact(root, payload.id, payload.version),
                        );
                        return;
                    }
                    if (state.selected === payload.id)
                        void loadArtifacts(root, true).then(() =>
                            selectArtifact(root, payload.id, payload.version),
                        );
                },
            ),
        )
        .catch(() => undefined);
}

export function stateFor(root: string): ArtifactState {
    return (canvasState[root] ??= {
        items: [],
        selected: '',
        version: null,
        content: '',
        loading: false,
        error: '',
    });
}

export async function loadArtifacts(
    root: string,
    refresh = false,
): Promise<void> {
    if (!root || !inTauri() || isPreviewCopy()) return;
    const state = stateFor(root);
    if (!refresh && (state.loading || state.items.length)) return;
    const request = Symbol();
    listRequests.set(root, request);
    state.loading = true;
    state.error = '';
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const items = await invoke<ArtifactInfo[]>('artifacts_list', { root });
        if (listRequests.get(root) !== request) return;
        state.items = items;
        if (!state.items.some((item) => item.id === state.selected))
            state.selected = state.items[0]?.id ?? '';
        if (state.selected)
            await readArtifact(
                root,
                state.selected,
                refresh ? undefined : (state.version ?? undefined),
            );
    } catch (error) {
        if (listRequests.get(root) === request) state.error = String(error);
    } finally {
        if (listRequests.get(root) === request) {
            state.loading = false;
            listRequests.delete(root);
        }
    }
}

export async function readArtifact(
    root: string,
    id: string,
    version?: number,
): Promise<void> {
    const state = stateFor(root);
    const request = Symbol();
    readRequests.set(root, request);
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ info: ArtifactInfo; content: string }>(
            'artifacts_read',
            { root, id, version },
        );
        if (readRequests.get(root) !== request) return;
        state.selected = id;
        state.version = version ?? result.info.versions.at(-1)?.n ?? 1;
        state.content = result.content;
        state.error = '';
    } catch (error) {
        if (readRequests.get(root) === request) state.error = String(error);
    }
}

export function selectArtifact(
    root: string,
    id: string,
    version?: number,
): void {
    const state = stateFor(root);
    state.selected = id;
    void readArtifact(root, id, version);
}
