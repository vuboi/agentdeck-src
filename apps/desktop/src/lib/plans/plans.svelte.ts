import { untrack } from 'svelte';
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
