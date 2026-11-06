import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
    connectors,
    agentHasRoom,
    autoSwitchConnectorAccount,
    autoSwitchProviderKey,
    limitResetAt,
    refreshProviderQuota,
    type AccountConnectorId,
} from '../../agents/connectors.svelte';
import {
    type FailureKind,
    type Recovery,
    classifyFailure,
    planRecovery,
    continuePrompt,
    recoveryNote,
    waitUnlessAborted,
} from '../recovery/turn-failure';
import { inTauri, isPreviewCopy, clock } from '../../app/platform/history';
import { type Message, type Block } from '../mock';
import { planOf } from '../content/blocks';
import type { PlanInfo } from '../../plans/plans.svelte';
import {
    customModelId,
    modelLabel,
    parseCustomModel,
} from '../../agents/models.svelte';
import { getPref, setPref } from '../../app/platform/prefs';
import { parseResetAt } from '../recovery/limit-reset';
import { classifyLimitGate, type LimitGateKind } from '../recovery/limit-gate';
import { type AgentEvent, listenAgentEvents } from '../agent';
import { logError } from '../../app/platform/error-log.svelte';
import { chatMetaOf, ledger } from '../index/ledger';
import { hangTraceOn, logFlow, markStep } from '../../tasks/flow-log';
import {
    pathKey,
    pathsWrittenBy,
    readPathOf,
    type RunRef,
} from '../runs/change-ledger';
import {
    ledgerReads,
    ledgerWrites,
    noteLedgerRead,
    noteLedgerWrite,
    onUserFileSave,
} from '../runs/change-ledger.svelte';
import {
    userEditNotice,
    workerChangesNotice,
    writeNotice,
} from '../runs/notices';
import { notifyRun, queueNotice } from '../runs/notices.svelte';
import { projectOf } from './state.svelte';
import {
    addPromptSuggestion,
    mergePromptSuggestions,
} from '../prompt-suggestions';
import { replyStyle } from '../content/reply-style.svelte';
import {
    activity,
    promoteShellCall,
    trackActivity,
} from '../runs/activity.svelte';
import { recordProjectActivity } from '../runs/project-activity.svelte';
import { guide } from '../../app/ui/guide.svelte';
import { releaseBrowserChat } from '../../browser/browser.svelte';
import {
    addUsage,
    applyAgentEvent,
    updateHistoricalTask,
} from '../agent-reply';
import {
    finishCommandImages,
    persistCommandImage,
} from '../content/command-images';
import { recordUsage, estimateCost } from '../runs/usage';
import { routesForChat, toolKindOf } from '../../tasks/delegate-task';
import { formatModelRef, parseModelRef } from '../../agents/model-ref';
import { cliOf } from '../../agents/provider-descriptors';
import { archiveTurn } from '../content/archive';
import {
    MODELS,
    advanceRun,
    nextId,
    persistLocal,
    promptSuggestions,
    runEpochs,
    workspace,
    type Agent,
    type Effort,
    type Attachment,
    type FileAttachment,
    type PageElement,
    type SessionItem,
} from './state.svelte';
import {
    agentLabel,
    chatTurnOptions,
    pendingSwitch,
    failSessionWork,
    hiddenPrompt,
    forgetUnstartedConversation,
    firstAgentOf,
    isRunning,
    openServedPage,
    queued,
    stopTurn,
    turns,
    turnOptionsOf,
} from './turns.svelte';
import {
    NO_HANDOUT,
    RENDER_WAIT_LIMIT_MS,
    askText,
    fetchQuestionRepair,
    liveAsks,
    liveHandouts,
    liveReplies,
    messagesOf,
    needsUserInput,
    renderWaiters,
    replies,
    runReplies,
    sendNextQueued,
    sessionLanes,
    updateLane,
} from './run.svelte';
import { finishWorkflowTurn, onDelegateDone } from './delegation.svelte';
import {
    answerPendingTaskQuestion,
    bindTasks,
    delegateTasks,
    endWaitingTasks,
    isWorkerChat,
    maybeAutoReview,
    noteWorkerRecovering,
    pauseDelegateTask,
    resumeDelegateTask,
    taskRuns,
    teamNoteDone,
} from './delegate-task.svelte';
import { attachmentsOf, handoffFor, send } from './sending.svelte';
import {
    clipText,
    finishCoordinationPrompt,
    taskWaiters,
} from './orchestration.svelte';
import { finishWorkflowIntegration } from './delegation.svelte';
import { importHistory, keepOtherTurn, rememberMixed } from './history.svelte';
import type { CredentialAttempt } from '../../agents/credential-switch';
import { credentialScope } from '../../agents/credential-scope';
import {
    isBackgroundWait,
    isLongRunningWork,
    isShellCall,
    SHELL_WAIT_MS,
} from '../runs/run-lanes';

const credentialAttempts = new SvelteMap<
    string,
    CredentialAttempt & { controller: AbortController }
>();
/** A user request or Stop invalidates every pending continuation for the previous task. */
export function cancelAutoSwitch(sessionId: string): void {
    credentialAttempts.get(sessionId)?.controller.abort();
    credentialAttempts.delete(sessionId);
}

/** A turn the user stopped can be continued from the composer without adding a visible user message. */
export const manuallyStopped = $state<Record<string, boolean>>({});

/** When the user last pressed Stop in a chat: a report the CLI sends right after that is a leftover of the stop, not news. */
export const userStoppedAt: Record<string, number> = {};
/** Shell calls still running after SHELL_WAIT_MS, keyed by turn and call: their timers release the chat (see applyEvent). */
const shellWaits = new SvelteMap<string, ReturnType<typeof setTimeout>>();
function armShellWait(
    turn: string | undefined,
    callId: string,
    onLong: () => void,
) {
    const key = `${turn ?? '-'}:${callId}`;
    clearShellWait(turn, callId);
    shellWaits.set(
        key,
        setTimeout(() => {
            shellWaits.delete(key);
            onLong();
        }, SHELL_WAIT_MS),
    );
}
function clearShellWait(turn: string | undefined, callId: string) {
    const key = `${turn ?? '-'}:${callId}`;
    const timer = shellWaits.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    shellWaits.delete(key);
}

/** The request a run works on: the text of the newest user message sent at or before the run started. */
function requestOf(sessionId: string, startedAt: number): string {
    const list = messagesOf(sessionId);
    for (let index = list.length - 1; index >= 0; index--) {
        const message = list[index];
        if (message.role !== 'user') continue;
        const at = message.at ? Date.parse(message.at) : 0;
        if (at > startedAt) continue;
        return message.blocks
            .map((block) => (block.kind === 'response' ? block.text : ''))
            .join(' ')
            .trim();
    }
    return '';
}

function rootOfChat(sessionId: string): string | undefined {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    return session ? projectOf(session)?.path : undefined;
}

/** Who a notice names as the writer: the side run, or the sub-agent of a run. */
const labelOf = (run: RunRef) =>
    run.subId !== undefined ? `sub-agent ${run.subId}` : run.lane;

/** Tells every run that is still working and has read or written `path` (in the same project) about the change
 *  (plan 6.3, trigger 2). */
function tellRunsOnFile(
    root: string,
    path: string,
    writer: RunRef,
    after: string,
) {
    const key = pathKey(path);
    const intent = requestOf(writer.sessionId, writer.intentAt);
    for (const [sessionId, lanes] of Object.entries(sessionLanes)) {
        for (const lane of lanes) {
            if (lane.state !== 'running' && lane.state !== 'waiting') continue;
            if (sessionId === writer.sessionId && lane.id === writer.turn)
                continue;
            const touched =
                ledgerReads.some(
                    (read) =>
                        read.root === root &&
                        read.run.sessionId === sessionId &&
                        read.run.turn === lane.id &&
                        pathKey(read.path) === key,
                ) ||
                ledgerWrites.some(
                    (write) =>
                        write.root === root &&
                        write.run.sessionId === sessionId &&
                        write.run.turn === lane.id &&
                        pathKey(write.path) === key,
                );
            if (!touched) continue;
            void notifyRun(
                sessionId,
                writer.lane === 'user'
                    ? userEditNotice({ path, after })
                    : writeNotice({
                          path,
                          byLabel: labelOf(writer),
                          intent,
                          after,
                      }),
                'file-changed',
            );
        }
    }
}

// The user saved a file in the editor: a write of its own in the ledger, newest of all intents, and the runs are told.
onUserFileSave((root, path, before, after) => {
    const run: RunRef = {
        sessionId: 'user',
        turn: `save-${Date.now()}`,
        lane: 'user',
        intentAt: Date.now(),
    };
    noteLedgerWrite({ root, path, run, callId: run.turn, before, after });
    tellRunsOnFile(root, path, run, after);
});

/** Puts what one run did to files into the ledger (plan 6.1): its writes, its reads, and a sub-agent's writes under
 *  the run's own turn. A write over a newer request is a conflict (6.5): the writer is told, and the conflict is kept. */
function noteRunFiles(
    sessionId: string,
    turn: string | undefined,
    owner: { reply: Message; listener: boolean },
    event: AgentEvent,
) {
    if (!turn) return;
    const root = rootOfChat(sessionId);
    if (!root) return;
    const subId = event.kind === 'scoped' ? event.parent : undefined;
    const inner = event.kind === 'scoped' ? event.event : event;
    const run: RunRef = {
        sessionId,
        turn,
        lane:
            subId !== undefined
                ? 'subagent'
                : owner.listener
                  ? 'listener'
                  : 'primary',
        intentAt: owner.reply.intentAt ?? owner.reply.startedAt ?? Date.now(),
        ...(subId !== undefined ? { subId } : {}),
    };
    if (
        (inner.kind === 'tool_call' || inner.kind === 'tool_result') &&
        inner.change
    ) {
        const change = inner.change;
        const conflict = noteLedgerWrite({
            root,
            path: change.path,
            run,
            callId: inner.id,
            before: change.before,
            after: change.after,
        });
        // undefined: the same write was already in the ledger; nothing new to tell.
        if (conflict === undefined) return;
        logFlow(
            sessionId,
            'ledger write',
            `path=${change.path} run=${turn} lane=${run.lane}${subId !== undefined ? ` sub=${subId}` : ''} intent=${run.intentAt}`,
        );
        tellRunsOnFile(root, change.path, run, change.after);
        if (conflict) {
            logFlow(
                sessionId,
                'conflict',
                `path=${change.path} writer=${turn} over=${conflict.over.run.turn} kind=${conflict.kind}`,
            );
            void notifyRun(
                sessionId,
                `[AgentDeck] Your write to ${change.path} replaced a change the user asked for later. Do not undo it. If it must change, ask the user first.`,
                'conflict',
            );
        }
    } else if (inner.kind === 'tool_call') {
        const path = readPathOf(inner.name, inner.input);
        if (path) noteLedgerRead({ root, path, run, at: Date.now() });
    }
}

/** A worker chat that finished: its parent gets the files it changed, from the ledger (plan 6.3, trigger 3). */
function queueWorkerChanges(sessionId: string, turn: string) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session?.parentId) return;
    const paths = pathsWrittenBy(ledgerWrites, { sessionId, turn });
    if (paths.length === 0) return;
    queueNotice(
        session.parentId,
        workerChangesNotice(session.title || sessionId, paths),
    );
    logFlow(
        session.parentId,
        'notify',
        `via=queued reason=worker-done worker=${sessionId} files=${paths.length}`,
    );
}

const STOP_REPORT_GRACE_MS = 30_000;

/** Stops the active turn and exposes the composer's one-click continuation action. */
export function stopTurnForResume(sessionId: string) {
    const task = Object.values(delegateTasks).find(
        (item) =>
            item.childId === sessionId &&
            taskRuns.has(item.id) &&
            ['queued', 'waiting', 'running'].includes(item.state),
    );
    if (task) {
        pauseDelegateTask(task.id);
        return;
    }
    const waiter = taskWaiters.get(sessionId);
    taskWaiters.delete(sessionId);
    stopTurn(sessionId);
    if (waiter) taskWaiters.set(sessionId, waiter);
    manuallyStopped[sessionId] = true;
}

/** Continues a user-stopped turn with a hidden prompt that preserves the original request in context. */
export function resumeStoppedTurn(sessionId: string) {
    const task = Object.values(delegateTasks).find(
        (item) =>
            item.childId === sessionId &&
            taskRuns.has(item.id) &&
            item.pausedAt !== undefined,
    );
    if (task) {
        void resumeDelegateTask(task.id);
        return;
    }
    if (!manuallyStopped[sessionId] || isRunning(sessionId)) return;
    delete manuallyStopped[sessionId];
    send(sessionId, '', [], [], [], {
        prompt: continuePrompt(
            'the user stopped the reply',
            true,
            lastRequest(sessionId),
        ),
        silent: NO_HANDOUT,
    });
}

// ---------- keeping work going when a turn fails ----------
// A turn that ends in an error is not the end of the work: a passing fault is tried again, and otherwise (a usage
// limit, a sign-out, a crash) the next agent of the user's chain, another provider, takes over the chat (it is told
// what the others did, see `missedTurns`). `planRecovery` (turn-failure.ts) decides; the chat shows one line for each
// step. A new message of the user starts the count again.
// Account switching is a different path: the opt-in auto-switch (`runAutoSwitch`) rotates the account or key of the
// same provider, and only when its toggle is on. Turning it off leaves provider fallback as the only recovery.
type RecoveryState = {
    retries: number;
    tried: string[];
    /** Numbered for each continuation: a deferred send of an older one finds the number changed and is dropped. */
    generation: number;
    /** Set while a retry waits: Stop aborts it. */
    wait?: AbortController;
    /** The attachments of the user's request, sent again with each continuation. */
    attachments: {
        images: Attachment[];
        elements: PageElement[];
        files: FileAttachment[];
    };
};
export const recoveries: Record<string, RecoveryState> = {};
let continuationCount = 0;
const newRecovery = (): RecoveryState => ({
    retries: 0,
    tried: [],
    generation: 0,
    attachments: { images: [], elements: [], files: [] },
});
/**
 * A failed turn whose end is held back because the chat goes on (a retry, a fallback, an account switch). It is closed
 * by `closeOwedTurn` when no further turn is started, or by Stop; a turn that starts instead takes it over.
 */
const owed = new SvelteMap<string, { reply: Message; reason: string }>();
/** The chat has a failed turn still to be closed: it counts as running (Stop is offered, the chat is not idle). */
export const owesTurn = (sessionId: string) => owed.has(sessionId);
/** A new turn of the chat takes over from the failed one: its end is no longer owed. */
export function supersedeOwedTurn(sessionId: string) {
    owed.delete(sessionId);
}
/** Ends a recovery record: a waiting retry is aborted, nothing of it runs any more. */
export function dropRecovery(sessionId: string) {
    recoveries[sessionId]?.wait?.abort();
    delete recoveries[sessionId];
}

type RecoveryRoute = {
    key: string;
    provider: string;
    agent: Agent;
    model: string;
    effort?: string;
    /** A free tier: it may keep what it is sent (see RESTRICTED_NOTE in tasks/delegate-task.ts). */
    restricted?: boolean;
};

/** Resolve saved fallback rows to exact, currently available CLI or custom-connector routes. */
function availableRecoveryRoutes(): RecoveryRoute[] {
    const result: RecoveryRoute[] = [];
    const seen = new SvelteSet<string>();
    for (const saved of connectors.recovery.chain) {
        const ref = parseModelRef(saved);
        if (!ref) continue;
        const { provider, model: pickedModel, effort } = ref;
        let agent: Agent;
        let model: string | undefined;
        let restricted = false;
        if (cliOf(provider)) {
            const installed = Boolean(
                connectors.detected?.tools.find(
                    (item) => item.id === cliOf(provider),
                )?.path,
            );
            if (!installed || !agentHasRoom(provider)) continue;
            const catalog = (MODELS[provider as Agent] ?? []).filter(
                (item) =>
                    !(
                        provider === 'claude' &&
                        item.value.startsWith('credit:')
                    ),
            );
            model = pickedModel
                ? catalog.find((item) => item.value === pickedModel)?.value
                : catalog[0]?.value;
            agent = provider as Agent;
        } else {
            const connector = connectors.custom.find(
                (item) =>
                    item.id === provider && item.enabled && item.baseUrl.trim(),
            );
            if (!connector) continue;
            const models = connector.models.length
                ? connector.models
                : connector.defaultModel
                  ? [connector.defaultModel]
                  : [];
            model = pickedModel
                ? models.find((item) => item === pickedModel)
                : models[0];
            agent = 'custom';
            restricted = Boolean(connector.restricted);
        }
        if (!model) continue;
        const key = formatModelRef({ provider, model, effort });
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
            key,
            provider,
            agent,
            model,
            ...(effort ? { effort } : {}),
            ...(restricted ? { restricted } : {}),
        });
    }
    return result;
}

/** The route identities a chat can move to now, in the user's order. */
/** The routes for a chat: a delegated worker never falls back to a free tier (its prompt was checked at start only). */
function routesFor(forChat?: string): RecoveryRoute[] {
    return routesForChat(
        availableRecoveryRoutes(),
        forChat ? isWorkerChat(forChat) : false,
    );
}

export function recoveryChain(forChat?: string): string[] {
    return routesFor(forChat).map((route) => route.key);
}

/** Find the exact route's chat model; custom providers need their provider id embedded in the model id. */
export function recoveryTarget(
    key: string,
    forChat?: string,
):
    | {
          agent: Agent;
          model: string;
          effort?: string;
          /** The provider id (a custom connector's id, or the CLI's own id): what `findAgent` takes. */
          provider: string;
      }
    | undefined {
    const route = routesFor(forChat).find((item) => item.key === key);
    if (!route) return undefined;
    return {
        agent: route.agent,
        model:
            route.agent === 'custom'
                ? customModelId(route.provider, route.model)
                : route.model,
        provider: route.provider,
        ...(route.effort ? { effort: route.effort } : {}),
    };
}

/** Compatibility helpers for callers that need the configured model or effort for a route/provider. */
export function recoveryModelFor(key: string): string | undefined {
    const exact = recoveryTarget(key);
    if (exact) return exact.model;
    const route = availableRecoveryRoutes().find(
        (item) => item.provider === key,
    );
    return route
        ? route.agent === 'custom'
            ? customModelId(route.provider, route.model)
            : route.model
        : undefined;
}

export function recoveryEffortFor(key: string): string | undefined {
    return (
        recoveryTarget(key)?.effort ??
        availableRecoveryRoutes().find((item) => item.provider === key)?.effort
    );
}

/** The chain key of the route a turn ran on: its agent and model (a custom model names its provider inside). */
function routeKeyOf(
    sessionId: string,
    agent: string,
    rawModel: string | undefined,
    chain: string[],
): string {
    const custom = agent === 'custom' ? parseCustomModel(rawModel) : null;
    const provider = custom?.providerId ?? agent;
    const model = custom?.model ?? rawModel;
    const effort = turnOptionsOf(sessionId).effort;
    const matching =
        chain.find((key) => {
            const route = parseModelRef(key);
            return (
                route?.provider === provider &&
                route.model === model &&
                route.effort === effort
            );
        }) ??
        chain.find((key) => {
            const route = parseModelRef(key);
            return route?.provider === provider && route.model === model;
        });
    return matching ?? formatModelRef({ provider, model: model ?? '' });
}

/** What to do about a turn of `session` that ended with `message`; null when nothing is (off, or stopped by the user). */
function recoveryFor(
    session: SessionItem,
    message: string,
    reply: Message,
): { kind: FailureKind; plan: Recovery } | null {
    if (!connectors.recovery.enabled || !inTauri()) return null;
    const kind = classifyFailure(message);
    if (kind === 'stopped') return null;
    const state = (recoveries[session.id] ??= newRecovery());
    const chain = recoveryChain(session.id);
    // The route the failed turn ran on, from its own reply: the chat's model may have changed since (see noteModelFallback).
    const current = routeKeyOf(
        session.id,
        reply.agent ?? session.agent,
        reply.model ?? session.model,
        chain,
    );
    if (!state.tried.includes(current)) state.tried.push(current);
    const plan = planRecovery({
        kind,
        retries: state.retries,
        chain,
        current,
        tried: state.tried,
    });
    return { kind, plan };
}

/**
 * The CLI answered (part of) a turn with another model than the chat's. A fallback of the whole session ("session" scope,
 * or none: older CLIs only had that) is followed: the chat's model becomes the one now serving, so the picker shows the
 * truth and the next turn does not switch back. A "local" one (a sub-agent, a side question) leaves the chat's model as it
 * is. Either way the reply gets one line saying what happened.
 */
function noteModelFallback(session: SessionItem, reply: Message, line: string) {
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return;
    }
    const text = (key: string, camel: string) =>
        (typeof data[key] === 'string'
            ? data[key]
            : typeof data[camel] === 'string'
              ? data[camel]
              : '') as string;
    const to = text('fallback_model', 'fallbackModel');
    const from = text('original_model', 'originalModel');
    const local = data.scope === 'local';
    // The agent that answered this turn (reply.agent): a fallback of an earlier route must not rewrite the chat's pick.
    const agent = reply.agent ?? session.agent;
    // Only a model the picker knows is taken over: `modelFor` would replace any other one with the agent's first model.
    const known = (MODELS[agent] ?? []).some((item) => item.value === to);
    const moves = !local && data.direction !== 'revert' && known;
    if (moves && agent === session.agent && session.model !== to) {
        // The route the turn started on still counts as tried, and the reply names the model that now serves it (A6).
        const started = routeKeyOf(
            session.id,
            agent,
            session.model,
            recoveryChain(),
        );
        const record = (recoveries[session.id] ??= newRecovery());
        if (!record.tried.includes(started)) record.tried.push(started);
        reply.model = to;
        session.model = to;
        session.conversationModel = to;
        // The effort belongs to the route of this very model, never to another route of the same agent.
        const served = availableRecoveryRoutes().find(
            (route) =>
                route.agent === agent &&
                (route.agent === 'custom'
                    ? customModelId(route.provider, route.model)
                    : route.model) === to,
        );
        window.dispatchEvent(
            new CustomEvent('agentdeck:agent-moved', {
                detail: {
                    sessionId: session.id,
                    agent,
                    model: to,
                    effort: served?.effort,
                },
            }),
        );
    }
    const said = text('content', 'content').trim();
    const note =
        said ||
        (local
            ? `Only that response came from ${modelLabel(to)}; the chat stays on ${modelLabel(from)}.`
            : `${modelLabel(from) || 'The model'} could not answer: the chat continues on ${modelLabel(to)}.`);
    reply.blocks = [...reply.blocks, { kind: 'response', text: `> ↻ ${note}` }];
}

/** Moves a chat to another agent and applies the fallback route's model and effort. */
export function moveChatTo(
    session: SessionItem,
    agent: Agent,
    picked?: string,
    pickedEffort?: string,
    /** The provider id of the route (a custom connector's id for `custom`): the task keeps it so `continue` finds it. */
    providerId?: string,
) {
    const model = picked ?? MODELS[agent]?.[0]?.value ?? session.model;
    if (session.agent !== agent && !session.draft) {
        session.agents = [
            ...new SvelteSet([
                ...(session.agents ?? [session.source ?? session.agent]),
                agent,
            ]),
        ];
        rememberMixed(session);
    }
    session.agent = agent;
    session.model = model;
    if (pickedEffort)
        chatTurnOptions[session.id] = {
            ...turnOptionsOf(session.id),
            effort: pickedEffort as Effort,
        };
    // A worker chat that moved on (after a failure) is handled by that agent now: the task says so, so its card and its
    // report name the agent that answers.
    const task = Object.values(delegateTasks).find(
        (record) => record.childId === session.id,
    );
    if (task) {
        task.agent = agent;
        task.agentId = providerId ?? agent;
        task.model = model;
        task.label = `${agentLabel(agent, model)} · ${modelLabel(model)}`;
    }
    // The composer keeps a picker per chat: it follows, or it would put the old agent back.
    window.dispatchEvent(
        new CustomEvent('agentdeck:agent-moved', {
            detail: {
                sessionId: session.id,
                agent,
                model,
                effort: pickedEffort,
            },
        }),
    );
}

/** The attachments of the user's latest request, sent again with a continuation (the request is what they were given). */
function lastAttachments(sessionId: string): RecoveryState['attachments'] {
    const asked = [...messagesOf(sessionId)]
        .reverse()
        .find((message) => message.role === 'user' && !hiddenPrompt(message));
    if (!asked) return { images: [], elements: [], files: [] };
    const { images, elements, files } = attachmentsOf(asked);
    return { images, elements, files };
}

/**
 * The steps a turn's normal end runs, for a failed turn that is not continued: the work of its parent (a worker's report,
 * a workflow, the tasks waiting on it), the browser tabs it held, the project activity. Then the queue goes on.
 */
function finalizeTurn(
    sessionId: string,
    reply: Message,
    reason: string,
    stopped: boolean,
) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    failSessionWork(sessionId);
    onDelegateDone(sessionId, reply, reason);
    finishWorkflowTurn(sessionId, true, reply);
    finishWorkflowIntegration(sessionId, reply, true);
    endWaitingTasks(sessionId, stopped);
    releaseBrowserChat(sessionId);
    if (session) {
        const project = workspace.projects.find(
            (item) => item.id === session.projectId,
        );
        void recordProjectActivity({
            root: project?.path ?? '',
            project: project?.name ?? '',
            sessionId,
            chatTitle: session.title,
            agent: reply.agent ?? session.agent,
            model: reply.model ?? session.model,
            status: stopped ? 'stopped' : 'failed',
            reply,
            note: stopped ? undefined : reason,
        });
    }
    applyPendingSwitch(sessionId);
    sendNextQueued(sessionId);
}

/** Closes the failed turn that is still owed, when no turn of the chat took it over (see `owed`). */
function closeOwedTurn(sessionId: string, stopped = false) {
    const owing = owed.get(sessionId);
    if (!owing) return;
    owed.delete(sessionId);
    finalizeTurn(
        sessionId,
        owing.reply,
        stopped ? 'stopped' : owing.reason,
        stopped,
    );
}

/** Stop pressed while the chat waits for a retry or an account switch: nothing of it runs, and the turn is closed. */
export function stopOwedTurn(sessionId: string) {
    dropRecovery(sessionId);
    cancelAutoSwitch(sessionId);
    closeOwedTurn(sessionId, true);
    applyPendingSwitch(sessionId);
}

/**
 * A picker change made while the chat's turn ran (D3) becomes the chat's route once its turns have ended. Called where
 * the turn ends for good, after the recovery has decided its route (a retry, a switch of account or of agent). The picker
 * calls it too, for a change made while no turn runs (Composer), so every route change goes through here (R3.3).
 */
export function applyPendingSwitch(sessionId: string) {
    const pick = pendingSwitch[sessionId];
    if (!pick) return;
    delete pendingSwitch[sessionId];
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    // A chat continued with another agent lists every agent it has had (the sidebar shows them stacked).
    if (session.agent !== pick.agent && !session.draft) {
        const agents = [
            ...(session.agents ?? [session.source ?? session.agent]),
            pick.agent,
        ];
        session.agents = agents.filter(
            (agent, index) => agents.indexOf(agent) === index,
        );
        rememberMixed(session);
    }
    session.agent = pick.agent;
    session.model = pick.model;
    persistLocal();
}

/**
 * Carries out the plan after the failed turn has been put away. Every exit that starts no turn closes the failed turn
 * (`closeOwedTurn`), so its parent, queue and workers still end. A Stop, or a message of the user, supersedes the plan.
 */
async function runRecovery(
    sessionId: string,
    plan: Recovery,
    reason: string,
    failedAgent?: Agent,
) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    const state = recoveries[sessionId];
    if (!session || !state || plan.action === 'stop') {
        closeOwedTurn(sessionId);
        return;
    }
    // Each continuation has its own number: a send deferred behind a credential or a chat load checks it again (A4).
    const generation = ++continuationCount;
    state.generation = generation;
    state.attachments = lastAttachments(sessionId);
    // A message of the user is already waiting: it runs now, and no continuation is put in front of it (A3).
    const userWaiting = () => (queued[sessionId]?.length ?? 0) > 0;
    if (plan.action === 'retry') {
        if (userWaiting()) {
            dropRecovery(sessionId);
            closeOwedTurn(sessionId);
            return;
        }
        state.retries++;
        const wait = new AbortController();
        state.wait = wait;
        const passed = await waitUnlessAborted(plan.delayMs, wait.signal);
        if (state.wait === wait) state.wait = undefined;
        // Stopped meanwhile: stopOwedTurn has closed the failed turn already.
        if (!passed) return;
        // The user may have sent something meanwhile: their turn runs now, so the conversation is not reset under it.
        if (replies[sessionId] || recoveries[sessionId] !== state) return;
        forgetUnstartedConversation(sessionId, failedAgent ?? session.agent);
    } else {
        const target = recoveryTarget(plan.agent, sessionId);
        if (!target) {
            // Nothing to move to any more (the limits or sign-ins changed while the turn ended): the work stops here.
            const owing = owed.get(sessionId);
            if (owing)
                owing.reply.blocks = [
                    ...owing.reply.blocks,
                    {
                        kind: 'response',
                        text: '> ↻ No other agent is available now: the work stops here.',
                    },
                ];
            dropRecovery(sessionId);
            closeOwedTurn(sessionId);
            return;
        }
        const from = session.agent;
        // The route is left: an id that never started on it is forgotten with it, so a later return does not resume it (A8).
        forgetUnstartedConversation(sessionId, failedAgent ?? from);
        moveChatTo(
            session,
            target.agent,
            target.model,
            target.effort,
            target.provider,
        );
        // The provider changed without the user asking: the chat says so, in its own list, so the agents that answer
        // next are told it, and the user sees it.
        const at = new SvelteDate().toISOString();
        messagesOf(session.id).push({
            id: nextId(),
            role: 'assistant',
            agent: from,
            time: clock(at),
            at,
            blocks: [
                {
                    kind: 'response',
                    text: `> ↻ Moved to ${modelLabel(target.model) || agentLabel(target.agent, target.model)}, automatically: ${reason}`,
                },
            ],
        });
        persistLocal();
        state.retries = 0;
        state.tried.push(plan.agent);
        if (userWaiting()) {
            dropRecovery(sessionId);
            closeOwedTurn(sessionId);
            return;
        }
    }
    // The user may have sent something meanwhile, or stopped the chat: their message wins. A newer failure has its own
    // state, so this older plan is dropped too.
    if (replies[sessionId] || recoveries[sessionId] !== state) return;
    const same = plan.action !== 'fallback';
    const { images, elements, files } = state.attachments;
    send(sessionId, '', images, elements, [], {
        prompt: continuePrompt(reason, same, lastRequest(sessionId)),
        silent: NO_HANDOUT,
        files,
        recovery: { generation },
        // Refused because the chat is busy after all: the failed turn is closed here, so the queue is not held.
        onDropped: () => closeOwedTurn(sessionId),
    });
}

/** Rotates the credential for a limit/auth failure, then resumes the original request invisibly. */
async function runAutoSwitch(
    sessionId: string,
    reason: string,
    reply: Message,
    blockId: string,
) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session) {
        closeOwedTurn(sessionId);
        return;
    }
    // The route of the turn that failed (reply.agent/model), not the chat's current pick: the rotation is that
    // provider's, even when the user has picked another model since (see credentialScope).
    const route = {
        agent: reply.agent ?? session.agent,
        model: reply.model ?? session.model,
    };
    const scope = credentialScope(route.agent, route.model);
    const expectedModel = session.model;
    const modelId =
        route.agent === 'custom'
            ? (parseCustomModel(route.model)?.model ?? '')
            : (route.model ?? '');
    let attempt = credentialAttempts.get(sessionId);
    if (attempt && (attempt.scope !== scope || attempt.model !== modelId)) {
        cancelAutoSwitch(sessionId);
        attempt = undefined;
    }
    if (!attempt) {
        const controller = new AbortController();
        attempt = {
            controller,
            signal: controller.signal,
            tried: new Set(),
            model: modelId,
            scope,
        };
        credentialAttempts.set(sessionId, attempt);
    }
    const currentAttempt = attempt;
    currentAttempt.failedId = reply.credentialId;
    if (reply.credentialId) currentAttempt.tried.add(reply.credentialId);
    const isCurrent = () =>
        !currentAttempt.signal.aborted &&
        credentialAttempts.get(sessionId) === currentAttempt &&
        workspace.sessions.some((item) => item.id === sessionId) &&
        session.model === expectedModel &&
        credentialScope(session.agent, session.model) === scope;
    const block = () =>
        reply.blocks.find(
            (item): item is Extract<Block, { kind: 'command' }> =>
                item.kind === 'command' && item.id === blockId,
        );
    const started = Date.now();
    const timer = setInterval(() => {
        if (!isCurrent()) currentAttempt.controller.abort();
        const current = block();
        if (current?.status === 'running')
            current.output = `Waiting for an available account or API key…\nElapsed ${Math.floor((Date.now() - started) / 1000)}s`;
    }, 1000);
    let selected: string | null = null;
    try {
        if (!session) return;
        if (route.agent === 'custom') {
            const providerId = parseCustomModel(route.model)?.providerId;
            const provider = connectors.custom.find(
                (item) => item.id === providerId,
            );
            if (provider) {
                const switched = await autoSwitchProviderKey(
                    provider,
                    currentAttempt,
                );
                if (switched) {
                    selected = switched.label;
                    const current = connectors.custom.find(
                        (item) => item.id === provider.id,
                    );
                    if (current) void refreshProviderQuota(current);
                }
            }
        } else {
            const connector = credentialScope(
                route.agent,
            ) as AccountConnectorId;
            const switched = await autoSwitchConnectorAccount(
                connector,
                currentAttempt,
            );
            if (switched) selected = switched.email;
        }
        const current = block();
        if (!isCurrent()) {
            if (current) {
                current.status = 'fail';
                current.output = 'Account switching cancelled';
            }
            // The chat changed under the switch (a Stop closed the turn already; a message of the user owns it now).
            if (!replies[sessionId]) closeOwedTurn(sessionId);
            return;
        }
        if (selected && session && !replies[sessionId]) {
            if (current) {
                current.status = 'ok';
                current.output = `Switched to ${selected}. Continuing work…`;
            }
            send(sessionId, '', [], [], [], {
                prompt: continuePrompt(
                    'the account or API key reached its limit',
                    true,
                    lastRequest(sessionId),
                ),
                silent: NO_HANDOUT,
            });
            return;
        }
        if (selected && session && replies[sessionId]) {
            // The user's own message started a reply while the account was being switched: theirs wins, and the switch is done.
            if (current) {
                current.status = 'ok';
                current.output = `Switched to ${selected}.`;
            }
            cancelAutoSwitch(sessionId);
            return;
        }
        if (current) {
            current.status = 'fail';
            current.output = `No available account or API key. Elapsed ${Math.floor((Date.now() - started) / 1000)}s`;
        }
        if (session) scheduleResume(session, reason);
        cancelAutoSwitch(sessionId);
        // The failed turn was held for this switch and nothing else will end it: it is closed now, and the queue goes on.
        if (!replies[sessionId]) closeOwedTurn(sessionId);
    } catch (error) {
        const current = block();
        const cancelled =
            !isCurrent() ||
            (error instanceof Error && error.name === 'AbortError');
        if (current) {
            current.status = 'fail';
            current.output = cancelled
                ? 'Account switching cancelled'
                : 'Account verification failed. Resume manually after checking the account.';
        }
        if (!cancelled) scheduleResume(session, reason);
        cancelAutoSwitch(sessionId);
        if (!cancelled && !replies[sessionId]) closeOwedTurn(sessionId);
    } finally {
        clearInterval(timer);
        persistLocal();
    }
}

// ---------- carrying on when a usage limit ends ----------
// A turn that ends at a usage limit with no other agent to move to waits for the limit to reset (its time is in the error,
// or in the account's usage windows) and then carries on by itself, as Claude Code does. The chat shows a card with the
// time, a switch to turn the automatic part off, and Try again / Cancel. A message of the user cancels it: they took over.
export type Resume = {
    sessionId: string;
    agent: string;
    model?: string;
    at: number;
    since: number;
    reason: string;
    label: string;
    gate?: LimitGateKind;
    detail?: string;
    canAutoResume?: boolean;
    auto: boolean;
};
export const resumes = $state<Record<string, Resume>>({});
const RESUMES_KEY = 'chat.resumes';
/** A little after the reset, so the first request is not refused for being early. */
const RESUME_BUFFER_MS = 60_000;
/** Keep a paused request long enough for monthly provider windows to reset. */
const RESUME_MAX_WAIT_MS = 31 * 86_400_000;
const RESUME_MAX_AGE_MS = 32 * 86_400_000;
const resumeStore = { ready: false };
/** Keeps the user's switch choice across repeated provider limit responses for this paused task. */
export const resumeAutoChoice: Record<string, boolean> = {};
export const resumeSince: Record<string, number> = {};
void getPref<Resume[]>(RESUMES_KEY)
    .then((saved) => {
        for (const item of Array.isArray(saved) ? saved : [])
            if (
                !resumes[item.sessionId] &&
                (item.since ?? item.at) + RESUME_MAX_AGE_MS > Date.now()
            ) {
                item.label ??= 'Usage limit reached';
                item.gate ??= 'generic';
                item.detail ??= 'Try again after the provider limit resets';
                item.canAutoResume ??= item.auto;
                item.since ??= item.at;
                resumes[item.sessionId] = item;
                resumeAutoChoice[item.sessionId] = item.auto;
                resumeSince[item.sessionId] = item.since;
            }
    })
    .catch(() => undefined)
    .finally(() => {
        resumeStore.ready = true;
    });
$effect.root(() => {
    $effect(() => {
        if (!resumeStore.ready) return;
        setPref(
            RESUMES_KEY,
            JSON.parse(JSON.stringify(Object.values(resumes))) as Resume[],
        );
    });
});

function scheduleResume(session: SessionItem, message: string) {
    const now = Date.now();
    const resetAt =
        parseResetAt(message, now) ?? limitResetAt(session.agent, now);
    const gate = classifyLimitGate(message, resetAt, session.model);
    const end = gate.canAutoResume ? resetAt : null;
    if (end !== null && end - now > RESUME_MAX_WAIT_MS) return;
    const since = resumeSince[session.id] ?? resumes[session.id]?.since ?? now;
    if (now - since > RESUME_MAX_AGE_MS) return;
    resumes[session.id] = {
        sessionId: session.id,
        agent: session.agent,
        model: session.model,
        at: end === null ? now : Math.max(end, now) + RESUME_BUFFER_MS,
        since,
        reason: 'the usage limit was reached',
        label: gate.label,
        gate: gate.kind,
        detail: gate.detail,
        canAutoResume: gate.canAutoResume,
        auto:
            gate.canAutoResume &&
            (resumeAutoChoice[session.id] ?? connectors.recovery.autoResume),
    };
}

/** Carries on now (the "Try again" button, or the time has come). */
export function resumeNow(sessionId: string) {
    const resume = resumes[sessionId];
    const session = workspace.sessions.find((item) => item.id === sessionId);
    // A reply is running: "Try again" must not throw the card away and send nothing; it stays until the chat is idle.
    if (resume && session && replies[sessionId]) return;
    delete resumes[sessionId];
    if (resume) {
        resumeAutoChoice[sessionId] = resume.auto;
        resumeSince[sessionId] = resume.since;
    }
    if (!resume || !session) return;
    send(sessionId, '', [], [], [], {
        prompt: continuePrompt(resume.reason, true, lastRequest(sessionId)),
        silent: NO_HANDOUT,
    });
}
export const cancelResume = (sessionId: string) => {
    delete resumes[sessionId];
    delete resumeAutoChoice[sessionId];
    delete resumeSince[sessionId];
};
export function setResumeAuto(sessionId: string, auto: boolean) {
    const resume = resumes[sessionId];
    if (resume) {
        resume.auto = auto;
        resumeAutoChoice[sessionId] = auto;
    }
}

function checkResumes() {
    const now = Date.now();
    for (const resume of Object.values(resumes)) {
        if (resume.since + RESUME_MAX_AGE_MS < now) {
            delete resumes[resume.sessionId];
            delete resumeAutoChoice[resume.sessionId];
            delete resumeSince[resume.sessionId];
            continue;
        }
        if (!resume.auto || resume.at > now) continue;
        const session = workspace.sessions.find(
            (item) => item.id === resume.sessionId,
        );
        // Wait for the chat to be loaded and idle: a turn that is running will have its own end.
        if (
            !session ||
            isRunning(resume.sessionId) ||
            replies[resume.sessionId]
        )
            continue;
        resumeNow(resume.sessionId);
    }
}
if (typeof window !== 'undefined') setInterval(checkResumes, 30_000);

/** The words of the user's latest message, for a turn that carries on without it. */
function lastRequest(sessionId: string): string {
    const asked = [...messagesOf(sessionId)]
        .reverse()
        .find((message) => message.role === 'user' && !hiddenPrompt(message));
    return (
        asked?.blocks
            .flatMap((block) => (block.kind === 'response' ? [block.text] : []))
            .join('\n')
            .trim() ?? ''
    );
}

/** Apply one agent event to the reply it belongs to. */
/** Where a problem happened, for the error log (error-log.svelte.ts). No text of the conversation. */
export function logCtx(sessionId: string, session?: SessionItem) {
    const found =
        session ?? workspace.sessions.find((item) => item.id === sessionId);
    return {
        chat: sessionId,
        agent: found?.agent,
        model: found?.model,
        parent: found?.parentId,
        step:
            found?.title && found.parentId
                ? found.title.split(':')[0]
                : undefined,
    };
}

// A turn that says nothing for this long is written to the log once (an agent that hangs, a tool that never returns,
// a member waiting on a message that never comes): that is the line to look for when the app seems frozen.
const SILENT_AFTER_MS = 5 * 60_000;
export const lastEventAt = new SvelteMap<string, number>();
export const lastEventKind = new SvelteMap<string, string>();
const silentLogged = new SvelteSet<string>();
// After this long the reply itself says so, with what it waits for: a chat that looks frozen is one the user can stop.
const SILENT_SHOWN_MS = 2 * 60_000;
const SILENT_PREFIX = 'No output for ';
const isSilenceNote = (block: Block | undefined) =>
    block?.kind === 'loading' && block.label.startsWith(SILENT_PREFIX);

/** What the quiet reply is waiting for, from the last thing it did. */
function waitingOn(kind: string | undefined): string {
    if (!kind) return 'the agent';
    if (/^tool_call (Agent|Task)$/.test(kind)) return 'a sub-agent';
    if (kind.startsWith('tool_call '))
        return `the ${kind.slice('tool_call '.length)} tool`;
    if (kind === 'task') return 'a sub-agent or background job';
    return 'the agent';
}

function noteSilence(
    sessionId: string,
    session: SessionItem,
    event: AgentEvent,
) {
    if (event.kind === 'raw') return;
    // The "no output" line goes as soon as anything is heard again (the reducer clears it on most events; usage does not).
    const quiet = liveReplies[sessionId];
    if (quiet && isSilenceNote(quiet.blocks.at(-1)))
        quiet.blocks = quiet.blocks.slice(0, -1);
    lastEventAt.set(sessionId, Date.now());
    lastEventKind.set(
        sessionId,
        event.kind === 'tool_call' ? `tool_call ${event.name}` : event.kind,
    );
    silentLogged.delete(sessionId);
    if (event.kind === 'error')
        logError(
            'turn',
            'turn failed',
            event.message,
            logCtx(sessionId, session),
        );
    else if (event.kind === 'tool_result' && event.is_error)
        logError(
            'mcp',
            'tool failed',
            event.output.slice(0, 600),
            logCtx(sessionId, session),
        );
}
if (typeof window !== 'undefined') {
    setInterval(() => {
        const now = Date.now();
        for (const [id, at] of lastEventAt) {
            if (!replies[id]) {
                lastEventAt.delete(id);
                lastEventKind.delete(id);
                silentLogged.delete(id);
                continue;
            }
            if (now - at > SILENT_SHOWN_MS) {
                const live = liveReplies[id];
                if (live?.live) {
                    const label = `${SILENT_PREFIX}${Math.round((now - at) / 60_000)} min: waiting on ${waitingOn(lastEventKind.get(id))}. Press Stop to cancel.`;
                    const last = live.blocks.at(-1);
                    if (last && isSilenceNote(last) && last.kind === 'loading')
                        last.label = label;
                    else
                        live.blocks = [
                            ...live.blocks,
                            { kind: 'loading', label },
                        ];
                }
            }
            if (now - at > SILENT_AFTER_MS && !silentLogged.has(id)) {
                silentLogged.add(id);
                logFlow(
                    id,
                    'silent',
                    `no event for ${Math.round((now - at) / 1000)} s, last: ${lastEventKind.get(id) ?? '?'}`,
                );
                logError(
                    'turn',
                    `no event for ${Math.round((now - at) / 60_000)} min`,
                    `last: ${lastEventKind.get(id) ?? '?'}`,
                    logCtx(id),
                );
            }
        }
    }, 30_000);
}

/** An agent event as the reducer's events (see run-state.ts). Thinking and usage do not move the run. */
function recordAgentEvent(sessionId: string, event: AgentEvent) {
    switch (event.kind) {
        case 'delta':
            return advanceRun(sessionId, { type: 'output', text: event.text });
        case 'tool_result':
        case 'tool_output_delta':
            return advanceRun(sessionId, { type: 'output' });
        case 'permission_denied':
            for (let index = 0; index < event.requests.length; index++)
                advanceRun(sessionId, { type: 'waitStart', kind: 'approval' });
            return;
        case 'done':
            advanceRun(sessionId, { type: 'output', text: event.text });
            return advanceRun(sessionId, {
                type: 'turnResult',
                isError: false,
            });
        case 'error':
            return advanceRun(sessionId, {
                type: 'turnResult',
                isError: true,
                message: event.message,
            });
        default:
            return;
    }
}

/**
 * After a finished answer, when Settings > Replies allows it: a short extra run of the same CLI proposes next prompts
 * (`chat_suggest`). They are merged after the CLI's own (Claude's, which come first) and dropped if the chat has moved on.
 */
function requestChatSuggestions(
    sessionId: string,
    turn: string,
    answer: string,
) {
    if (!replyStyle.chatSuggestions) return;
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session || (session.agent !== 'claude' && session.agent !== 'codex'))
        return;
    const asked = messagesOf(sessionId).findLast(
        (item) => item.role === 'user',
    );
    const prompt = (asked?.blocks ?? [])
        .flatMap((block) => (block.kind === 'response' ? [block.text] : []))
        .join('\n');
    if (!prompt.trim() || !answer.trim()) return;
    const model =
        session.agent === 'claude' ? 'claude-haiku-5-5' : session.model;
    const known = promptSuggestions[sessionId];
    const existing = known?.turn === turn ? known.items : [];
    void (async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const items = await invoke<string[]>('chat_suggest', {
                provider: session.agent,
                model,
                prompt,
                reply: answer,
                existing,
            });
            if (turns[sessionId] !== turn) return;
            const now = promptSuggestions[sessionId];
            promptSuggestions[sessionId] = {
                turn,
                items: mergePromptSuggestions(
                    now?.turn === turn ? now.items : [],
                    items,
                ),
            };
        } catch (error) {
            logError('turn', 'prompt suggestions failed', error);
        }
    })();
}
/**
 * The CLI went on by itself (a sub-agent or a background job ended and it reports on it): that is a new reply in the
 * chat with no message of the user above it. A CLI that says so while a reply is already live (Copilot, mid-turn) just
 * goes on writing that reply.
 */
function beginAutoTurn(sessionId: string, turn: string, messageId?: string) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session || runReplies.has(turn)) return;
    const besideForeground = Boolean(liveReplies[sessionId]?.live);
    const list = messagesOf(sessionId);
    // Work the user stopped is not reported on: its "stopped" row is not a finished job.
    const candidates = activity.filter(
        (item) =>
            item.sessionId === sessionId &&
            item.background &&
            item.status !== 'stopped' &&
            item.sourceMessageId &&
            (!item.endedAt || Date.now() - item.endedAt < 10_000),
    );
    // Right after the user's Stop, a report with no live background work behind it is the stopped work's leftover.
    if (
        candidates.length === 0 &&
        Date.now() - (userStoppedAt[sessionId] ?? 0) < STOP_REPORT_GRACE_MS
    )
        return;
    const sources = new Set(candidates.map((item) => item.sourceMessageId));
    const source =
        messageId ??
        (sources.size === 1 ? candidates[0]?.sourceMessageId : undefined);
    const runGroup =
        list.find((item) => item.id === source)?.runGroup ?? nextId();
    list.push({
        id: nextId(),
        role: 'assistant',
        time: clock(new Date().toISOString()),
        at: new Date().toISOString(),
        blocks: [],
        live: true,
        startedAt: Date.now(),
        agent: session.agent,
        model: session.model,
        autoTurn: true,
        triggeredByMessageId: source,
        taskTitle:
            candidates.find((item) => item.sourceMessageId === source)
                ?.sourceTitle ?? 'Background work report',
        runGroup,
    });
    const reply = list[list.length - 1];
    // A provider's unsolicited report owns a separate lane when the user is already talking to another run.
    runReplies.set(turn, {
        sessionId,
        reply,
        permission: turnOptionsOf(sessionId).permission,
        planStart: 0,
        listener: besideForeground,
        backgroundTools: new Set(),
    });
    updateLane(sessionId, {
        id: turn,
        role: besideForeground ? 'listener' : 'primary',
        state: 'running',
        backgroundWork: false,
    });
    if (besideForeground) {
        session.status = 'working';
        return;
    }
    liveReplies[sessionId] = reply; // the stored (reactive) object
    replies[sessionId] = reply.id;
    turns[sessionId] = turn;
    delete promptSuggestions[sessionId];
    session.status = 'working';
    const epoch = (runEpochs[sessionId] = (runEpochs[sessionId] ?? 0) + 1);
    advanceRun(sessionId, { type: 'spawn', epoch });
    advanceRun(sessionId, { type: 'turnStarted', epoch });
}

// Streamed text and tool output come as many small events, and each one used to redraw the whole reply on its own: a
// turn of a few thousand events froze the page. They are applied together every COALESCE_MS, in their order; any other
// event first applies what came before it, so a stop or a finished turn never overtakes the text it follows.
const COALESCE_MS = 100;
const STREAMED = new Set<AgentEvent['kind']>([
    'delta',
    'thinking',
    'tool_output_delta',
]);
/** A streamed event, or a sub-agent's streamed event (scoped under its call): both are coalesced, in order. */
function isStreamed(event: AgentEvent): boolean {
    return event.kind === 'scoped'
        ? isStreamed(event.event)
        : STREAMED.has(event.kind);
}
const streamQueue = new SvelteMap<
    string,
    { event: AgentEvent; turn?: string; messageId?: string }[]
>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Applies the queued events of one chat, or of every chat. */
function flushQueued(onlySession?: string) {
    for (const [sessionId, items] of [...streamQueue]) {
        if (onlySession !== undefined && sessionId !== onlySession) continue;
        streamQueue.delete(sessionId);
        const started = performance.now();
        markStep(`apply ${items.length} streamed event(s) of ${sessionId}`);
        // One event that throws must not drop the rest of its chat's queue (a `done` could follow), nor another chat's.
        for (const item of items)
            applyEvent(sessionId, item.event, item.turn, item.messageId);
        const ms = Math.round(performance.now() - started);
        if (ms >= 50 || hangTraceOn())
            logFlow(
                sessionId,
                'applied',
                `${items.length} event(s) in ${ms} ms, last=${items.at(-1)?.event.kind}`,
            );
    }
}
/** `handleEventNow` that never throws: a failing handler is logged and the next event still runs. */
function applyEvent(
    sessionId: string,
    event: AgentEvent,
    turn?: string,
    messageId?: string,
) {
    try {
        handleEventNow(sessionId, event, turn, messageId);
    } catch (error) {
        logError(
            'turn',
            `event handler failed (${event.kind})`,
            error,
            logCtx(sessionId),
        );
    }
}
if (typeof window !== 'undefined')
    window.addEventListener('pagehide', () => flushQueued());

export function handleAgentEvent(
    sessionId: string,
    event: AgentEvent,
    turn?: string,
    messageId?: string,
) {
    if (isStreamed(event)) {
        const items = streamQueue.get(sessionId) ?? [];
        items.push({ event, turn, messageId });
        streamQueue.set(sessionId, items);
        flushTimer ??= setTimeout(() => {
            flushTimer = undefined;
            try {
                flushQueued();
            } finally {
                // Whatever stayed queued (a failure above) is applied on the next tick, not left until the next delta.
                if (streamQueue.size > 0)
                    flushTimer = setTimeout(
                        () => ((flushTimer = undefined), flushQueued()),
                        COALESCE_MS,
                    );
            }
        }, COALESCE_MS);
        return;
    }
    flushQueued(sessionId);
    applyEvent(sessionId, event, turn, messageId);
}

/** Auto-save attempts belong to the originating reply, including offscreen chats and repeated end events. */
const savedPlanCalls = new WeakMap<Message, Set<string>>();
const savedPlanTurns = new WeakMap<Message, Set<string>>();

function planTitle(body: string): string {
    return (
        body.match(/^# (.+)$/m)?.[1].trim() ??
        (body.trim().match(/^[^.!?\n]+[.!?]?/)?.[0] ?? 'Plan').slice(0, 60)
    );
}

/** Saves completed provider plan output through Rust; frontend never parses or writes plan front matter. */
function autoSavePlan(
    session: SessionItem,
    reply: Message,
    event: AgentEvent,
    permission: string | undefined,
    turn?: string,
    start = 0,
) {
    const root = projectOf(session)?.path;
    if (!root || !inTauri() || isPreviewCopy()) return;
    const agent = reply.agent ?? session.agent;
    let body = '';
    let source = '';
    let callId: string | undefined;
    if (
        agent === 'claude' &&
        event.kind === 'tool_call' &&
        event.name === 'ExitPlanMode'
    ) {
        try {
            const input: unknown = JSON.parse(event.input);
            if (
                !input ||
                typeof input !== 'object' ||
                !('plan' in input) ||
                typeof input.plan !== 'string'
            )
                return;
            body = input.plan.trim();
        } catch {
            return; // Incomplete inputs/deltas never cause a save.
        }
        if (!body) return;
        let calls = savedPlanCalls.get(reply);
        if (!calls) savedPlanCalls.set(reply, (calls = new SvelteSet()));
        if (calls.has(event.id)) return;
        calls.add(event.id);
        callId = event.id;
        source = 'exit-plan-mode';
    } else if (
        agent === 'codex' &&
        permission === 'plan' &&
        event.kind === 'done'
    ) {
        let turns = savedPlanTurns.get(reply);
        if (!turns) savedPlanTurns.set(reply, (turns = new SvelteSet()));
        const key = turn ?? reply.id;
        if (turns.has(key)) return;
        turns.add(key);
        const blocks = reply.blocks.slice(start);
        // The provider's final answer wins over preambles; streaming-only providers end in the last response block.
        body =
            event.text.trim() ||
            blocks
                .findLast((block) => block.kind === 'response')
                ?.text.trim() ||
            '';
        if (!body) return;
        const checklist = blocks.findLast(
            (block) =>
                block.kind === 'command' &&
                /^update_plan\s/.test(block.command),
        );
        const steps =
            checklist?.kind === 'command' ? planOf(checklist.command) : null;
        if (steps?.length)
            body +=
                '\n\n## Steps\n' +
                steps
                    .map(
                        (step) =>
                            `- [${step.status === 'completed' ? 'x' : ' '}] ${step.content}`,
                    )
                    .join('\n');
        source = 'codex-plan-mode';
    } else return;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) =>
            invoke<PlanInfo>('plans_save', {
                root,
                title: planTitle(body),
                body,
                agent,
                chat: session.id,
                source,
            }),
        )
        .then((plan) => {
            if (!callId) return;
            const block = reply.blocks.find(
                (block) => block.kind === 'command' && block.id === callId,
            );
            if (block?.kind === 'command')
                block.savedPlan = { id: plan.id, path: plan.path, root };
        })
        .catch((error) => {
            logError('turn', 'could not save plan', error, {
                chat: session.id,
            });
        });
}

function handleEventNow(
    sessionId: string,
    event: AgentEvent,
    turn?: string,
    messageId?: string,
) {
    const ownedRun = turn ? runReplies.get(turn) : undefined;
    // The agent answered: the reply stops saying it is being handed over.
    if (ownedRun?.reply.dispatching) ownedRun.reply.dispatching = false;
    // Task ids correlate to their original cards even after the user has started a newer turn.
    if (event.kind === 'task') {
        updateHistoricalTask(messagesOf(sessionId), event);
    }
    const startsTailReply =
        event.kind === 'auto_turn' && turn?.startsWith('auto-');
    if (
        turn !== undefined &&
        turns[sessionId] !== turn &&
        !ownedRun &&
        !startsTailReply
    ) {
        if (event.kind === 'task')
            trackActivity(sessionId, '', '', event, turn);
        // Late auto-turn markers are stale too: they must not start a reply after a newer user message.
        if (
            event.kind === 'done' ||
            event.kind === 'error' ||
            event.kind === 'auto_turn'
        ) {
            logFlow(
                sessionId,
                'event dropped',
                `turn=${turn} is not the current turn (${turns[sessionId] ?? '-'}) kind=${event.kind}`,
            );
        }
        return;
    }
    // The CLI's prediction of the next prompt comes after the answer: it is kept under that answer, not in the reply.
    if (event.kind === 'suggestion') {
        if (turn !== undefined) {
            const current = promptSuggestions[sessionId];
            promptSuggestions[sessionId] = {
                turn,
                items: addPromptSuggestion(
                    current?.turn === turn ? current.items : [],
                    event.text,
                ),
            };
        }
        return;
    }
    if (event.kind === 'auto_turn') {
        logFlow(sessionId, 'auto turn', `turn=${turn ?? '-'} ${event.reason}`);
        if (turn !== undefined) beginAutoTurn(sessionId, turn, messageId);
        return;
    }
    const currentReply = ownedRun?.reply ?? liveReplies[sessionId];
    const expectedMessage = currentReply?.autoTurn
        ? currentReply.triggeredByMessageId
        : currentReply?.replyTo;
    if (messageId && expectedMessage && messageId !== expectedMessage) {
        logFlow(
            sessionId,
            'event dropped',
            `turn=${turn ?? '-'} message=${messageId} does not belong to reply ${currentReply?.id ?? '-'}`,
        );
        return;
    }
    if (ownedRun) {
        // A shell command that outlives SHELL_WAIT_MS releases the chat (see the timer below); one that finishes cancels it.
        if (event.kind === 'tool_result') clearShellWait(turn, event.id);
        noteRunFiles(sessionId, turn, ownedRun, event);
        const longRunningTool =
            event.kind === 'tool_call' && isLongRunningWork(event.name);
        if (
            event.kind === 'tool_call' &&
            !event.background &&
            isShellCall(event.name)
        ) {
            const owner = ownedRun;
            const callId = event.id;
            armShellWait(turn, callId, () => {
                if (
                    sessionLanes[sessionId]?.find((lane) => lane.id === turn)
                        ?.state !== 'running'
                )
                    return;
                owner.backgroundTools.add(callId);
                promoteShellCall(sessionId, callId);
                updateLane(sessionId, {
                    id: turn!,
                    role: owner.listener ? 'listener' : 'primary',
                    state: 'waiting',
                    backgroundWork: true,
                });
                sendNextQueued(sessionId);
                logFlow(
                    sessionId,
                    'deliver',
                    `turn=${turn} reason=shell>${SHELL_WAIT_MS / 1000}s call=${callId}`,
                );
            });
        }
        if (
            event.kind === 'tool_call' &&
            (event.background || longRunningTool)
        ) {
            ownedRun.backgroundTools.add(event.id);
            updateLane(sessionId, {
                id: turn!,
                role: ownedRun.listener ? 'listener' : 'primary',
                state: 'running',
                backgroundWork: true,
            });
        } else if (
            event.kind === 'tool_result' &&
            ownedRun.backgroundTools.delete(event.id)
        ) {
            updateLane(sessionId, {
                id: turn!,
                role: ownedRun.listener ? 'listener' : 'primary',
                state: 'running',
                backgroundWork: ownedRun.backgroundTools.size > 0,
            });
        } else if (event.kind === 'task') {
            if (event.status === 'started' || event.status === 'progress') {
                ownedRun.backgroundTools.add(event.id);
                if (event.tool_use_id)
                    ownedRun.backgroundTools.add(event.tool_use_id);
            } else {
                ownedRun.backgroundTools.delete(event.id);
                if (event.tool_use_id)
                    ownedRun.backgroundTools.delete(event.tool_use_id);
            }
            const wasWaiting =
                sessionLanes[sessionId]?.find((lane) => lane.id === turn)
                    ?.state === 'waiting';
            updateLane(sessionId, {
                id: turn!,
                role: ownedRun.listener ? 'listener' : 'primary',
                state:
                    wasWaiting && ownedRun.backgroundTools.size
                        ? 'waiting'
                        : 'running',
                backgroundWork: ownedRun.backgroundTools.size > 0,
            });
        }
        if (
            event.kind === 'tool_call' &&
            (isBackgroundWait(event.name, event.background, event.input) ||
                longRunningTool) &&
            ownedRun.backgroundTools.size
        ) {
            updateLane(sessionId, {
                id: turn!,
                role: ownedRun.listener ? 'listener' : 'primary',
                state: 'waiting',
                backgroundWork: true,
            });
            sendNextQueued(sessionId);
        }
        if (event.kind === 'delta' || event.kind === 'thinking') {
            updateLane(sessionId, {
                id: turn!,
                role: ownedRun.listener ? 'listener' : 'primary',
                state: 'running',
                backgroundWork: ownedRun.backgroundTools.size > 0,
            });
        }
    }
    if (event.kind === 'done' || event.kind === 'error')
        logFlow(
            sessionId,
            'reply end',
            `turn=${turn ?? '-'} ${event.kind}${event.kind === 'error' ? ` ${event.message.slice(0, 120)}` : ''} live=${Boolean(liveReplies[sessionId]?.live)} queued=${queued[sessionId]?.length ?? 0}`,
        );
    recordAgentEvent(sessionId, event);
    const session = workspace.sessions.find((item) => item.id === sessionId);
    // The live reply is kept by reference: the chat list can be swapped under it (another chat opened, a transcript
    // reloaded) and the turn must still finish, or the chat would spin for ever.
    const reply =
        ownedRun?.reply ??
        liveReplies[sessionId] ??
        messagesOf(sessionId).find((item) => item.id === replies[sessionId]);
    if (!session) return;
    // Codex writes a thread's rollout, and Claude its session file, only once a run has started. A run stopped before
    // that leaves an id with nothing to resume. The next message then starts a new conversation, instead of resuming
    // that id again and failing the same way.
    if (
        !ownedRun?.listener &&
        event.kind === 'error' &&
        classifyFailure(event.message) === 'conversation'
    ) {
        // The CLI no longer has the conversation this id named (a thread whose run was cut short, a cleaned-up session).
        // The next turn starts a new one, and is given what was said so far as text, so the work in progress is not lost.
        // Reset only the provider conversation that failed. A mixed chat's other provider ids remain valid.
        rememberMixed(session);
        const failedAgent = reply?.agent ?? session.agent;
        if (failedAgent === firstAgentOf(session)) {
            session.agentStarted = false;
            session.agentSession = undefined;
        } else {
            const own = session.agentIds?.[failedAgent];
            if (own) {
                own.id = '';
                own.started = false;
            }
        }
        rememberMixed(session);
        session.forkContext =
            (session.forkContext ?? '') +
            handoffFor(sessionId, lastRequest(sessionId));
    }
    trackActivity(
        sessionId,
        session.title,
        workspace.projects.find((project) => project.id === session.projectId)
            ?.name ?? '',
        event,
        turn,
        {
            agent: reply?.agent ?? session.agent,
            model: reply?.model ?? session.model,
            messageId:
                ownedRun?.ask?.id ??
                reply?.replyTo ??
                reply?.triggeredByMessageId,
            request: ownedRun?.ask
                ? askText(ownedRun.ask)
                : liveAsks[sessionId]
                  ? askText(liveAsks[sessionId])
                  : undefined,
        },
    );
    noteSilence(sessionId, session, event);
    const documentTask = guide.tasks[sessionId];
    if (documentTask?.status === 'working') {
        if (event.kind === 'tool_call')
            documentTask.progress = `Agent is running ${event.name}`;
        if (event.kind === 'tool_result')
            documentTask.progress = event.is_error
                ? `Tool failed: ${event.output.slice(0, 300)}`
                : `Finished ${documentTask.progress.replace(/^Agent is running /, '')}`;
    }
    // A line of the CLI the chat does not show: it is only kept in the Audit log. A model fallback and a context
    // compaction are the ones it does show: the live line says "Compressing context", and a divider marks where it was.
    if (event.kind === 'raw') {
        if (
            reply &&
            event.source === 'claude' &&
            /^model_(refusal_)?fallback$/.test(event.label)
        )
            noteModelFallback(session, reply, event.line);
        if (reply && event.label === 'compacting') reply.compacting = true;
        if (reply && event.label === 'compacted') {
            reply.compacting = false;
            // An auto-compress turn already says so in its one line.
            if (!reply.compressed)
                reply.blocks = [
                    ...reply.blocks,
                    { kind: 'mark', label: 'Context compacted' },
                ];
        }
        return;
    }
    if (!reply) {
        if (event.kind === 'done' || event.kind === 'error') {
            delete replies[sessionId];
            session.status = 'idle';
        }
        return;
    }
    if (event.kind === 'usage') {
        reply.model ??= session.model;
        addUsage(reply, event);
        return;
    }
    if (event.kind === 'done' && event.cost_usd != null)
        reply.cost = (reply.cost ?? 0) + event.cost_usd;
    if (event.kind === 'done' || event.kind === 'error')
        reply.compacting = false;
    if (event.kind === 'done' && turn && !reply.compressed)
        requestChatSuggestions(sessionId, turn, event.text);
    const update = applyAgentEvent(reply.blocks, event);
    reply.blocks = update.blocks;
    reply.notice = update.notice;
    autoSavePlan(
        session,
        reply,
        event,
        ownedRun?.permission,
        turn,
        ownedRun?.planStart,
    );
    if (update.finished && turn) queueWorkerChanges(sessionId, turn);
    if (ownedRun?.listener) {
        if (!update.finished) return;
        reply.live = false;
        if (reply.startedAt) reply.ms = Date.now() - reply.startedAt;
        updateLane(sessionId, {
            id: turn!,
            role: 'listener',
            state: event.kind === 'error' ? 'failed' : 'done',
            backgroundWork: false,
        });
        runReplies.delete(turn!);
        archiveTurn(
            {
                id: sessionId,
                title: session.title,
                agent: reply.agent ?? session.agent,
                model: reply.model ?? session.model,
                projectPath:
                    workspace.projects.find(
                        (project) => project.id === session.projectId,
                    )?.path ?? null,
            },
            [ownedRun.ask, reply].filter((message): message is Message =>
                Boolean(message),
            ),
        );
        ledger.recordTurn(
            chatMetaOf(
                session,
                workspace.projects.find(
                    (project) => project.id === session.projectId,
                )?.path ?? null,
            ),
            [ownedRun.ask, reply].filter((message): message is Message =>
                Boolean(message),
            ),
            event.kind === 'done' ? 'done' : 'error',
        );
        void finishCommandImages(sessionId, reply);
        if (session.path) {
            if (ownedRun.ask) keepOtherTurn(session, ownedRun.ask);
            keepOtherTurn(session, reply);
        }
        if (reply.tokens)
            recordUsage({
                at: new Date().toISOString(),
                sessionId,
                agent: reply.agent ?? session.agent,
                model: reply.model ?? session.model,
                projectId: session.projectId,
                ms: reply.ms,
                tokens: { ...reply.tokens },
                cost: reply.cost ?? estimateCost(reply.tokens, reply.model),
                estimated: reply.cost == null,
            });
        persistLocal();
        session.status =
            replies[sessionId] || (sessionLanes[sessionId]?.length ?? 0) > 0
                ? 'working'
                : 'idle';
        sendNextQueued(sessionId);
        return;
    }
    // An auto-compress turn shows one line: what `/compact` prints is not an answer.
    if (reply.compressed && event.kind !== 'error')
        reply.blocks =
            event.kind === 'done'
                ? [
                      {
                          kind: 'response',
                          text: '*Context compressed: the conversation goes on from a summary of what came before.*',
                      },
                  ]
                : [{ kind: 'loading', label: 'Compressing context…' }];
    if (event.kind === 'tool_result' && event.image)
        persistCommandImage(sessionId, reply, event.id, event.image);
    // A delegate_task call just showed up: its card follows the task the call starts.
    if (
        event.kind === 'tool_call' &&
        toolKindOf(event.name) === 'delegate_task'
    )
        bindTasks(sessionId);
    // A provider can announce an id before it has persisted anything resumable (Codex's thread.started is one
    // example). Keep that id for history mapping immediately, but mark it resumable only after a real conversation
    // event. Ctrl/Cmd+Enter can otherwise interrupt inside that gap and resume a rollout/session that does not exist.
    const first = firstAgentOf(session);
    const agent = reply.agent ?? session.agent;
    const confirmsConversation =
        event.kind !== 'session' && event.kind !== 'error';
    if (agent === first) {
        if (update.agentSession) session.agentSession = update.agentSession;
        if (confirmsConversation) session.agentStarted = true;
    } else {
        const existing = session.agentIds?.[agent];
        const id = update.agentSession ?? existing?.id;
        if (id) {
            session.agentIds ??= {};
            session.agentIds[agent] = {
                ...existing,
                id,
                started: confirmsConversation || existing?.started === true,
            };
        }
    }
    // Persist the provider id as soon as the CLI confirms it. A new model/account/edit can replace the current id,
    // but every old and new transcript still belongs to this AgentDeck chat and must alias back to the same owner.
    if (update.agentSession) rememberMixed(session);
    // A finished turn: this conversation has now seen every turn of the chat, its own reply included (see binding.ts).
    if (update.finished && event.kind !== 'error' && !ownedRun?.listener) {
        session.syncedSeq ??= {};
        session.syncedSeq[agent] = messagesOf(sessionId).length;
    }
    // A finished reply whose question block was too broken for the deterministic parser: ask the session's own model to
    // repair the JSON, once, before the card would otherwise fall back to showing the raw block as text.
    if (
        update.finished &&
        event.kind === 'done' &&
        !ownedRun?.listener &&
        !reply.questionsRepairTried
    ) {
        reply.questionsRepairTried = true;
        void fetchQuestionRepair(reply, session).then((fix) => {
            if (!fix) return;
            reply.blocks = reply.blocks.map((block, at) =>
                at === fix.index && block.kind === 'response'
                    ? { ...block, text: fix.text }
                    : block,
            );
            reply.questionsRepaired = true;
            persistLocal();
        });
    }
    // A failed turn that can be carried on (retry, another account, the next agent) does not end the work: the chat
    // gets a line saying what happens, and the steps below that close the work (failure, reports) are skipped.
    const failureKind =
        event.kind === 'error' ? classifyFailure(event.message) : null;
    // The provider that failed is the turn's route, not the chat's current pick (see runAutoSwitch).
    const failedAgent = reply.agent ?? session.agent;
    const failedModel = reply.model ?? session.model;
    const customProviderId =
        failedAgent === 'custom'
            ? parseCustomModel(failedModel)?.providerId
            : undefined;
    const autoSwitchConnector = credentialScope(failedAgent);
    const autoSwitchRequested = Boolean(
        update.finished &&
        event.kind === 'error' &&
        (failureKind === 'limit' || failureKind === 'auth') &&
        (failedAgent === 'custom'
            ? connectors.custom.some(
                  (provider) =>
                      provider.id === customProviderId && provider.autoSwitch,
              )
            : ['claude', 'codex', 'copilot', 'agy'].includes(
                  autoSwitchConnector,
              ) &&
              connectors.autoSwitch[autoSwitchConnector as AccountConnectorId]),
    );
    const recovery =
        update.finished && event.kind === 'error' && !autoSwitchRequested
            ? recoveryFor(session, event.message, reply)
            : null;
    const recovering =
        autoSwitchRequested ||
        (recovery !== null && recovery.plan.action !== 'stop');
    // The chat goes on from this failure (a retry, a fallback, an account switch): its end is owed until one of them
    // closes it, or a Stop does. Only the steps that close the work wait for that.
    if (recovering && event.kind === 'error')
        owed.set(sessionId, { reply, reason: clipText(event.message, 200) });
    let autoSwitchBlockId: string | null = null;
    if (update.finished && event.kind !== 'error') {
        cancelAutoSwitch(sessionId);
        dropRecovery(sessionId);
        // A turn that finished well while a failed one was still owed (a continuation takes it over when it starts, so this
        // is another turn): the failed turn is closed now rather than left open.
        closeOwedTurn(sessionId);
        delete resumeAutoChoice[sessionId];
        delete resumeSince[sessionId];
    }
    // A limit with nowhere to move: wait for it to reset, then carry on (see `resumes`).
    if (
        update.finished &&
        event.kind === 'error' &&
        !recovering &&
        classifyFailure(event.message) === 'limit'
    )
        scheduleResume(session, event.message);
    if (recovery) {
        const plan = recovery.plan;
        const fallbackTarget =
            plan.action === 'fallback'
                ? recoveryTarget(plan.agent, sessionId)
                : undefined;
        const note = recoveryNote(recovery.kind, plan, {
            from: agentLabel(failedAgent, failedModel),
            to: fallbackTarget
                ? agentLabel(fallbackTarget.agent, fallbackTarget.model)
                : undefined,
        });
        reply.blocks = [
            ...reply.blocks,
            { kind: 'response', text: `> ↻ ${note}` },
        ];
    }
    if (autoSwitchRequested) {
        autoSwitchBlockId = nextId();
        reply.blocks = [
            ...reply.blocks,
            {
                kind: 'command',
                id: autoSwitchBlockId,
                command: 'AgentDeck · waiting for account switch',
                output: 'Elapsed 0s',
                status: 'running',
            },
        ];
    }
    if (update.finished) {
        for (const id of reply.taskIds ?? []) {
            if (delegateTasks[id])
                delegateTasks[id].reportState =
                    event.kind === 'error' ? 'failed' : 'done';
        }
        updateLane(sessionId, {
            id: turn!,
            role: 'primary',
            state: event.kind === 'error' ? 'failed' : 'done',
            backgroundWork: false,
        });
        runReplies.delete(turn!);
        if (documentTask?.status === 'working' && !recovering) {
            documentTask.status = event.kind === 'error' ? 'error' : 'done';
            documentTask.progress =
                event.kind === 'error'
                    ? 'Document task failed'
                    : 'Document task finished';
            documentTask.result =
                event.kind === 'error'
                    ? event.message
                    : event.kind === 'done'
                      ? event.text ||
                        reply.blocks
                            .flatMap((block) =>
                                block.kind === 'response' ? [block.text] : [],
                            )
                            .join('\n')
                            .trim()
                      : reply.blocks
                            .flatMap((block) =>
                                block.kind === 'response' ? [block.text] : [],
                            )
                            .join('\n')
                            .trim();
            documentTask.outputPath = documentTask.result.match(
                /(?:[A-Za-z]:\\|\\\\|\/|docs[\\/])[^\n\r"'<>]*?\.(?:docx|pdf|pptx|webm|html|md)\b/i,
            )?.[0];
        }
        // The chat is released in `finally`: a step here that throws must not leave it working for ever.
        try {
            if (event.kind === 'error' && !recovering)
                failSessionWork(sessionId);
            reply.live = false;
            void finishCommandImages(sessionId, reply);
            if (session.path && session.source) {
                if (reply.agent && reply.agent !== session.source)
                    keepOtherTurn(session, reply);
                rememberMixed(session);
            }
            if (reply.startedAt) reply.ms = Date.now() - reply.startedAt;
            if (reply.tokens) {
                const estimate = estimateCost(reply.tokens, reply.model);
                recordUsage({
                    at: new Date().toISOString(),
                    sessionId,
                    agent: session.agent,
                    model: reply.model,
                    projectId: session.projectId,
                    ms: reply.ms,
                    tokens: { ...reply.tokens },
                    cost: reply.cost ?? estimate,
                    estimated: reply.cost == null,
                });
            }
            openServedPage(sessionId, reply);
            const coordination = finishCoordinationPrompt(sessionId);
            if (coordination?.questionId && event.kind !== 'error') {
                const text = reply.blocks
                    .filter(
                        (
                            block,
                        ): block is Extract<Block, { kind: 'response' }> =>
                            block.kind === 'response',
                    )
                    .map((block) => block.text)
                    .join('\n')
                    .trim();
                answerPendingTaskQuestion(
                    coordination.questionId,
                    sessionId,
                    text,
                );
            }
            // A worker or a hand-back that is being carried on is not over: its waiter gets the turn that finishes it.
            if (!recovering) {
                // A teammate's note turn is not the worker's end: its report was kept (see teamNoteDone).
                if (coordination?.teamNote) teamNoteDone(sessionId);
                else
                    onDelegateDone(
                        sessionId,
                        reply,
                        event.kind === 'error' ? event.message : null,
                    );
                finishWorkflowTurn(
                    sessionId,
                    event.kind === 'error' && !recovering,
                    reply,
                );
                finishWorkflowIntegration(
                    sessionId,
                    reply,
                    event.kind === 'error',
                );
                endWaitingTasks(sessionId);
                // Auto review (model popover): a main chat's turn that changed files gets a clean-context review.
                if (event.kind === 'done' && !coordination && !reply.compressed)
                    maybeAutoReview(sessionId, reply);
            } else {
                // The worker is being recovered: its caller hears why, through the watchdog's check-in, and the task goes on.
                const failure = (
                    event.kind === 'error' ? event.message : ''
                ).slice(0, 200);
                noteWorkerRecovering(
                    sessionId,
                    autoSwitchRequested
                        ? 'waiting for an account switch'
                        : `${recovery?.plan.action === 'fallback' ? 'moving to another agent' : 'retrying'} after: ${failure}`,
                );
            }
            // Our own copy of the turn (agent, model, time), apart from what the CLIs store: the base for syncing later.
            archiveTurn(
                {
                    id: sessionId,
                    title: session.title,
                    agent: session.agent,
                    model: reply.model ?? session.model,
                    projectPath:
                        workspace.projects.find(
                            (project) => project.id === session.projectId,
                        )?.path ?? null,
                },
                [liveAsks[sessionId], reply].filter(
                    (message): message is Message => Boolean(message),
                ),
            );
            // The same turn for the chat ledger: only a turn that ended without error and is not being recovered.
            ledger.recordTurn(
                chatMetaOf(
                    session,
                    workspace.projects.find(
                        (project) => project.id === session.projectId,
                    )?.path ?? null,
                ),
                [liveAsks[sessionId], reply].filter(
                    (message): message is Message => Boolean(message),
                ),
                event.kind === 'done' && !recovering ? 'done' : 'error',
            );
        } finally {
            if (update.finished && !recovering) {
                // The turn is over: the Preview tabs it held are free again for another chat to reuse.
                releaseBrowserChat(sessionId);
                const project = workspace.projects.find(
                    (item) => item.id === session.projectId,
                );
                const status =
                    event.kind === 'done'
                        ? 'completed'
                        : event.kind === 'error' && event.message === 'stopped'
                          ? 'stopped'
                          : 'failed';
                void recordProjectActivity({
                    root: project?.path ?? '',
                    project: project?.name ?? '',
                    sessionId: session.id,
                    chatTitle: session.title,
                    agent: reply.agent ?? session.agent,
                    model: reply.model ?? session.model,
                    status,
                    request: liveAsks[sessionId],
                    reply,
                    note:
                        event.kind === 'error' && event.message !== 'stopped'
                            ? event.message
                            : undefined,
                });
            }
            delete replies[sessionId];
            delete liveReplies[sessionId];
            delete liveAsks[sessionId];
            delete liveHandouts[sessionId];
            session.status =
                (sessionLanes[sessionId]?.length ?? 0) > 0 ? 'working' : 'idle';
            persistLocal();
            // The CLI wrote the conversation to disk: pick it up so the row gets its path, in place (same id).
            // The held list stays: the next open checks its newest messages against the file (see history.svelte).
            session.updatedAt = new Date().toISOString();
            if (!session.path) void importHistory({ refresh: true });
            // Track the final Markdown animation independently of provider execution and queue delivery.
            const responseBlocks = reply.blocks.flatMap((block, index) =>
                block.kind === 'response' && block.text ? [index] : [],
            );
            const recoveryTaken =
                (autoSwitchRequested &&
                    autoSwitchBlockId &&
                    event.kind === 'error') ||
                (recovering && recovery && event.kind === 'error');
            if (
                autoSwitchRequested &&
                autoSwitchBlockId &&
                event.kind === 'error'
            )
                void runAutoSwitch(
                    sessionId,
                    clipText(event.message, 200),
                    reply,
                    autoSwitchBlockId,
                );
            else if (recovering && recovery && event.kind === 'error')
                void runRecovery(
                    sessionId,
                    recovery.plan,
                    clipText(event.message, 200),
                    failedAgent,
                );
            // A picker change made while this turn ran applies now that it has ended (D3), after the recovery above chose its route.
            if (update.finished) applyPendingSwitch(sessionId);
            if (recoveryTaken) {
                // The recovery carries the chat on: it sends the next turn, or closes this one when no turn follows.
            } else if (
                sessionId === workspace.activeId &&
                responseBlocks.length &&
                !needsUserInput(sessionId)
            ) {
                renderWaiters[sessionId] = {
                    messageId: reply.id,
                    blocks: new Set(responseBlocks),
                };
                // An offscreen virtual block never reports: expire its presentation state without blocking delivery.
                const waitingFor = renderWaiters[sessionId];
                logFlow(
                    sessionId,
                    'render wait',
                    `reply ${reply.id}: tracking ${responseBlocks.length} block(s) drawing`,
                );
                setTimeout(() => {
                    if (renderWaiters[sessionId] !== waitingFor) return;
                    delete renderWaiters[sessionId];
                    logFlow(
                        sessionId,
                        'render wait timed out',
                        `reply ${reply.id} was not drawn in ${RENDER_WAIT_LIMIT_MS} ms: clearing presentation state`,
                    );
                    sendNextQueued(sessionId);
                }, RENDER_WAIT_LIMIT_MS);
                // Rendering is presentation only: an offscreen virtual block must not add 15 seconds between queued turns.
                sendNextQueued(sessionId);
            } else sendNextQueued(sessionId);
        }
    }
}

if (inTauri() && !isPreviewCopy()) {
    // A fast stream sends dozens of deltas a second; each one re-rendered the chat. Apply them once per frame.
    let queue: {
        session: string;
        turn: string;
        message_id?: string;
        event: AgentEvent;
    }[] = [];
    const flush = () => {
        if (!queue.length) return; // already applied by the other of the two triggers
        const batch = queue;
        queue = [];
        for (const { session, turn, message_id, event } of batch) {
            // One event that throws must not drop the rest of the frame: a `done` behind it (of this chat or of another
            // running at the same time) would be lost, and that chat would show it is working for ever.
            try {
                handleAgentEvent(session, event, turn, message_id);
            } catch (error) {
                console.error('agent event failed', session, event.kind, error);
            }
        }
    };
    void listenAgentEvents((envelope) => {
        if (queue.push(envelope) !== 1) return;
        // A hidden or minimised window gets no animation frames: the timer applies the events then, so a turn still
        // ends (and its queue, its notification and the agents waiting on it go on) while nobody looks.
        requestAnimationFrame(flush);
        setTimeout(flush, 250);
    });
}
