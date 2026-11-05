import { SvelteMap, SvelteSet } from 'svelte/reactivity';
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
export type ArtifactPage = {
    items: ArtifactInfo[];
    nextCursor: number | null;
};
export type ArtifactState = {
    /** The rows read so far, newest first: the first page, then more as the list is scrolled. */
    items: ArtifactInfo[];
    /** What the list is searched for (empty: all). The search runs in the backend over every artifact. */
    query: string;
    /** Offset of the next page, or null at the end. */
    cursor: number | null;
    /** A page after `cursor` is being read. */
    paging: boolean;
    selected: string;
    version: number | null;
    content: string;
    loading: boolean;
    error: string;
};

export const ARTIFACT_PAGE = 50;

export const canvasState = $state<Record<string, ArtifactState>>({});
const listRequests = new SvelteMap<string, symbol>();
const readRequests = new SvelteMap<string, symbol>();
/** Bumped by every fresh list, so a page read before it is dropped. */
const listGeneration = new SvelteMap<string, number>();
const searchTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

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
        query: '',
        cursor: null,
        paging: false,
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
    listGeneration.set(root, (listGeneration.get(root) ?? 0) + 1);
    state.loading = true;
    state.error = '';
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const page = await invoke<ArtifactPage>('artifacts_page', {
            root,
            query: state.query,
            cursor: 0,
            limit: ARTIFACT_PAGE,
        });
        if (listRequests.get(root) !== request) return;
        state.items = page.items;
        state.cursor = page.nextCursor;
        // The selection stays while the list is not searched, even if it is on a page not read yet.
        const kept =
            state.selected !== '' &&
            (!state.query ||
                state.items.some((item) => item.id === state.selected));
        if (!kept) state.selected = state.items[0]?.id ?? '';
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

/** Reads the next page of the (searched) list, when the list is scrolled to its end. */
export async function loadMoreArtifacts(root: string): Promise<void> {
    if (!root || !inTauri() || isPreviewCopy()) return;
    const state = stateFor(root);
    if (state.cursor === null || state.paging || state.loading) return;
    const cursor = state.cursor;
    const generation = listGeneration.get(root) ?? 0;
    state.paging = true;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const page = await invoke<ArtifactPage>('artifacts_page', {
            root,
            query: state.query,
            cursor,
            limit: ARTIFACT_PAGE,
        });
        if ((listGeneration.get(root) ?? 0) !== generation) return;
        const seen = new SvelteSet(state.items.map((item) => item.id));
        state.items = [
            ...state.items,
            ...page.items.filter((item) => !seen.has(item.id)),
        ];
        state.cursor = page.nextCursor;
    } catch (error) {
        state.error = String(error);
    } finally {
        state.paging = false;
    }
}

/** Searches the artifacts of a project. Typing waits a moment before the backend is asked again. */
export function setArtifactQuery(root: string, query: string): void {
    const state = stateFor(root);
    if (state.query === query) return;
    state.query = query;
    clearTimeout(searchTimers.get(root));
    searchTimers.set(
        root,
        setTimeout(() => void loadArtifacts(root, true), 150),
    );
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
