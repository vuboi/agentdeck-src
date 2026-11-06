import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { invoke } from '@tauri-apps/api/core';
import {
    type TaskRecord,
    type AgentRow,
    formatTaskResult,
    replacementTask,
    MAX_WORKERS,
    type Verdict,
    kindOfCommand,
    pickTask,
    argsOfCall,
    formatAgents,
    privateContentIn,
    newTaskId,
    REPORT_RULE,
    startedText,
    reportDigest,
    reasonLine,
    isTaskId,
    workerLanguageRule,
    FOLLOW_UP_PREFACE,
    RESTORED_LOST_NOTE,
    QUESTION_WAIT_MS,
    SIBLING_WAIT_MS,
    pendingSiblings,
} from '../../tasks/delegate-task';
import { getPref, setPref } from '../../app/platform/prefs';
import {
    connectors,
    roomLine,
    agentHasRoom,
    refreshDetect,
    usagePct,
} from '../../agents/connectors.svelte';
import { elapsed } from '../content/blocks';
import { type Block, type Message } from '../mock';
import { automation } from '../../app/platform/automation.svelte';
import {
    changedPaths,
    reviewBrief,
    shouldAutoReview,
} from '../../tasks/auto-review';
import {
    type DelegateCall,
    enterWorkerSlot,
    releaseWorkerSlot,
    holdDelegateCall,
    runDelegateCall,
    replyDelegateCall,
    delegateReady,
    listenDelegateCalls,
    listenWorkerSlots,
    listenDelegateAborts,
} from '../agent';
import {
    customModelId,
    effortLabel,
    modelLabel,
} from '../../agents/models.svelte';
import { logFlow } from '../../tasks/flow-log';
import { WORKTREE_RULE, worktreeSlug } from '../../tasks/worktree';
import { type PlanState, planTask } from '../../tasks/delegate-plan';
import { type WorkerCall, workerArgsOf } from '../../tasks/propose';
import { inTauri } from '../../app/platform/history';
import { startPageMemoryBridge } from '../../browser/page-memory-bridge';
import {
    MODELS,
    localMessages,
    persistLocal,
    workspace,
    type Agent,
    type Effort,
    type SessionItem,
    type WorktreeInfo,
    sessionCwd,
} from './state.svelte';
import {
    agentLabel,
    chatTurnOptions,
    failSessionWork,
    hasTurnWork,
    queuePaused,
    queued,
    stopTurn,
    turnOptionsOf,
} from './turns.svelte';
import {
    NO_HANDOUT,
    askText,
    liveAsks,
    liveReplies,
    messagesOf,
    runReplies,
    sendNextQueued,
} from './run.svelte';
import {
    addWorkflowWorker,
    addWorkflowWorkerToRun,
    delegateRuns,
    digestOf,
    firstLineOf,
    needsApproval,
    settleWorkflowRun,
    updateWorkflowWorker,
} from './delegation.svelte';
import {
    hasCoordinationPrompt,
    queueCoordinationPrompt,
    shorten,
    taskWaiters,
} from './orchestration.svelte';
import { handbackPrompt, send } from './sending.svelte';
import {
    lastEventAt,
    lastEventKind,
    manuallyStopped,
    owesTurn,
} from './events.svelte';
import { activity } from '../runs/activity.svelte';
import { pathsWrittenInChat } from '../runs/change-ledger';
import { ledgerWrites } from '../runs/change-ledger.svelte';
import { continuePrompt } from '../recovery/turn-failure';
import {
    canonicalRole,
    firstAvailableRoute,
    roleOn,
    routesOf,
} from '../../agents/task-roles';
import { taskRoles } from '../../agents/task-roles.svelte';

// ---------- delegate_task: an agent hands a task to another agent during its own turn ----------
// Claude, Codex, Antigravity and local models can call the app's `delegate_task` tool (src-tauri/src/delegate.rs). The Rust
// side emits the call here and waits for `replyDelegateCall`. A task runs as a child chat under the caller's chat, like an
// `@agent` task, but nothing is called back by the app itself: the worker's compact report (its "## Handoff") is the tool's
// answer. `wait: true` answers when the worker is done (the caller's turn goes on in the same turn). `wait: false` answers
// at once with a task id; when the worker is done its report reaches the caller as a silent hand-back turn, as soon as the
// caller is idle (reports that arrive meanwhile wait in line and go together). The card of the call (TaskCard.svelte) shows
// the task, and stops it.

export const delegateTasks = $state<Record<string, TaskRecord>>({});
const TASKS_KEY = 'delegate.tasks';
const TASK_LIMIT = 200;

/** `cascade`: its parent task was stopped, so it is stopped too and its report has nobody to go to. */
type Ending = 'user' | 'caller' | 'timeout' | 'abort' | 'cascade' | 'chat';
/** Endings whose report is not delivered to the caller: someone stopped the task on purpose. */
const NO_REPORT_ENDINGS: Ending[] = ['user', 'caller', 'cascade', 'chat'];
/** What a running task needs besides its record: the tool call that waits for its report, the timer, why it is ending. */
type TaskRun = {
    /** The worker's first report, kept while its teammates' notes run as turns of their own (see teamNoteDone). */
    report?: { answer: string; workerReply?: Message };
    callId?: string;
    timer?: ReturnType<typeof setTimeout>;
    ending?: Ending;
    /** The time limit of the worker, in seconds; the timer runs only while the worker runs (see `armTaskClock`). */
    timeoutS: number;
    remainingMs: number;
    deadline: number;
    started?: boolean;
    start?: () => void;
    slotRequest?: Promise<boolean>;
    release?: Promise<void>;
    startedReplySent?: boolean;
    announce?: (queued: boolean) => void;
    generation: number;
};
export const taskRuns = new SvelteMap<string, TaskRun>();
const MAX_DELEGATION_DEPTH = 4;

type PendingTaskAsk = {
    id: string;
    taskId: string;
    workerId: string;
    parentId: string;
    question: string;
    callId: string;
    timer: ReturnType<typeof setTimeout>;
};
const pendingTaskAsks = new SvelteMap<string, PendingTaskAsk>();

/** Reports of background tasks waiting for their caller to be idle, per caller. Saved with the tasks (`BACKLOG_KEY`). */
type BackgroundReport = {
    label: string;
    text: string;
    taskId: string;
    sourceMessageId?: string;
    sourceTask: string;
};
export const backlog = new SvelteMap<string, BackgroundReport[]>();
const BACKLOG_KEY = 'delegate.backlog';

/** A task that was lost with the app and has no report yet: its caller hears that it stopped, when the caller is idle. */
function queueLostReport(record: TaskRecord) {
    if ([...backlog.values()].flat().some((item) => item.taskId === record.id))
        return;
    backlog.set(record.caller, [
        ...(backlog.get(record.caller) ?? []),
        {
            taskId: record.id,
            label: `${record.label} (task ${record.id}) - stopped: app restarted`,
            text: formatTaskResult(
                {
                    taskId: record.id,
                    childId: record.childId,
                    label: record.label,
                    verdict: 'stopped',
                    took: span(
                        (record.endedAt ?? Date.now()) - record.startedAt,
                    ),
                },
                RESTORED_LOST_NOTE,
            ),
            sourceMessageId: record.sourceMessageId,
            sourceTask: record.sourceTask ?? record.task,
        },
    ]);
    record.reportState = 'waiting';
}

// Tasks outlive a reload as cards: a task whose worker was running then has no run any more, so it reads as stopped.
const taskStore = $state({ ready: false });
void Promise.all([
    getPref<TaskRecord[]>(TASKS_KEY).catch(() => undefined),
    getPref<[string, BackgroundReport[]][]>(BACKLOG_KEY).catch(() => undefined),
])
    .then(([saved, savedBacklog]) => {
        for (const [callerId, reports] of Array.isArray(savedBacklog)
            ? savedBacklog
            : [])
            if (Array.isArray(reports)) {
                // Watchdog notes (recovering, progress check-ins) are about a worker of the last run: they are stale now.
                const kept = reports.filter(
                    (report) => !/#(check|recover)/.test(report.taskId),
                );
                if (kept.length) backlog.set(callerId, kept);
            }
        for (const item of Array.isArray(saved) ? saved : []) {
            if (delegateTasks[item.id]) continue;
            const lost =
                item.state === 'queued' ||
                item.state === 'waiting' ||
                item.state === 'running' ||
                item.state === 'approval';
            delegateTasks[item.id] = lost
                ? {
                      ...item,
                      state: 'stopped',
                      ...(item.reportState === 'running' ||
                      item.reportState === 'waiting'
                          ? { reportState: 'failed' as const }
                          : {}),
                      endedAt: item.endedAt ?? Date.now(),
                      note: RESTORED_LOST_NOTE,
                  }
                : item.reportState === 'running' ||
                    item.reportState === 'waiting'
                  ? {
                        ...item,
                        reportState: 'failed',
                        note: 'Worker result saved; returning its report was interrupted by reload.',
                    }
                  : item;
            // The caller of a lost task is told it stopped; the report waits in the backlog until the caller is idle.
            if (lost && !item.reportState)
                queueLostReport(delegateTasks[item.id]);
        }
    })
    .catch(() => undefined)
    .finally(() => {
        taskStore.ready = true;
    });
$effect.root(() => {
    $effect(() => {
        if (!taskStore.ready) return;
        const all = (
            JSON.parse(
                JSON.stringify(Object.values(delegateTasks)),
            ) as TaskRecord[]
        ).sort((a, b) => a.startedAt - b.startedAt);
        const active = all.filter(
            (item) =>
                ['queued', 'waiting', 'running', 'approval'].includes(
                    item.state,
                ) ||
                item.reportState === 'waiting' ||
                item.reportState === 'running',
        );
        const activeIds = new Set(active.map((item) => item.id));
        setPref(TASKS_KEY, [
            ...active,
            ...all.filter((item) => !activeIds.has(item.id)).slice(-TASK_LIMIT),
        ]);
        setPref(
            BACKLOG_KEY,
            [...backlog.entries()].map(([callerId, reports]) => [
                callerId,
                JSON.parse(JSON.stringify(reports)) as BackgroundReport[],
            ]),
        );
    });
});

/** Whether this chat is a worker of a task. Workers may delegate within a bounded depth. */
const isTaskChild = (id: string) =>
    Object.values(delegateTasks).some((item) => item.childId === id);

function taskDepth(id: string): number {
    let depth = 0;
    let current = id;
    const seen = new SvelteSet<string>();
    while (!seen.has(current)) {
        seen.add(current);
        const parent = Object.values(delegateTasks).find(
            (item) => item.childId === current,
        );
        if (!parent) break;
        depth++;
        current = parent.caller;
    }
    return depth;
}
/**
 * A chat that only works for another one: a delegated task's worker. A fork also sits under its
 * parent in the tree (`parentId`), but it is a chat of its own: it opens pages and delegates like any other, and its
 * state is its own.
 */
export function isWorkerChat(id: string): boolean {
    return (
        isTaskChild(id) ||
        delegateRuns.some((run) =>
            run.nodes.some((node) => node.childId === id),
        )
    );
}

/** The chat identified by the bridge; an unknown caller must not be assigned to another chat. */
function callerOf(chatId: string): SessionItem | undefined {
    return chatId
        ? workspace.sessions.find((item) => item.id === chatId)
        : undefined;
}

/** The agents `list_agents` shows and `delegate_task` takes: the installed CLIs, then each local provider. */
function agentRows(): AgentRow[] {
    const installed = (tool: string) =>
        Boolean(
            connectors.detected?.tools.find((item) => item.id === tool)?.path,
        );
    const rows: AgentRow[] = [];
    for (const [id, tool] of [
        ['claude', 'claude'],
        ['codex', 'codex'],
        ['antigravity', 'agy'],
        ['opencode', 'opencode'],
        ['workbuddy', 'codebuddy'],
        // The run starts the Copilot CLI itself (copilot.rs start_client), so that binary decides; `gh` is only its sign-in.
        ['copilot', 'copilot'],
        ['command-code', 'command-code'],
    ] as const) {
        const models = (MODELS[id] ?? []).map((item) => ({
            value: item.value,
            label: item.label,
            description: item.description,
        }));
        // Its room is part of the row, so an agent that hands work out does not pick one at its limit.
        const room = roomLine(id);
        const label = `${agentLabel(id)}${room ? `, ${room}` : ''}${agentHasRoom(id) ? '' : ', AT ITS LIMIT: do not use'}`;
        if (models.length && installed(tool)) rows.push({ id, label, models });
    }
    // `workbuddy` as a custom provider is the same chat as the WorkBuddy CLI row (agentKindOf maps the id to the CLI), so it is
    // not a second row: modelSources (the picker) leaves it out too.
    for (const provider of connectors.custom.filter(
        (item) =>
            item.enabled &&
            item.kind !== 'anthropic' &&
            item.id !== 'workbuddy',
    )) {
        const names = provider.models.length
            ? provider.models
            : provider.defaultModel
              ? [provider.defaultModel]
              : [];
        if (names.length)
            rows.push({
                id: provider.id,
                label: provider.name,
                models: names.map((name) => ({ value: name, label: name })),
                restricted: Boolean(provider.restricted),
            });
    }
    return rows;
}

const span = (ms: number) => elapsed(ms);

/** The text a tool answers about a task that has not ended, or has. */
function statusText(record: TaskRecord): string {
    const head = {
        taskId: record.id,
        childId: record.childId,
        label: record.label,
        took: span((record.endedAt ?? Date.now()) - record.startedAt),
    };
    if (
        record.state === 'queued' ||
        record.state === 'waiting' ||
        record.state === 'running' ||
        record.state === 'approval'
    ) {
        return formatTaskResult(
            { ...head, verdict: 'running' },
            record.pausedAt !== undefined
                ? 'Paused by the user. Resume the worker to continue.'
                : record.state === 'waiting'
                  ? `Waiting for ${record.waitingFor?.label ?? "another agent's answer"}.`
                  : record.state === 'approval'
                    ? 'Waiting: the worker needs the user to approve a step in its chat.'
                    : record.state === 'queued'
                      ? `Queued: at most ${MAX_WORKERS} workers run at once; it starts when one finishes.`
                      : 'Still working.',
        );
    }
    const verdict: Verdict =
        record.state === 'done'
            ? 'done'
            : record.state === 'stopped'
              ? 'stopped'
              : 'failed';
    return formatTaskResult(
        { ...head, verdict },
        (record.state === 'done' ? record.digest : record.note) ?? '',
    );
}

/** Links each delegate_task line of a caller's live reply to the task it started (the card reads the task from it). */
export function bindTasks(callerId: string) {
    const reply = liveReplies[callerId];
    if (!reply) return;
    const lines = reply.blocks.filter(
        (block): block is Extract<Block, { kind: 'command' }> =>
            block.kind === 'command' &&
            kindOfCommand(block.command) === 'delegate_task',
    );
    for (const line of lines) {
        // A refused call (status fail) started no task: it must not take a task that a later call started.
        if (line.taskId || line.status === 'fail') continue;
        const taken = new SvelteSet(lines.map((item) => item.taskId));
        const free = Object.values(delegateTasks).filter(
            (item) =>
                item.caller === callerId &&
                item.startedAt >= (reply.startedAt ?? 0) - 1000 &&
                !taken.has(item.id),
        );
        const id = pickTask(
            argsOfCall(line.command.replace(/^\S+\s*/, '')),
            free.map((item) => ({
                id: item.id,
                agent: item.agentId,
                task: item.task,
            })),
        );
        if (id) line.taskId = id;
    }
}

/** Starts the worker of a `delegate_task` call. `reply` answers the call; a task in the background answers at once. */
/** The first route in Settings > Task roles that is available now, including its optional effort. */
function firstRouted(
    role: string,
    rows: AgentRow[],
): { agent: string; model: string; effort?: string } | undefined {
    const id = canonicalRole(role);
    if (!id) return undefined;
    return firstAvailableRoute(routesOf(taskRoles, id), rows, agentHasRoom);
}

/** Creates the worker's worktree from the caller's branch. The caller's own worktree, if any, is the repository. */
async function makeWorkerWorktree(
    caller: SessionItem,
    task: string,
): Promise<WorktreeInfo> {
    if (!inTauri()) throw new Error('worktrees need the desktop app');
    const root = sessionCwd(caller);
    if (!root) throw new Error('the chat has no project folder');
    const base = caller.worktree?.branch ?? caller.gitBranch ?? 'HEAD';
    return invoke<WorktreeInfo>('worktree_create', {
        root,
        slug: worktreeSlug(task),
        base,
    });
}

/** Calls whose worktree is still being made, by their chat. A stop of that chat cancels the worker (see endWaitingTasks). */
const preparingWorktrees = new SvelteSet<{
    caller: string;
    cancelled: boolean;
}>();

/** Removes a worktree made for a call that never started its worker. Best effort: a folder that stays is listed by the repository. */
function discardWorktree(root: string | null, info: WorktreeInfo) {
    if (!root) return;
    void invoke('worktree_remove', {
        root,
        path: info.path,
        branch: info.branch,
        force: true,
    }).catch(() => undefined);
}

/** What planTask reads from the module: the chats, tasks, routes and provider rows as they are now. */
function planStateOf(depth: number): PlanState {
    return {
        depth,
        maxDepth: MAX_DELEGATION_DEPTH,
        tasks: delegateTasks,
        sessions: workspace.sessions,
        rows: agentRows,
        routesFor: (role) => routesOf(taskRoles, role),
        roleOn: (role) => roleOn(taskRoles, role),
        routedFor: (role, rows) => firstRouted(role, rows),
        isRunning: (taskId) => taskRuns.has(taskId),
        customModelId,
        agentKindOf,
    };
}

/** The agent kind a provider row runs as: a built-in CLI, or `custom` for a local provider. */
function agentKindOf(rowId: string): Agent {
    return rowId === 'claude' ||
        rowId === 'codex' ||
        rowId === 'antigravity' ||
        rowId === 'opencode' ||
        rowId === 'workbuddy' ||
        rowId === 'copilot' ||
        rowId === 'command-code'
        ? rowId
        : 'custom';
}

function startTask(
    call: DelegateCall,
    answer: (text: string, isError?: boolean) => void,
    prepared?: WorktreeInfo,
) {
    const caller = callerOf(call.caller);
    // Every check runs first (planTask): a refused call makes no worktree, no chat and no worker.
    const planned = planTask(
        {
            call,
            caller: caller && {
                id: caller.id,
                side: caller.side,
                agent: caller.agent,
                model: caller.model,
            },
        },
        planStateOf(caller ? taskDepth(caller.id) : 0),
    );
    // A worktree made for this call is removed again when the call ends in an error: no worker will ever use it.
    const reply =
        prepared && caller
            ? (text: string, isError?: boolean) => {
                  if (isError) discardWorktree(sessionCwd(caller), prepared);
                  answer(text, isError);
              }
            : answer;
    if (!planned.ok) return reply(planned.error, true);
    const plan = planned.plan;
    const { task, wait, timeoutS, worktree: isolated } = plan.args;
    // The worktree is made only once the call is known to be valid, so a refused call leaves no folder or branch behind.
    // The call then runs again with the worktree in hand (prepared), and discards it if it still fails.
    if (caller && isolated && !prepared) {
        // While the worktree is made the call is not a task yet: a stop of its chat in the meantime cancels it (endWaitingTasks).
        const pending = { caller: caller.id, cancelled: false };
        preparingWorktrees.add(pending);
        const root = sessionCwd(caller);
        void makeWorkerWorktree(caller, task).then(
            (info) => {
                preparingWorktrees.delete(pending);
                if (pending.cancelled) {
                    discardWorktree(root, info);
                    return reply(
                        'the chat was stopped before its worker started, so no worker was made',
                        true,
                    );
                }
                return startTask(call, reply, info);
            },
            (error: unknown) => {
                preparingWorktrees.delete(pending);
                return reply(
                    `Could not create a worktree: ${String(error)}. Run the task with isolation shared, or fix the repository.`,
                    true,
                );
            },
        );
        return;
    }
    if (!caller)
        return reply(
            'AgentDeck could not tell which chat is calling. Do the task yourself, or ask the user to run it from the chat.',
            true,
        );
    const { row, routed, agent, model, dependencies } = plan;
    // `continue`: the chat the plan reuses (found by task id or chat id), or replaced by a new one (`replace`).
    const old = plan.reuse
        ? {
              session: workspace.sessions.find(
                  (item) => item.id === plan.reuse?.sessionId,
              )!,
              record: plan.reuse.recordId
                  ? delegateTasks[plan.reuse.recordId]
                  : undefined,
          }
        : undefined;
    const replace = Boolean(old && plan.reuse?.replace);
    const reuse = old && !replace ? old : undefined;
    let workerTask = task;
    if (replace && old) {
        const transcript = digestOf(
            messagesOf(old.session.id).filter((message) =>
                message.blocks.some((block) =>
                    block.kind === 'response'
                        ? Boolean(block.text.trim())
                        : block.kind === 'command' &&
                          Boolean(block.command.trim()),
                ),
            ),
        );
        const report = old.record?.digest ?? '';
        // A failed or stopped worker's note says why, and the replacement starts from it.
        const failed =
            old.record?.state === 'failed' || old.record?.state === 'stopped';
        const reason = failed
            ? (old.record?.note ?? `Previous worker ${old.record?.state}.`)
            : '';
        workerTask = replacementTask(
            task,
            old.record?.label ??
                `${agentLabel(old.session.agent, old.session.model)} · ${modelLabel(old.session.model ?? '')}`,
            transcript,
            report,
            reason,
        );
    }
    // Check every byte of the seed as well as the new request before selecting a restricted provider.
    const leak = row.restricted ? privateContentIn(workerTask) : null;
    if (leak)
        return reply(
            `Not sent: ${row.label} is a free tier that may keep what it is sent, and this task holds ${leak}. Do this part yourself or give it to another agent; send the free tier only public, non-sensitive text.`,
            true,
        );
    let taskId = newTaskId();
    while (delegateTasks[taskId]) taskId = newTaskId();

    const uuid = crypto.randomUUID();
    const id = reuse ? reuse.session.id : `${agent}:${uuid}`;
    const label = `${agentLabel(agent, model)} · ${modelLabel(model)}${routed?.effort ? ` · ${effortLabel(routed.effort)}` : ''}`;
    if (replace && old)
        for (const record of Object.values(delegateTasks))
            if (record.childId === old.session.id)
                record.replacementChildId = id;
    const originatingRun = [...runReplies.values()].find(
        (run) =>
            run.sessionId === caller.id &&
            run.reply.blocks.some(
                (block) =>
                    block.kind === 'command' &&
                    kindOfCommand(block.command) === 'delegate_task' &&
                    argsOfCall(block.command.replace(/^\S+\s*/, '')).task ===
                        task,
            ),
    );
    const source = originatingRun?.ask ?? liveAsks[caller.id];
    if (!reuse)
        workspace.sessions.push({
            id,
            projectId: caller.projectId,
            title: `@${agentLabel(agent, model)}: ${firstLineOf(task, 50)}`,
            agent,
            agentSession: agent === 'claude' ? uuid : undefined,
            model,
            gitBranch: caller.gitBranch,
            status: 'idle',
            parentId: caller.id,
            draft: false,
            worktree: prepared,
        });
    // A chat with no messages and no draft flag is not a local chat: the next history import rebuilt the list without it, and a
    // worker waiting for a free place then had no chat to start in.
    localMessages[id] ??= [];
    delegateTasks[taskId] = {
        id: taskId,
        caller: caller.id,
        sourceMessageId: source?.id,
        sourceTask: source ? askText(source) : task,
        childId: id,
        state: 'queued',
        dependsOn: dependencies,
        wait,
        label,
        agent,
        agentId: row.id,
        model,
        task,
        startedAt: Date.now(),
    };
    const parentRecord = Object.values(delegateTasks).find(
        (item) => item.childId === caller.id && item.id !== taskId,
    );
    delegateTasks[taskId].workflowRunId = parentRecord?.workflowRunId
        ? addWorkflowWorkerToRun(
              parentRecord.workflowRunId,
              id,
              agent,
              model,
              label,
              task,
              true,
          )
        : addWorkflowWorker(caller.id, id, agent, model, label, task, true);
    // The time limit runs while the worker runs, not while it waits for a place or a dependency: the blocking call is held
    // until then (armTaskClock starts both).
    const run: TaskRun = {
        callId: wait ? call.callId : undefined,
        timeoutS,
        remainingMs: timeoutS * 1000,
        deadline: 0,
        generation: 0,
    };
    taskRuns.set(taskId, run);
    holdTaskClock(taskId);
    // The worker runs with the settings of the chat that called it, not with those of whichever chat is on screen.
    chatTurnOptions[id] = {
        ...turnOptionsOf(caller.id),
        ...(routed?.effort ? { effort: routed.effort as Effort } : {}),
    };
    bindTasks(caller.id);

    // The worker's end: its report, or why there is none. A worker stopped on an approval card waits for the user's yes.
    const settle = (
        answer: string,
        error: string | null,
        workerReply?: import('../mock').Message,
    ) => {
        const record = delegateTasks[taskId];
        if (!record || !taskRuns.has(taskId)) return;
        // Pausing ends only the provider turn. Keep the task's completion waiter for Resume.
        if (record.pausedAt !== undefined && !run.ending) {
            taskWaiters.set(id, settle);
            return;
        }
        if (!run.ending && !error && needsApproval(id)) {
            record.state = 'approval';
            taskWaiters.set(id, settle);
            return;
        }
        // Teammates' notes queued for this worker run as turns of their own, after this one. This turn's answer is the
        // report: it is kept until the note turns are over (teamNoteDone settles it).
        if (!run.ending && !error && hasCoordinationPrompt(id)) {
            run.report ??= { answer, workerReply };
            taskWaiters.set(id, settle);
            sendNextQueued(id);
            return;
        }
        const verdict: Verdict = run.ending
            ? run.ending === 'timeout'
                ? 'timed out'
                : 'stopped'
            : error === 'stopped'
              ? 'stopped'
              : error || !answer
                ? 'failed'
                : 'done';
        finishTask(
            taskId,
            verdict,
            run.ending ? '' : (error ?? ''),
            answer,
            workerReply,
        );
    };
    taskWaiters.set(id, settle);
    const languageRule = workerLanguageRule(
        delegateTasks[taskId].sourceTask ?? task,
        usagePct(row.id, model),
    );
    const brief = reuse
        ? `${FOLLOW_UP_PREFACE} ${REPORT_RULE} ${languageRule}`
        : `You were asked by another agent (${agentLabel(caller.agent, caller.model)}), who is working for the user in this project, to do the task below on your own. Answer fully, as you would for the user. ${REPORT_RULE} ${languageRule}${isolated ? ` ${WORKTREE_RULE}` : ''}`;
    // At most MAX_PARALLEL_WORKERS run at once (delegate.rs keeps the line); explicit dependencies add another gate.
    run.start = () => {
        const record = delegateTasks[taskId];
        if (
            !record ||
            record.pausedAt !== undefined ||
            record.state !== 'queued' ||
            !taskRuns.has(taskId)
        )
            return;
        const blocked = dependencyBlock(record);
        if (blocked) {
            if (blocked.failed) {
                finishTask(
                    taskId,
                    'failed',
                    `Dependency ${blocked.record.id} did not finish successfully.`,
                    '',
                );
                return;
            }
            record.state = 'waiting';
            record.waitingFor = {
                taskId: blocked.record.id,
                label: `${blocked.record.label}'s result`,
            };
            updateWorkflowWorker(
                record.workflowRunId,
                record.childId,
                'idle',
                `Waiting for ${record.waitingFor.label}`,
            );
            void releaseSlot(taskId);
            persistLocal();
            return;
        }
        delete record.waitingFor;
        record.state = 'running';
        armTaskClock(taskId);
        if (!run.started) record.startedAt = Date.now();
        updateWorkflowWorker(record.workflowRunId, record.childId, 'running');
        delete manuallyStopped[id];
        if (run.started)
            send(id, '', [], [], [], {
                prompt: continuePrompt(
                    'the user paused this worker',
                    true,
                    record.task,
                ),
                silent: NO_HANDOUT,
            });
        if (!run.started) {
            const dependencyReports = (record.dependsOn ?? [])
                .map((dependencyId) => delegateTasks[dependencyId])
                .filter((dependency): dependency is TaskRecord =>
                    Boolean(dependency),
                )
                .map(
                    (dependency) =>
                        `### ${dependency.label}\n${shorten(dependency.digest ?? dependency.note ?? 'No report was saved.', 6000)}`,
                )
                .join('\n\n');
            // Plan 6.3, trigger 4: the files the dependencies changed come from the ledger, not from their reports.
            const changed = [
                ...new Set(
                    (record.dependsOn ?? []).flatMap((dependencyId) => {
                        const childId = delegateTasks[dependencyId]?.childId;
                        return childId
                            ? pathsWrittenInChat(ledgerWrites, childId)
                            : [];
                    }),
                ),
            ];
            const changedBlock = changed.length
                ? `\n\nFiles the dependencies changed (AgentDeck's change ledger; re-read them before you rely on them):\n${changed.map((path) => `- ${path}`).join('\n')}`
                : '';
            const prompt =
                (dependencyReports
                    ? `${workerTask}\n\nAgentDeck dependency reports (use these as input, then verify what matters):\n${dependencyReports}`
                    : workerTask) + changedBlock;
            send(id, prompt, [], [], [], { preface: `${brief}\n\n` });
        }
        run.started = true;
        persistLocal();
    };
    persistLocal();
    logFlow(id, 'worker slot', `task=${taskId} asks for a place`);
    run.announce = (queued) => {
        if (wait || run.startedReplySent) return;
        run.startedReplySent = true;
        reply(startedText({ taskId, childId: id, label }, queued));
    };
    requestTaskSlot(taskId);
}

/** The time limit of a task and of its blocking call (if any) runs only while the worker runs. */
function armTaskClock(taskId: string): void {
    const run = taskRuns.get(taskId);
    if (!run) return;
    if (run.callId) void runDelegateCall(run.callId).catch(() => undefined);
    if (run.timer) return;
    run.deadline = Date.now() + run.remainingMs;
    run.timer = setTimeout(
        () =>
            stopTask(
                taskId,
                'timeout',
                `Timed out after ${run.timeoutS} s: the worker was stopped before it finished.`,
            ),
        run.remainingMs,
    );
}

/** The time limit stops: the task waits for a place, a dependency or the user, and keeps what is left of it. */
function holdTaskClock(taskId: string): void {
    const run = taskRuns.get(taskId);
    if (!run) return;
    if (run.timer) {
        clearTimeout(run.timer);
        run.timer = undefined;
        run.remainingMs = Math.max(1, run.deadline - Date.now());
    }
    if (run.callId) void holdDelegateCall(run.callId).catch(() => undefined);
}

/**
 * A worker's place in Rust's gate. A failed request is sent once more; if it fails again the error goes to the caller,
 * which fails the task. Nothing is granted by default: a place that Rust never recorded would be lost on release.
 */
async function askWorkerSlot(taskId: string, owner: string): Promise<boolean> {
    try {
        return await enterWorkerSlot(taskId, owner);
    } catch (error) {
        console.warn(
            `delegate_enter failed for ${taskId}, retrying once:`,
            error,
        );
        return enterWorkerSlot(taskId, owner);
    }
}

/**
 * Gives a place back. A failed release is retried: a place left taken blocks the tasks queued behind it until reload.
 * Never rejects; a release that still fails after its retries is logged.
 */
async function releaseSlot(taskId: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await releaseWorkerSlot(taskId);
            return;
        } catch (error) {
            console.warn(
                `delegate_release failed for ${taskId} (attempt ${attempt} of 3):`,
                error,
            );
            if (attempt < 3)
                await new Promise((resolve) =>
                    setTimeout(resolve, 500 * attempt),
                );
        }
    }
}

/** The worker waits for a place: the function that starts it once the place is given. */
const slotStarts = new SvelteMap<string, () => void>();
function startQueued(taskId: string) {
    const start = slotStarts.get(taskId);
    slotStarts.delete(taskId);
    start?.();
}

function dependencyBlock(
    record: TaskRecord,
): { record: TaskRecord; failed: boolean } | undefined {
    const dependencies = (record.dependsOn ?? [])
        .map((id) => delegateTasks[id])
        .filter((item): item is TaskRecord => Boolean(item));
    const failed = dependencies.find(
        (item) => item.state === 'failed' || item.state === 'stopped',
    );
    if (failed) return { record: failed, failed: true };
    const waiting = dependencies.find((item) => item.state !== 'done');
    return waiting ? { record: waiting, failed: false } : undefined;
}

function requestTaskSlot(taskId: string): void {
    const record = delegateTasks[taskId];
    const run = taskRuns.get(taskId);
    if (
        !record ||
        !run ||
        !run.start ||
        run.slotRequest ||
        run.started ||
        record.pausedAt !== undefined
    )
        return;
    slotStarts.set(taskId, run.start);
    run.slotRequest = askWorkerSlot(taskId, record.caller);
    const generation = run.generation;
    void run.slotRequest.then(
        (granted) => {
            run.slotRequest = undefined;
            logFlow(
                record.childId,
                'worker slot',
                `task=${taskId} ${granted ? 'granted' : 'waits in line'}`,
            );
            if (!taskRuns.has(taskId)) {
                void releaseSlot(taskId);
                return;
            }
            run.announce?.(!granted);
            if (generation !== run.generation) return;
            if (granted) startQueued(taskId);
        },
        (error: unknown) => {
            run.slotRequest = undefined;
            if (!taskRuns.has(taskId) || generation !== run.generation) return;
            slotStarts.delete(taskId);
            finishTask(taskId, 'failed', slotFailure(error), '');
        },
    );
}

/** Why a task could not get a worker place: the caller is told, and the task fails. */
function slotFailure(error: unknown): string {
    return `AgentDeck could not reserve a worker slot (${String(error)}), so the worker did not start.`;
}

function wakeDependentTasks(completedId: string): void {
    for (const record of Object.values(delegateTasks)) {
        if (
            !taskRuns.has(record.id) ||
            record.state !== 'waiting' ||
            !record.dependsOn?.includes(completedId)
        )
            continue;
        const blocked = dependencyBlock(record);
        if (blocked?.failed)
            finishTask(
                record.id,
                'failed',
                `Dependency ${blocked.record.id} did not finish successfully.`,
                '',
            );
        else if (!blocked) {
            delete record.waitingFor;
            record.state = 'queued';
            updateWorkflowWorker(
                record.workflowRunId,
                record.childId,
                'idle',
                'Ready after dependencies completed',
            );
            requestTaskSlot(record.id);
        }
    }
}

function cancelTaskAsk(
    questionId: string,
    reason: string,
    isError = true,
    replyText = reason,
): void {
    const pending = pendingTaskAsks.get(questionId);
    if (!pending) return;
    pendingTaskAsks.delete(questionId);
    clearTimeout(pending.timer);
    const record = delegateTasks[pending.taskId];
    if (record) {
        delete record.waitingFor;
        if (taskRuns.has(record.id) && record.state === 'waiting') {
            record.state = 'running';
            updateWorkflowWorker(
                record.workflowRunId,
                record.childId,
                'running',
                reason,
            );
        }
    }
    void replyDelegateCall(pending.callId, replyText, isError).catch(
        () => undefined,
    );
}

function askParent(
    call: DelegateCall,
    answer: (text: string, isError?: boolean) => void,
): void {
    const question =
        typeof call.args.question === 'string' ? call.args.question.trim() : '';
    if (!question)
        return answer(
            'question is required: ask the parent for one focused decision or missing context',
            true,
        );
    if (question.length > 30_000)
        return answer('question is longer than 30000 characters', true);
    const record = Object.values(delegateTasks).find(
        (item) => item.childId === call.caller && taskRuns.has(item.id),
    );
    if (!record)
        return answer(
            'task_ask can only be called by a running delegated worker.',
            true,
        );
    if (record.waitingFor?.questionId)
        return answer(
            'This worker is already waiting for an agent answer.',
            true,
        );
    const parentRun = Object.values(delegateTasks).find(
        (item) => item.childId === record.caller && taskRuns.has(item.id),
    );
    if (
        taskRuns.get(record.id)?.callId ||
        (parentRun && taskRuns.get(parentRun.id)?.callId)
    ) {
        const blockingLabel =
            parentRun?.label ??
            agentLabel(parentAgent(record.caller), parentModel(record.caller));
        return answer(
            `Cannot ask ${blockingLabel} while it is synchronously waiting for your report. Use your own best judgement to avoid a delegation deadlock.`,
            true,
        );
    }
    const parent = callerOf(record.caller);
    if (!parent)
        return answer(
            'AgentDeck could not find the parent chat for this task.',
            true,
        );
    let questionId = newTaskId();
    while (pendingTaskAsks.has(questionId)) questionId = newTaskId();
    const label = `${agentLabel(parent.agent, parent.model)}'s answer`;
    const timer = setTimeout(
        () =>
            cancelTaskAsk(
                questionId,
                `No answer arrived for ${label} before the coordination wait expired.`,
            ),
        QUESTION_WAIT_MS,
    );
    pendingTaskAsks.set(questionId, {
        id: questionId,
        taskId: record.id,
        workerId: record.childId,
        parentId: record.caller,
        question,
        callId: call.callId,
        timer,
    });
    record.state = 'waiting';
    record.waitingFor = { questionId, label, question };
    updateWorkflowWorker(
        record.workflowRunId,
        record.childId,
        'idle',
        `Waiting for ${label}`,
    );
    persistLocal();
    const prompt = `[AgentDeck coordination]
${record.label} needs your input before it can continue.
question_id: ${questionId}
Question: ${question}

Call task_answer with this question_id and a focused answer. Do not write a normal user-facing reply for this coordination turn; answer the child through task_answer, then continue your own work.`;
    queueCoordinationPrompt(record.caller, {
        prompt,
        silent: NO_HANDOUT,
        questionId,
    });
    sendNextQueued(record.caller);
    logFlow(record.childId, 'task ask', `task=${record.id} waits for ${label}`);
}

/**
 * A teammate's note turn of a worker ended (answered or failed). The next queued note runs first; when none is left,
 * the worker's first report is settled, so the task ends with the report it gave before the notes.
 */
export function teamNoteDone(childId: string): void {
    const record = Object.values(delegateTasks).find(
        (item) => item.childId === childId && taskRuns.has(item.id),
    );
    const waiter = taskWaiters.get(childId);
    if (!record || !waiter) return;
    if (hasCoordinationPrompt(childId)) return sendNextQueued(childId);
    // No report kept: the note ran while the worker was paused or waiting for an approval. Its real end still comes.
    const report = taskRuns.get(record.id)?.report;
    if (!report) return;
    taskWaiters.delete(childId);
    waiter(report.answer, null, report.workerReply);
}

/** Fallback for a parent that answered the hidden coordination turn in prose instead of calling task_answer. */
export function answerPendingTaskQuestion(
    questionId: string,
    parentId: string,
    response: string,
): boolean {
    const pending = pendingTaskAsks.get(questionId);
    if (!pending || pending.parentId !== parentId || !response.trim())
        return false;
    const record = delegateTasks[pending.taskId];
    const parentLabel = agentLabel(
        parentAgent(parentId),
        parentModel(parentId),
    );
    cancelTaskAsk(
        questionId,
        '',
        false,
        `Answer from ${parentLabel}: ${response.trim()}`,
    );
    if (record) {
        record.state = 'running';
        delete record.waitingFor;
        updateWorkflowWorker(
            record.workflowRunId,
            record.childId,
            'running',
            `Received ${parentLabel}'s answer`,
        );
        persistLocal();
    }
    return true;
}

function answerTaskQuestion(
    call: DelegateCall,
    answer: (text: string, isError?: boolean) => void,
): void {
    const questionId =
        typeof call.args.question_id === 'string'
            ? call.args.question_id.trim()
            : '';
    const response =
        typeof call.args.answer === 'string' ? call.args.answer.trim() : '';
    if (!questionId || !response)
        return answer('question_id and answer are required.', true);
    const pending = pendingTaskAsks.get(questionId);
    if (!pending)
        return answer(
            `No pending task question ${questionId}. It may already be answered or expired.`,
            true,
        );
    if (pending.parentId !== call.caller)
        return answer(
            'Only the parent agent that received this question can answer it.',
            true,
        );
    const record = delegateTasks[pending.taskId];
    answerPendingTaskQuestion(questionId, call.caller, response);
    answer(`Answer delivered to ${record?.label ?? 'the child agent'}.`);
}

/**
 * A worker's note to a sibling worker (same parent, so the same team). Queued like a coordination prompt: the receiver
 * reads it after its current turn. Only a task that is still running can receive it.
 */
function teamMessage(
    call: DelegateCall,
    answer: (text: string, isError?: boolean) => void,
): void {
    const to = typeof call.args.to === 'string' ? call.args.to.trim() : '';
    const message =
        typeof call.args.message === 'string' ? call.args.message.trim() : '';
    if (!to || !message) return answer('to and message are required.', true);
    const sender = Object.values(delegateTasks).find(
        (item) => item.childId === call.caller && taskRuns.has(item.id),
    );
    if (!sender)
        return answer(
            'Only a running worker has teammates: team_message works between the workers of one parent.',
            true,
        );
    const target = delegateTasks[to];
    if (!target || target.caller !== sender.caller) {
        const teammates = Object.values(delegateTasks)
            .filter(
                (item) =>
                    item.caller === sender.caller &&
                    item.id !== sender.id &&
                    taskRuns.has(item.id),
            )
            .map((item) => `${item.id} (${item.label})`);
        return answer(
            `No running teammate ${to}.${teammates.length ? ` Running teammates: ${teammates.join(', ')}.` : ' This parent has no other running worker.'}`,
            true,
        );
    }
    if (target.id === sender.id)
        return answer('A worker cannot message itself.', true);
    if (!taskRuns.has(target.id))
        return answer(
            `${target.label} is no longer running, so it cannot read the message. Use task_status or delegate_task continue=${target.id}.`,
            true,
        );
    const prompt = `[AgentDeck coordination]
Message from teammate ${sender.label} (task ${sender.id}):
${message}

Read this before your next step. Keep working on your own task. If it changes your work or you need something from them, answer with team_message to: ${sender.id}.`;
    queueCoordinationPrompt(target.childId, {
        prompt,
        silent: NO_HANDOUT,
        deliverable: () => taskRuns.has(target.id),
        teamNote: true,
    });
    sendNextQueued(target.childId);
    logFlow(
        sender.childId,
        'team message',
        `task=${sender.id} -> task=${target.id}`,
    );
    answer(
        `Message queued for ${target.label}. It is read after that teammate's current turn, and dropped if the teammate has finished by then.`,
    );
}

function parentAgent(chatId: string): Agent {
    return (
        workspace.sessions.find((item) => item.id === chatId)?.agent ?? 'custom'
    );
}

function parentModel(chatId: string): string | undefined {
    return workspace.sessions.find((item) => item.id === chatId)?.model;
}

/**
 * Ends a task: the record, the worker's chat, and the answer: to the tool call that waits, or to the caller in line.
 * Exported for the tests (tests/chat-flow.test.mjs); the app ends tasks through stopTask and settle.
 */
export function finishTask(
    taskId: string,
    verdict: Verdict,
    detail: string,
    answer: string,
    workerReply?: import('../mock').Message,
) {
    const record = delegateTasks[taskId];
    const run = taskRuns.get(taskId);
    if (!record || !run) return;
    if (verdict === 'failed' || verdict === 'timed out')
        failSessionWork(record.caller);
    clearTimeout(run.timer);
    taskRuns.delete(taskId);
    slotStarts.delete(taskId);
    // Its place goes to the next one in line (a task that never started leaves the line).
    logFlow(
        record.childId,
        'worker slot',
        `task=${taskId} released (${verdict})`,
    );
    void releaseSlot(taskId);
    taskWaiters.delete(record.childId);
    record.endedAt = Date.now();
    delete record.pausedAt;
    delete record.waitingFor;
    record.state =
        verdict === 'done'
            ? 'done'
            : verdict === 'stopped'
              ? 'stopped'
              : 'failed';
    const detailOf =
        run.ending === 'caller'
            ? 'you stopped it with task_stop'
            : run.ending === 'abort'
              ? 'the agent that asked was stopped'
              : run.ending === 'cascade'
                ? 'the task that asked for it was stopped'
                : run.ending === 'chat'
                  ? 'the chat was stopped'
                  : detail;
    const body =
        verdict === 'done'
            ? reportDigest(answer)
            : reasonLine(verdict, detailOf);
    if (verdict === 'done') record.digest = body;
    else {
        record.note = body;
        if (answer.trim()) record.digest = reportDigest(answer);
    }
    updateWorkflowWorker(
        record.workflowRunId,
        record.childId,
        verdict === 'done' ? 'done' : 'failed',
        body,
        workerReply,
    );
    wakeDependentTasks(taskId);
    // Stopped by the user, the caller or a stopped parent: no report is delivered, so nothing else would ever close the flow run.
    if (run.ending && NO_REPORT_ENDINGS.includes(run.ending)) {
        const sameRun = (other: TaskRecord) =>
            other.id !== taskId && other.workflowRunId === record.workflowRunId;
        const pending =
            Object.values(delegateTasks).some(
                (other) =>
                    sameRun(other) &&
                    (other.reportState === 'waiting' ||
                        other.reportState === 'running'),
            ) ||
            (backlog.get(record.caller) ?? []).some(
                (report) =>
                    report.taskId !== taskId &&
                    delegateTasks[report.taskId]?.workflowRunId ===
                        record.workflowRunId,
            );
        settleWorkflowRun(record.workflowRunId, pending);
        // A sibling's report may be held for this task (see flushReports): it no longer has to wait.
        if (backlog.get(record.caller)?.length) sendNextQueued(record.caller);
    }
    const text = formatTaskResult(
        {
            taskId,
            childId: record.childId,
            label: record.label,
            verdict,
            took: span(record.endedAt - record.startedAt),
        },
        body,
    );
    // The backlog is the fallback for a report nobody waits for. Only a task someone stopped on purpose (NO_REPORT_ENDINGS)
    // loses it. An aborted one (its connection lost, or its caller ended the turn) still reports (D-B, plan_next.md); a
    // timed-out one gets one notice: the waiting call, or else this fallback.
    const toCaller = () => {
        if (run.ending && NO_REPORT_ENDINGS.includes(run.ending)) return;
        deliverReport(record.caller, {
            taskId,
            sourceMessageId: record.sourceMessageId,
            sourceTask: record.sourceTask ?? record.task,
            label: `${record.label} (task ${taskId})`,
            text: verdict === 'done' ? body : reasonLine(verdict, detailOf),
        });
    };
    if (!run.callId) return toCaller();
    // A waiting caller whose call was already dropped on the Rust side (its timeout, or its connection closed) gets the
    // report through the backlog instead: a report that nobody receives is lost otherwise.
    void replyDelegateCall(
        run.callId,
        text,
        verdict === 'failed' || verdict === 'timed out',
    )
        .then((delivered) => {
            if (!delivered) toCaller();
        })
        .catch(toCaller);
}

/** Stops a task: its worker's run is killed and the task ends as stopped (or timed out). */
function stopTask(taskId: string, how: Ending, detail = '') {
    const record = delegateTasks[taskId];
    const run = taskRuns.get(taskId);
    if (!record || !run) return;
    for (const pending of pendingTaskAsks.values())
        if (pending.taskId === taskId)
            cancelTaskAsk(
                pending.id,
                detail || 'The worker was stopped before the parent answered.',
                true,
            );
    run.ending = how;
    // The tasks this worker delegated work for it: they stop with it, and their reports would go to a chat nobody waits for.
    for (const child of Object.values(delegateTasks))
        if (child.caller === record.childId && taskRuns.has(child.id))
            stopTask(
                child.id,
                'cascade',
                `Its parent task ${taskId} was stopped.`,
            );
    // The worker's run ends with an error event that settles the task (see `settle`). One with no run (it waits on an
    // approval card) is ended here.
    stopTurn(record.childId);
    if (taskRuns.has(taskId))
        finishTask(
            taskId,
            how === 'timeout' ? 'timed out' : 'stopped',
            detail,
            '',
        );
}

/** The Stop button of a task's card. */
export function stopDelegateTask(taskId: string) {
    stopTask(taskId, 'user');
}

/** The user answered an approval card in a worker's chat: "no" ends its task, "yes" puts it back to running. */
export function answerWorkerApproval(childId: string, allowed: boolean) {
    const record = Object.values(delegateTasks).find(
        (item) => item.childId === childId && item.state === 'approval',
    );
    if (!record) return;
    if (allowed) record.state = 'running';
    else stopTask(record.id, 'user');
}

/** Pauses one worker without completing its task or returning a partial report to the caller. */
export function pauseDelegateTask(taskId: string): void {
    const record = delegateTasks[taskId];
    const run = taskRuns.get(taskId);
    if (
        !record ||
        !run ||
        record.pausedAt !== undefined ||
        !['queued', 'running'].includes(record.state)
    )
        return;
    record.pausedAt = Date.now();
    holdTaskClock(taskId);
    run.generation++;
    slotStarts.delete(taskId);
    manuallyStopped[record.childId] = true;
    if (run.started) stopTurn(record.childId);
    // Wait for an outstanding grant before releasing it; a quick Resume must not lose its new slot.
    run.release = (run.slotRequest ?? Promise.resolve(false))
        .catch(() => false)
        .then(() => releaseSlot(taskId));
    updateWorkflowWorker(
        record.workflowRunId,
        record.childId,
        'idle',
        'Paused by you',
    );
}

/** Resumes in the same child conversation and returns the final result to the original task. */
export async function resumeDelegateTask(taskId: string): Promise<void> {
    const record = delegateTasks[taskId];
    const run = taskRuns.get(taskId);
    if (!record || !run || record.pausedAt === undefined || !run.start) return;
    delete record.pausedAt;
    record.state = 'queued';
    const generation = ++run.generation;
    // The time limit starts again when the worker runs (run.start), not now: it waits in line first.
    await run.release;
    if (!taskRuns.has(taskId) || generation !== run.generation) return;
    slotStarts.set(taskId, run.start);
    run.slotRequest = askWorkerSlot(taskId, record.caller);
    let granted: boolean;
    try {
        granted = await run.slotRequest;
    } catch (error) {
        if (generation !== run.generation || !taskRuns.has(taskId)) return;
        slotStarts.delete(taskId);
        finishTask(taskId, 'failed', slotFailure(error), '');
        return;
    }
    if (generation !== run.generation) return;
    if (!taskRuns.has(taskId)) {
        void releaseSlot(taskId);
        return;
    }
    if (granted) startQueued(taskId);
}

function deliverReport(callerId: string, report: BackgroundReport) {
    const list = backlog.get(callerId) ?? [];
    if (list.some((item) => item.taskId === report.taskId)) return;
    list.push(report);
    backlog.set(callerId, list);
    const record = delegateTasks[report.taskId];
    if (record) record.reportState = 'waiting';
    sendNextQueued(callerId);
}

/** Returns a saved worker result without rerunning the completed work after an interrupted summary. */
export function returnTaskResult(taskId: string): void {
    const record = delegateTasks[taskId];
    if (
        !record ||
        record.state !== 'done' ||
        record.reportState !== 'failed' ||
        !record.digest
    )
        return;
    deliverReport(record.caller, {
        taskId,
        sourceMessageId: record.sourceMessageId,
        sourceTask: record.sourceTask ?? record.task,
        label: record.label,
        text: record.digest,
    });
}

/** When a ready report of a request started waiting for the other workers of that request (`caller|sourceMessageId`). */
const siblingHold = new SvelteMap<string, number>();
const siblingTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();

/** Delivers reports from one original request when the chat is idle; unrelated requests are never merged. */
export function flushReports(callerId: string) {
    const list = backlog.get(callerId);
    if (!list?.length) return;
    if (!workspace.sessions.some((item) => item.id === callerId)) {
        backlog.delete(callerId);
        return;
    }
    // A failed turn still owed a retry or an account switch is not finished: a hand-back sent now would take it over
    // (sendNextQueued runs again when that turn ends, so the report goes out then).
    if (
        hasTurnWork(callerId) ||
        owesTurn(callerId) ||
        queuePaused[callerId] ||
        queued[callerId]?.length
    )
        return;
    const origin = list[0];
    const batch = list.filter(
        (report) =>
            report.sourceMessageId === origin.sourceMessageId &&
            report.sourceTask === origin.sourceTask,
    );
    // Workers of the same request still running: the lead gets their reports together, in one hand-back, rather than
    // answering once per worker. It waits at most SIBLING_WAIT_MS from the first ready report, then gets what is there.
    const holdKey = `${callerId}|${origin.sourceMessageId ?? ''}`;
    const siblings = pendingSiblings(
        Object.values(delegateTasks),
        callerId,
        origin.sourceMessageId,
        batch.map((report) => report.taskId),
    );
    if (siblings.length) {
        const since = siblingHold.get(holdKey) ?? Date.now();
        siblingHold.set(holdKey, since);
        const left = since + SIBLING_WAIT_MS - Date.now();
        if (left > 0) {
            clearTimeout(siblingTimers.get(holdKey));
            siblingTimers.set(
                holdKey,
                setTimeout(() => {
                    siblingTimers.delete(holdKey);
                    sendNextQueued(callerId);
                }, left),
            );
            logFlow(
                callerId,
                'hand-back',
                `held for ${siblings.map((task) => task.id).join(', ')}`,
            );
            return;
        }
    }
    siblingHold.delete(holdKey);
    clearTimeout(siblingTimers.get(holdKey));
    siblingTimers.delete(holdKey);
    const rest = list.filter((report) => !batch.includes(report));
    if (rest.length) backlog.set(callerId, rest);
    else backlog.delete(callerId);
    const taskIds = batch.map((report) => report.taskId);
    for (const id of taskIds)
        if (delegateTasks[id]) delegateTasks[id].reportState = 'running';
    send(callerId, '', [], [], [], {
        prompt: handbackPrompt({ results: batch, task: origin.sourceTask }),
        silent: NO_HANDOUT,
        report: {
            triggeredByMessageId: origin.sourceMessageId,
            taskTitle: origin.sourceTask,
            taskIds,
            workflowRunId: delegateTasks[taskIds[0]]?.workflowRunId,
        },
        // A reply started before this hand-back could (a deferred send woke late): the report waits in line again and goes
        // out when the chat is idle, instead of being lost with its task stuck on "returning".
        onDropped: () => {
            const again = backlog.get(callerId) ?? [];
            for (const report of batch)
                if (!again.some((item) => item.taskId === report.taskId))
                    again.unshift(report);
            backlog.set(callerId, again);
            for (const id of taskIds)
                if (delegateTasks[id])
                    delegateTasks[id].reportState = 'waiting';
        },
    });
}

/**
 * A worker's turn failed and AgentDeck is recovering it (a retry, or another agent takes over): its caller gets a check-in
 * with the reason, through the watchdog's check-in path. A caller that waits for the report gets nothing here (it is blocked).
 */
export function noteWorkerRecovering(childId: string, reason: string) {
    const record = Object.values(delegateTasks).find(
        (item) => item.childId === childId && taskRuns.has(item.id),
    );
    const run = record ? taskRuns.get(record.id) : undefined;
    if (!record || !run || run.callId) return;
    logFlow(
        record.childId,
        'watchdog',
        `task=${record.id} recovering: ${reason}`,
    );
    deliverReport(record.caller, {
        // A fixed id: the backlog keeps one note per task, however many recoveries it went through (see deliverReport).
        taskId: `${record.id}#recover`,
        sourceMessageId: record.sourceMessageId,
        sourceTask: record.sourceTask ?? record.task,
        label: `${record.label} (task ${record.id}) - recovering`,
        text: `recovering: ${reason}. The worker is being recovered by AgentDeck, not finished yet. Check it with task_status ${record.id} if you need to; the report comes when it ends.`,
    });
}

/**
 * A caller's turn ended: the tasks it was waiting for have nobody to answer, so they stop. Background ones go on.
 * `stopped`: the user stopped the caller, so the tasks end as stopped by the chat (no report).
 */
export function endWaitingTasks(callerId: string, stopped = false) {
    // A worktree still being made for this chat's call: a stop cancels its worker (see startTask).
    if (stopped)
        for (const pending of preparingWorktrees)
            if (pending.caller === callerId) pending.cancelled = true;
    for (const record of Object.values(delegateTasks)) {
        if (
            record.caller === callerId &&
            record.wait &&
            taskRuns.has(record.id)
        )
            stopTask(record.id, stopped ? 'chat' : 'abort');
    }
}

// ---------- watchdog: a worker that takes long is checked by its caller, a hung one is stopped ----------

/** First check-in after this long; the next ones come after twice the time before (10, 20, 40 min...). */
const CHECK_IN_MS = 10 * 60_000;
/** A worker silent this long (no event from its CLI) is asked about. */
const QUIET_MS = 4 * 60_000;
/** A worker silent this long is hung: it is stopped, and its caller hands the task on or does it itself. */
const HUNG_MS = 15 * 60_000;
/** The same while one of its commands still runs without printing (builds, installs, debug sessions). */
const HUNG_COMMAND_MS = 60 * 60_000;
/** The output size of each task's running commands, and when it last grew. */
const outputSeen = new SvelteMap<string, { size: number; at: number }>();
const descendantSeen = new SvelteMap<string, number>();
const checkIns = new SvelteMap<
    string,
    { at: number; count: number; quietTold: boolean }
>();

let watchingWorkers = false;
async function watchWorkers() {
    if (watchingWorkers) return;
    watchingWorkers = true;
    try {
        const now = Date.now();
        for (const [taskId, run] of taskRuns) {
            const record = delegateTasks[taskId];
            if (
                !record ||
                record.state !== 'running' ||
                record.pausedAt !== undefined ||
                !run.started
            )
                continue;
            const since = now - record.startedAt;
            // Activity is the CLI's events, and also the output of a command it runs (a build, a test run, a dev server): a
            // command that keeps printing is working even when the CLI itself says nothing until it ends.
            const tools = activity.filter(
                (item) =>
                    item.sessionId === record.childId &&
                    item.name !== 'Request' &&
                    (item.status === 'running' || item.status === 'background'),
            );
            const outputSize = tools.reduce(
                (sum, item) => sum + (item.output?.length ?? 0),
                0,
            );
            const seen = outputSeen.get(taskId);
            if (!seen || seen.size !== outputSize)
                outputSeen.set(taskId, { size: outputSize, at: now });
            const lastOutput = outputSeen.get(taskId)!.at;
            // Sample every tick, so the decision compares CPU and I/O since the preceding check.
            let descendantActive = false;
            try {
                descendantActive = await invoke<boolean>(
                    'worker_descendant_activity',
                    { chat: record.childId },
                );
            } catch (error) {
                // An unavailable process snapshot is not evidence that the worker is idle.
                descendantActive = true;
                logFlow(
                    record.childId,
                    'watchdog',
                    `process check failed: ${String(error)}`,
                );
            }
            if (
                taskRuns.get(taskId) !== run ||
                delegateTasks[taskId] !== record ||
                record.state !== 'running' ||
                record.pausedAt !== undefined
            )
                continue;
            if (descendantActive) descendantSeen.set(taskId, Date.now());
            const quiet =
                Date.now() -
                Math.max(
                    lastEventAt.get(record.childId) ?? record.startedAt,
                    tools.length ? lastOutput : 0,
                    descendantSeen.get(taskId) ?? 0,
                );
            // A command still running with no output (a long build, a debugger at a breakpoint) gets far longer before it
            // counts as hung; plain silence with nothing running is a stuck CLI sooner.
            const hungAfter = tools.length ? HUNG_COMMAND_MS : HUNG_MS;
            if (quiet >= hungAfter && !descendantActive) {
                logFlow(
                    record.childId,
                    'watchdog',
                    `task=${taskId} hung (${span(quiet)} silent): stopped`,
                );
                checkIns.delete(taskId);
                stopTask(
                    taskId,
                    'timeout',
                    `No activity from the worker for ${span(quiet)}: AgentDeck stopped it as hung. Hand the task to another agent from list_agents (delegate_task), or do it yourself if none can take it.`,
                );
                continue;
            }
            // A worker that waits for the caller's own answer is checked by the caller already.
            if (run.callId) continue;
            const state = checkIns.get(taskId) ?? {
                at: 0,
                count: 0,
                quietTold: false,
            };
            const due =
                since >= CHECK_IN_MS * 2 ** state.count &&
                now - state.at > 60_000;
            const quietDue = quiet >= QUIET_MS && !state.quietTold;
            if (!due && !quietDue) continue;
            if (due) state.count++;
            if (quietDue) state.quietTold = true;
            state.at = now;
            checkIns.set(taskId, state);
            logFlow(
                record.childId,
                'watchdog',
                `task=${taskId} check-in (running ${span(since)}, quiet ${span(quiet)})`,
            );
            deliverReport(record.caller, {
                taskId: `${taskId}#check${state.count}${state.quietTold ? 'q' : ''}`,
                sourceMessageId: record.sourceMessageId,
                sourceTask: record.sourceTask ?? record.task,
                label: `${record.label} (task ${taskId}) - progress check, still running`,
                text:
                    `Not finished yet: running ${span(since)}, last activity ${span(quiet)} ago (${lastEventKind.get(record.childId) ?? 'unknown'}). ` +
                    `Check it with task_status ${taskId}. If it is progressing, let it run and tell the user briefly. If it looks stuck, ` +
                    `stop it with task_stop and send a hint with delegate_task continue=${taskId}, or hand the task to another agent from list_agents, ` +
                    `or do it yourself if no agent can take it. A worker silent for ${span(HUNG_MS)} is stopped by AgentDeck.`,
            });
        }
        for (const taskId of checkIns.keys())
            if (!taskRuns.has(taskId)) checkIns.delete(taskId);
        for (const taskId of outputSeen.keys())
            if (!taskRuns.has(taskId)) outputSeen.delete(taskId);
        for (const taskId of descendantSeen.keys())
            if (!taskRuns.has(taskId)) descendantSeen.delete(taskId);
    } finally {
        watchingWorkers = false;
    }
}

/** One worker of a split proposal (proposal.svelte.ts): the same path as a delegate_task call of the chat, so every check and
 *  the worktree apply. `answer` gets the reason when the worker does not start. */
export function startProposalWorker(
    callerId: string,
    call: WorkerCall,
    answer: (text: string, isError?: boolean) => void,
) {
    startTask(
        {
            callId: `split-${crypto.randomUUID()}`,
            tool: 'delegate_task',
            caller: callerId,
            args: workerArgsOf(call),
        },
        answer,
    );
}

/** Auto reviews started per user request (`chat|message id`), this run of the app. */
const reviewRounds = new SvelteMap<string, number>();

/**
 * A main chat's turn finished well: when it changed enough files and Auto review is on, the diff goes to the agent routed
 * for the review role, in the background. Its report comes back like any other (flushReports, handbackPrompt).
 */
export function maybeAutoReview(sessionId: string, reply: Message) {
    const caller = callerOf(sessionId);
    const source = liveAsks[sessionId];
    if (!caller || !source) return;
    const key = `${sessionId}|${source.id}`;
    const rounds = reviewRounds.get(key) ?? 0;
    const paths = changedPaths(reply.blocks);
    if (
        !shouldAutoReview({
            enabled: automation.review,
            orchestrate: automation.orchestrate,
            worker: isWorkerChat(sessionId) || Boolean(caller.side),
            hasRoute: routesOf(taskRoles, 'review').length > 0,
            paths,
            rounds,
        })
    )
        return;
    reviewRounds.set(key, rounds + 1);
    logFlow(
        sessionId,
        'auto review',
        `round ${rounds + 1}: ${paths.length} files`,
    );
    startTask(
        {
            callId: `review-${crypto.randomUUID()}`,
            tool: 'delegate_task',
            caller: sessionId,
            args: {
                role: 'review',
                task: reviewBrief(askText(source), paths, rounds + 1),
                wait: false,
            },
        },
        (text, isError) => {
            if (isError)
                logFlow(sessionId, 'auto review', `not started: ${text}`);
        },
    );
}

/** A call of one of the delegation tools, from the Rust side. */
export function onDelegateCall(call: DelegateCall, checked = false) {
    // The installed CLIs are checked when Settings opens, not at start: a call that needs the agent list before then
    // checks them first, or it finds no agent to hand work to. One check only, so a failed check does not loop.
    if (
        !checked &&
        !connectors.detected &&
        (call.tool === 'list_agents' || call.tool === 'delegate_task')
    ) {
        void refreshDetect().finally(() => onDelegateCall(call, true));
        return;
    }
    const reply = (text: string, isError = false) =>
        void replyDelegateCall(call.callId, text, isError).catch(
            () => undefined,
        );
    if (call.tool === 'list_agents') return reply(formatAgents(agentRows()));
    if (call.tool === 'delegate_task') return startTask(call, reply);
    if (call.tool === 'task_ask') return askParent(call, reply);
    if (call.tool === 'task_answer') return answerTaskQuestion(call, reply);
    if (call.tool === 'team_message') return teamMessage(call, reply);
    const id = call.args.task_id;
    const record = isTaskId(id) ? delegateTasks[id] : undefined;
    if (!record)
        return reply(
            `No task ${String(id)}: its id is the one delegate_task returned.`,
            true,
        );
    if (call.tool === 'task_status') return reply(statusText(record));
    // task_stop
    if (taskRuns.has(record.id)) stopTask(record.id, 'caller');
    reply(statusText(record));
}

if (inTauri()) {
    // The page before this one is gone with its chats: calls still waiting for it are answered with an error.
    void delegateReady().catch(() => undefined);
    void listenDelegateCalls(onDelegateCall);
    void listenWorkerSlots(startQueued);
    // The watchdog (watchWorkers): long workers get a progress check by their caller, hung ones are stopped.
    setInterval(() => void watchWorkers(), 60_000);
    // The Preview agent's memory of pages (page-memory.ts): its tools read and write the store through this.
    void startPageMemoryBridge();
    void listenDelegateAborts((callId) => {
        // A question whose call was dropped (the worker's connection to AgentDeck closed) is cancelled; the task stays
        // running. A worker that really died is caught by the watchdog.
        for (const pending of pendingTaskAsks.values()) {
            if (pending.callId === callId) {
                cancelTaskAsk(
                    pending.id,
                    'The question was not delivered: the worker lost its connection to AgentDeck while it waited. It keeps working; ask again if the answer is still needed.',
                    true,
                );
                return;
            }
        }
        for (const [taskId, run] of taskRuns)
            if (run.callId === callId) stopTask(taskId, 'abort');
    });
}
