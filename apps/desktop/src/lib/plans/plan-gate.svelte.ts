import { inTauri, isPreviewCopy } from '../app/platform/history';
import { automation } from '../app/platform/automation.svelte';
import { samePath } from '../files/paths';
import { workspace } from '../chat/sessions.svelte';
import { projectOf, type Permission } from '../chat/session/state.svelte';
import { turnOptionsOf } from '../chat/session/turns.svelte';
import { isWorkerChat } from '../chat/session/delegate-task.svelte';
import { loadPlans, plansCache, type PlanInfo } from './plans.svelte';
import { boundPlan, effectivePermission, gated } from './plan-gate';

/** The writable plan a chat is bound to, from the plans already loaded for its project (never loads). */
export function gatePlanOf(sessionId: string): PlanInfo | null {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    const root = session ? projectOf(session)?.path : undefined;
    if (!root) return null;
    return boundPlan<PlanInfo>(plansCache[root]?.items ?? [], sessionId);
}

/** The project folder of a chat, if the chat is known. */
export function projectRootOf(sessionId: string): string | null {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    return (session ? projectOf(session)?.path : undefined) ?? null;
}

/** Whether a chat's turns are held to Plan mode right now. Reads only; never loads. */
export function gateHeld(sessionId: string): boolean {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    return gated({
        enabled: automation.requirePlanApproval,
        worker: isWorkerChat(sessionId) || Boolean(session?.side),
        plan: gatePlanOf(sessionId),
    });
}

/**
 * The permission a turn of this chat runs with. A chat held by its plan runs in Plan mode whatever the Composer shows;
 * the Composer's choice itself is not changed.
 */
export function permissionOf(sessionId: string): Permission {
    const root = projectRootOf(sessionId);
    // Start loading the project's plans when the chat's first turn needs them; the next turn sees them.
    if (root && !plansCache[root]) void loadPlans(root);
    return effectivePermission(
        turnOptionsOf(sessionId).permission,
        gateHeld(sessionId),
    ) as Permission;
}

/** The user approves a plan: its turns run with the Composer's own permission from the next turn. */
export async function approvePlan(root: string, id: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plans_set_status', { root, id, status: 'approved' });
    await loadPlans(root, true);
}

/** The user runs a plan without its approval gate (the plan keeps its draft status). */
export async function runPlanWithoutGate(
    root: string,
    id: string,
): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plans_set_gate', { root, id, off: true });
    await loadPlans(root, true);
}

// A plan saved or changed by any agent refreshes the cache, so a gate that depends on it is current even when the
// Plans tab is not open.
if (inTauri() && !isPreviewCopy()) {
    void import('../app/platform/tauri-event')
        .then(({ listen }) =>
            listen<{ root: string }>('plan-changed', ({ payload }) => {
                const root = Object.keys(plansCache).find((key) =>
                    samePath(key, payload.root),
                );
                if (root) void loadPlans(root, true);
            }),
        )
        .catch(() => undefined);
}
