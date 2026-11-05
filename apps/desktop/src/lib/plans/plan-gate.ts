// The approval gate of a chat that saved a plan (plan P3). Pure (no stores, no Tauri) so plain node can test it.

/** The part of a plan the gate reads. */
export type GatePlan = {
    id: string;
    status: string;
    chat: string;
    /** The chat that runs this plan, once one is started from it. */
    runChat: string;
    source: string;
    /** `off` when the plan runs without its gate. */
    gate: string;
    updated: string;
    readOnly: boolean;
};

/** Plans saved by the chat itself: Claude's ExitPlanMode, Codex's plan mode, or an agent's plan_write. */
const SAVED_BY_CHAT = ['exit-plan-mode', 'codex-plan-mode', 'mcp'];

/**
 * The plan a chat is bound to: the one it runs, else one it saved itself. Writable plans only; when several match, the
 * most recently updated one.
 */
export function boundPlan<T extends GatePlan>(
    plans: T[],
    chatId: string,
): T | null {
    if (!chatId) return null;
    const latest = (matches: (plan: T) => boolean): T | null => {
        let found: T | null = null;
        for (const plan of plans) {
            if (plan.readOnly || !matches(plan)) continue;
            if (!found || plan.updated > found.updated) found = plan;
        }
        return found;
    };
    return (
        latest((plan) => plan.runChat === chatId) ??
        latest(
            (plan) =>
                plan.chat === chatId && SAVED_BY_CHAT.includes(plan.source),
        )
    );
}

/**
 * Whether a chat's turns are held to Plan mode: the setting is on, the chat is a main chat, and its plan is still a
 * draft that has not been run without its gate.
 */
export function gated(input: {
    enabled: boolean;
    worker: boolean;
    plan: GatePlan | null;
}): boolean {
    return (
        input.enabled &&
        !input.worker &&
        input.plan !== null &&
        input.plan.status === 'draft' &&
        input.plan.gate !== 'off'
    );
}

/** The permission a turn runs with: Plan while gated, otherwise the one the Composer chose. */
export function effectivePermission<T extends string>(
    chosen: T,
    isGated: boolean,
): T | 'plan' {
    return isGated ? 'plan' : chosen;
}
