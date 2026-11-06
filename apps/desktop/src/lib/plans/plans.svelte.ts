import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { inTauri, isPreviewCopy } from '../app/platform/history';

/** Metadata returned by the shared Plans backend, without the Markdown body. */
export type PlanInfo = {
    id: string;
    path: string;
    title: string;
    status: string;
    agent: string;
    chat: string;
    source: string;
    created: string;
    updated: string;
    done: number;
    total: number;
    readOnly: boolean;
    /** When the user approved the plan; empty while it is not approved. */
    approvedAt: string;
    /** The chat that runs this plan, once one is started from it. */
    runChat: string;
    /** `off` when the plan runs without its approval gate. */
    gate: string;
};

type PlanState = { items: PlanInfo[]; loading: boolean; error: string };

/** Last list and its load state for each project root. */
export const plansCache = $state<Record<string, PlanState>>({});
// Request ownership is deliberately non-reactive: reading it from a load effect must not retrigger that effect.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const requests = new Map<string, symbol>();

/** One plan row, with the project it was read for. */
export type PlanRow = { root: string; plan: PlanInfo };
/** `local`: the projects' own plans. `global`: the shared Claude plans folder. */
export type PlanScope = 'local' | 'global';
export const PLAN_PAGE = 50;

type PlanPageState = {
    /** Rows read so far, newest first: the first page, then more as the list is scrolled. */
    items: PlanRow[];
    /** Offset of the next page, or null at the end. */
    cursor: number | null;
    /** A page after `cursor` is being read. */
    paging: boolean;
    loading: boolean;
    error: string;
    /** The projects and status the rows were read for. */
    roots: string[];
    status: string;
    /** Bumped by every fresh read, so a page read before it is dropped. */
    generation: number;
};

function emptyPage(): PlanPageState {
    return {
        items: [],
        cursor: null,
        paging: false,
        loading: false,
        error: '',
        roots: [],
        status: '',
        generation: 0,
    };
}

/** Paged Plans list per scope, read from the SQLite index in the backend. Separate from `plansCache`, which holds whole lists. */
export const planPages = $state<Record<PlanScope, PlanPageState>>({
    local: emptyPage(),
    global: emptyPage(),
});

function pageKey(row: PlanRow): string {
    return `${row.root}:${row.plan.id}`;
}

/**
 * Reads the first page of a scope for the given projects and status.
 * @param scope - `local` or `global`; global plans are the same for every project, so they come from the first one.
 * @param roots - Project folders to list.
 * @param status - Status to filter by (empty: all).
 */
export async function loadPlanPage(
    scope: PlanScope,
    roots: string[],
    status: string,
): Promise<void> {
    if (!inTauri() || isPreviewCopy()) return;
    const state = planPages[scope];
    const generation = ++state.generation;
    const requested = scope === 'global' ? roots.slice(0, 1) : roots;
    state.roots = requested;
    state.status = status;
    state.loading = true;
    state.error = '';
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const page = await invoke<{
            items: PlanRow[];
            nextCursor: number | null;
        }>('plans_page', {
            roots: requested,
            scope,
            status: status || null,
            cursor: 0,
            limit: PLAN_PAGE,
        });
        if (state.generation !== generation) return;
        state.items = page.items;
        state.cursor = page.nextCursor;
    } catch (error) {
        if (state.generation === generation) state.error = String(error);
    } finally {
        if (state.generation === generation) state.loading = false;
    }
}

/** Reads the next page of a scope, when its list is scrolled near the end. */
export async function loadMorePlanPage(scope: PlanScope): Promise<void> {
    if (!inTauri() || isPreviewCopy()) return;
    const state = planPages[scope];
    if (state.cursor === null || state.paging || state.loading) return;
    const cursor = state.cursor;
    const generation = state.generation;
    state.paging = true;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const page = await invoke<{
            items: PlanRow[];
            nextCursor: number | null;
        }>('plans_page', {
            roots: state.roots,
            scope,
            status: state.status || null,
            cursor,
            limit: PLAN_PAGE,
        });
        if (state.generation !== generation) return;
        const seen = new SvelteSet(state.items.map(pageKey));
        state.items = [
            ...state.items,
            ...page.items.filter((row) => !seen.has(pageKey(row))),
        ];
        state.cursor = page.nextCursor;
    } catch (error) {
        if (state.generation === generation) state.error = String(error);
    } finally {
        state.paging = false;
    }
}

/**
 * Loads one project's plans, retaining cached rows while a forced refresh is pending.
 * @param root - Project folder passed to the backend.
 * @param refresh - Always query disk again, even while an older request is pending.
 * @returns Resolves after loading; backend failures are exposed in `plansCache[root].error`.
 */
export async function loadPlans(root: string, refresh = false): Promise<void> {
    if (!root || !inTauri() || isPreviewCopy()) return;
    const cached = untrack(() => plansCache[root]);
    if (!refresh && cached && (cached.loading || !cached.error)) return;
    const request = Symbol();
    requests.set(root, request);
    plansCache[root] = { items: cached?.items ?? [], loading: true, error: '' };
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const items = await invoke<PlanInfo[]>('plans_list', { root });
        // A manual/event refresh owns the result even if an older request finishes last.
        if (requests.get(root) === request)
            plansCache[root] = { items, loading: false, error: '' };
    } catch (error) {
        if (requests.get(root) === request)
            plansCache[root] = {
                items: cached?.items ?? [],
                loading: false,
                error: String(error),
            };
    } finally {
        if (requests.get(root) === request) requests.delete(root);
    }
}
