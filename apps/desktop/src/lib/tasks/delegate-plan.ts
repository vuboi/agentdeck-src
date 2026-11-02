import type { Agent } from '../chat/session/state.svelte';
import { canonicalRole, type TaskRoleId } from '../agents/task-roles';
import {
    type AgentRow,
    type DelegateArgs,
    type TaskRecord,
    findAgent,
    formatAgents,
    parseDelegateArgs,
    privateContentIn,
    resolveModel,
} from './delegate-task';

/**
 * Every check a `delegate_task` call must pass before anything is made for it: no worktree, no chat, no worker. Pure: the
 * module passes in the state it reads (`PlanState`), so each refusal can be tested on its own.
 */

/** The fields of a chat the planner reads. */
export type PlanCaller = {
    id: string;
    side?: unknown;
    agent: string;
    model: string;
};

/** A chat the planner may reuse with `continue`. */
export type PlanSession = {
    id: string;
    parentId?: string;
    status: string;
    agent?: string;
    model?: string;
};

export type PlanState = {
    /** How deep the caller is in delegation (see taskDepth). */
    depth: number;
    maxDepth: number;
    tasks: Record<string, TaskRecord>;
    sessions: PlanSession[];
    /** The provider rows, read only once a call passes the checks that need no agent (a refusal before reads none). */
    rows: () => AgentRow[];
    /** The routes configured for a task role, in Settings > Tasks. */
    routesFor: (role: TaskRoleId) => string[];
    /** The first configured route of a role that is available now, with its effort. */
    routedFor: (
        role: TaskRoleId,
        rows: AgentRow[],
    ) => { agent: string; model: string; effort?: string } | undefined;
    /** Whether a task's worker is running now. */
    isRunning: (taskId: string) => boolean;
    /** The model id a custom provider's model is stored under. */
    customModelId: (rowId: string, model: string) => string;
    /** The agent kind of a provider row (`custom` for a local provider). */
    agentKindOf: (rowId: string) => Agent;
};

export type PlanInput = {
    call: { args: unknown };
    caller: PlanCaller | undefined;
};

/** A reuse of an earlier worker chat (`continue`). `replace`: the chat is not reused, a new one takes its place. */
export type PlanReuse = {
    sessionId: string;
    recordId?: string;
    replace: boolean;
};

export type TaskPlan = {
    args: DelegateArgs;
    dependencies: string[];
    roleId?: TaskRoleId;
    routed?: { agent: string; model: string; effort?: string };
    row: AgentRow;
    agent: Agent;
    model: string;
    reuse?: PlanReuse;
};

export type PlanResult =
    { ok: true; plan: TaskPlan } | { ok: false; error: string };

const refuse = (error: string): PlanResult => ({ ok: false, error });

/** Checks a `delegate_task` call. A refusal is an error text for the caller; the plan is what starting the worker needs. */
export function planTask(input: PlanInput, state: PlanState): PlanResult {
    const parsed = parseDelegateArgs(input.call.args);
    if (!parsed.ok) return refuse(parsed.error);
    const args = parsed.args;
    const caller = input.caller;
    if (!caller)
        return refuse(
            'AgentDeck could not tell which chat is calling. Do the task yourself, or ask the user to run it from the chat.',
        );
    // A /btw side chat answers one question read-only: it hands no work to another chat, and no worktree is made for it.
    if (caller.side)
        return refuse(
            'side chats cannot delegate: answer the question yourself, read-only.',
        );
    if (state.depth >= state.maxDepth)
        return refuse(
            `Delegation depth is limited to ${state.maxDepth} levels. Finish this task yourself and report back.`,
        );
    const roleId = args.role ? canonicalRole(args.role) : undefined;
    if (args.role && !roleId)
        return refuse(
            `Unknown task role "${args.role}". Use one of: read, research, plan, review, security, refactor, coding, write, text, logic.`,
        );
    const configured = roleId ? state.routesFor(roleId) : [];
    if (roleId && !configured.length)
        return refuse(
            `No route is configured for task role "${roleId}" in Settings > Tasks. Choose an agent there or call delegate_task without role to select one directly.`,
        );
    const dependencies = [...new Set(args.dependsOn)];
    for (const dependencyId of dependencies)
        if (!state.tasks[dependencyId])
            return refuse(
                `depends_on=${dependencyId} is unknown: use a task_id returned by delegate_task.`,
            );
    if (args.worktree && args.continueId)
        return refuse(
            'isolation worktree cannot be used with continue: a reused chat keeps its folder. Start a new task instead.',
        );

    // `continue`: reuse an idle worker chat (found by task id or chat id) instead of creating a new one.
    let old:
        | { session: PlanSession; recordId?: string; record?: TaskRecord }
        | undefined;
    if (args.continueId) {
        const prior = state.tasks[args.continueId];
        let childId = prior?.childId ?? args.continueId;
        // Follow persisted replacement links without changing historical task cards.
        const seen = new Set<string>();
        while (!seen.has(childId)) {
            seen.add(childId);
            const next = Object.values(state.tasks).find(
                (item) => item.childId === childId && item.replacementChildId,
            )?.replacementChildId;
            if (!next) break;
            childId = next;
        }
        const session = state.sessions.find(
            (item) => item.id === childId && item.parentId,
        );
        if (!session)
            return refuse(
                `continue="${args.continueId}" is unknown: no delegated task or worker chat has that id. Use a task_id from an earlier delegate_task result or a worker chat id.`,
            );
        const records = Object.values(state.tasks).filter(
            (item) => item.childId === childId,
        );
        if (
            session.status === 'working' ||
            records.some((item) => state.isRunning(item.id))
        )
            return refuse('worker is still running, use task_status or wait');
        const record = records.sort((a, b) => a.startedAt - b.startedAt).at(-1);
        old = { session, recordId: record?.id, record };
    }

    const rows = state.rows();
    // A role with agents set in Task roles: the first of them that is available is used, whatever agent the caller named.
    const routed = roleId ? state.routedFor(roleId, rows) : undefined;
    if (roleId && !routed)
        return refuse(
            `None of the configured routes for task role "${roleId}" is currently available with its exact provider and model. Check Settings > Tasks and the provider's account or model catalogue.`,
        );
    const wantedModel = routed ? routed.model : args.model;
    const oldRowId = old?.record?.agentId ?? old?.session.agent;
    const row = findAgent(
        rows,
        routed?.agent ?? (args.agent || oldRowId || ''),
    );
    if (!row)
        return refuse(
            `No agent "${args.agent || oldRowId}" is available. ${formatAgents(rows)}`,
        );
    const inheritedModel =
        row.id === caller.agent &&
        row.models.some((item) => item.value === caller.model)
            ? caller.model
            : undefined;
    const sameProvider = Boolean(old && row.id === oldRowId);
    const chosen =
        sameProvider && !wantedModel
            ? { model: old!.session.model ?? '' }
            : resolveModel(
                  row.models,
                  wantedModel ?? inheritedModel,
                  row.id === 'claude' ? 'sonnet' : undefined,
              );
    if ('error' in chosen) return refuse(chosen.error);
    const agent = state.agentKindOf(row.id);
    const model =
        sameProvider && !wantedModel
            ? chosen.model
            : agent === 'custom'
              ? state.customModelId(row.id, chosen.model)
              : chosen.model;
    // A reused chat is replaced when it failed, runs another provider, or runs another model.
    const failed =
        old?.record &&
        (old.record.state === 'failed' || old.record.state === 'stopped');
    const replace = Boolean(
        old && (failed || !sameProvider || model !== old.session.model),
    );
    // Check the task text here; a replacement's seed (the old transcript) is checked again where it is built.
    const leak = row.restricted ? privateContentIn(args.task) : null;
    if (leak)
        return refuse(
            `Not sent: ${row.label} is a free tier that may keep what it is sent, and this task holds ${leak}. Do this part yourself or give it to another agent; send the free tier only public, non-sensitive text.`,
        );
    return {
        ok: true,
        plan: {
            args,
            dependencies,
            roleId,
            routed,
            row,
            agent,
            model,
            reuse: old
                ? { sessionId: old.session.id, recordId: old.recordId, replace }
                : undefined,
        },
    };
}
