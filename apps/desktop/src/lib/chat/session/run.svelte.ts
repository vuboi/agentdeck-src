import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { credentialBusy } from '../../agents/credential-switch';
import { credentialScope } from '../../agents/credential-scope';
import { inTauri, clock } from '../../app/platform/history';
import {
    accountEpoch,
    accountEpochsLoaded,
    accountEpochsReady,
} from '../runs/account-epoch.svelte';
import {
    pictureData,
    prehandleAntigravity,
    prehandleAttachments,
    prehandleOpencode,
    prewarmAgent,
    repairQuestionJson,
    saveAttachment,
    sendCustomTurn,
    sendAgentTurn,
    stopAgentTurn,
    answerCopilotPermission,
} from '../agent';
import {
    activeProviderKey,
    claudeCreditOn,
    claudeCreditState,
    connectors,
    currentCredentialId,
    providerKeyEnv,
    providerQuotas,
    usagePct,
} from '../../agents/connectors.svelte';
import { type Message, messages as mockMessages } from '../mock';
import { guide } from '../../app/ui/guide.svelte';
import { logFlow } from '../../tasks/flow-log';
import { sessionMark } from '../content/chat-dividers';
import { within, PREPARE_LIMIT_MS } from '../../app/text/within';
import { expandSlash } from '../slash.svelte';
import {
    effortLabel,
    modelLabel,
    parseCustomModel,
    supportedEffortValues,
} from '../../agents/models.svelte';
import { routesOf, taskRoleHint } from '../../agents/task-roles';
import { taskRoles } from '../../agents/task-roles.svelte';
import { agentDisplayName } from '../../agents/provider-registry';
import { customProviderOf } from '../../agents/provider-registry';
import { mcp } from '../../agents/mcp.svelte';
import { automation } from '../../app/platform/automation.svelte';
import { logError } from '../../app/platform/error-log.svelte';
import {
    DELEGATE_HINT,
    DELEGATE_REMINDER,
    agentdeckLead,
    isLongPrompt,
    looksNontrivial,
} from '../../tasks/delegate-task';
import { houseStyleHint } from '../content/house-style';
import { replyStyle } from '../content/reply-style.svelte';
import { requestAt } from '../runs/change-ledger';
import { memoryHint, readProjectMemory } from '../content/project-memory';
import {
    learnFromPrompt,
    loadProfile,
    profileHint,
} from '../content/user-profile';
import { logRequest } from '../runs/activity.svelte';
import { setPref } from '../../app/platform/prefs';
import { type RunLane, deliveryFor } from '../runs/run-lanes';
import { userAskedMeanwhileNotice } from '../runs/notices';
import { notifyRun, takeNoticeBlock } from '../runs/notices.svelte';
import {
    keepsWording,
    parseQuestions,
    unparsedQuestionBody,
    withRepairedBody,
    type Question,
} from '../recovery/questions';
import { dequeue, enqueueNext } from '../runs/queue';
import {
    MODELS,
    activeSession,
    advanceRun,
    localMessages,
    nextId,
    persistLocal,
    runEpochs,
    sessionCwd,
    workspace,
    type Agent,
    type Attachment,
    type Effort,
    type FileAttachment,
    type SessionItem,
} from './state.svelte';
import {
    type Bound,
    type Reason,
    type ChatBindings,
    resolveBinding,
} from './binding';
import {
    AGENTDECK_HINT,
    KNOWS_PREVIEW,
    NATIVE_DELEGATION,
    NATIVE_DELEGATION_HINT,
    NO_DELEGATE_HINT,
    NO_DELEGATE_TOOLS,
    OPEN_WORDS,
    PERMISSION_MODE,
    agentLabel,
    approved,
    continuationGroups,
    delegateHinted,
    hasTurnWork,
    hiddenPrompt,
    isRunning,
    lastPrompt,
    missedTurns,
    nativeDelegationHinted,
    orchestrateTold,
    queuePaused,
    queued,
    rememberDelegateHint,
    rememberLastChat,
    rememberNativeDelegationHint,
    turnOptionsOf,
    turns,
    effortFor,
    chatModel,
    firstAgentOf,
} from './turns.svelte';
import {
    handleAgentEvent,
    lastEventAt,
    lastEventKind,
    manuallyStopped,
    recoveryChain,
    recoveryTarget,
} from './events.svelte';
import {
    answerWorkerApproval,
    backlog,
    flushReports,
    isWorkerChat,
} from './delegate-task.svelte';
import { LANGUAGE_RULE } from './orchestration.svelte';
import {
    COMPACT_COMMAND,
    MODEL_LEAD,
    compressIfNeeded,
    flushCoordinationPrompt,
    handoffDigest,
    liveModel,
    send,
    sendImmediate,
} from './sending.svelte';
import {
    chat,
    messagesById,
    rememberMixed,
    setMessages,
    settleKeptPermission,
} from './history.svelte';

/** The chats that ran a turn since the app started: the first turn of any other chat that resumes a conversation resumes a session from before. */
const touchedThisRun = new SvelteSet<string>();
/** Chats whose next turn starts another CLI conversation (an edited message): that turn carries a "New session" line. */
export const pendingNew = new SvelteSet<string>();

/** When each chat's CLI was last asked to start ahead (by chat, agent and model), so typing does not ask on every key. */
/** Chats whose previous turn got DELEGATE_REMINDER (not repeated for a short follow-up). */
const reminded = new SvelteMap<string, boolean>();
const prewarmedAt = new SvelteMap<string, number>();

type PreHandler =
    | {
          via: 'http';
          label: string;
          kind: string;
          baseUrl: string;
          apiKey: string | null;
          model: string;
          effort?: string;
      }
    | {
          via: 'opencode' | 'antigravity';
          label: string;
          model: string;
          effort?: string;
      };
/** `route` is the `agent|model|effort` route the Task roles settings name this model by (see agents/task-roles.ts). */
type Candidate = { pick: PreHandler; route: string };
/** The wait for a CLI pre-handle: the CLI starts, then the model answers (the Rust side stops at 120 s). */
const CLI_PREPARE_LIMIT_MS = 120_000;
/** The Claude 5 models the Console credit runs (the `credit:` ids without the prefix). */
const CLAUDE_CREDIT_MODELS = [
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
];
/**
 * The model that reads a turn's attachments: only the models picked for the image role in Task roles, in priority order.
 * Nothing is picked by default: with no pick, or the role switched off, the main agent reads the pictures itself. A pick
 * that fails at run time also goes back to the main agent, and is left out for a while (prehandleFailed).
 */
function prehandleProvider(): PreHandler | undefined {
    if (!routesOf(taskRoles, 'read').length) return undefined;
    const candidates: Candidate[] = [];
    for (const provider of connectors.custom.filter(
        (item) => item.enabled && !item.restricted && item.baseUrl.trim(),
    )) {
        const key = activeProviderKey(provider);
        if (
            providerQuotas[`${provider.id}:${key?.id ?? 'default'}`]
                ?.remaining === 0
        )
            continue;
        for (const model of new Set(
            [...provider.models, provider.defaultModel].filter(Boolean),
        )) {
            const base = {
                via: 'http' as const,
                label: `${provider.kind}:${provider.id}`,
                kind: provider.kind,
                baseUrl: provider.baseUrl,
                apiKey: key?.apiKey || null,
                model,
            };
            candidates.push({ route: `${provider.id}|${model}`, pick: base });
            for (const effort of supportedEffortValues(
                'custom',
                `${provider.id}::${model}`,
            ))
                candidates.push({
                    route: `${provider.id}|${model}|${effort}`,
                    pick: { ...base, effort },
                });
        }
    }
    if (claudeCreditOn() && !((claudeCreditState.reading?.balance ?? 1) <= 0)) {
        for (const model of CLAUDE_CREDIT_MODELS) {
            const base = {
                via: 'http' as const,
                label: 'claude-credit',
                kind: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                apiKey: connectors.claudeCredit.apiKey.trim(),
                model,
            };
            candidates.push({ route: `claude|credit:${model}`, pick: base });
            for (const effort of supportedEffortValues(
                'claude',
                `credit:${model}`,
            ))
                candidates.push({
                    route: `claude|credit:${model}|${effort}`,
                    pick: { ...base, effort },
                });
        }
    }
    for (const item of MODELS.copilot) {
        const base = {
            via: 'http' as const,
            label: 'copilot',
            kind: 'copilot',
            baseUrl: 'https://api.githubcopilot.com',
            apiKey: null,
            model: item.value,
        };
        candidates.push({ route: `copilot|${item.value}`, pick: base });
        for (const effort of supportedEffortValues('copilot', item.value))
            candidates.push({
                route: `copilot|${item.value}|${effort}`,
                pick: { ...base, effort },
            });
    }
    for (const item of MODELS.opencode) {
        candidates.push({
            route: `opencode|${item.value}`,
            pick: { via: 'opencode', label: 'opencode', model: item.value },
        });
    }
    // An Antigravity model at its usage limit is skipped; its CLI prints no usable memo once it is out.
    for (const item of MODELS.antigravity) {
        if ((usagePct('antigravity', item.value) ?? 0) >= 100) continue;
        const base = {
            via: 'antigravity' as const,
            label: 'antigravity',
            model: item.value,
        };
        candidates.push({ route: `antigravity|${item.value}`, pick: base });
        for (const effort of supportedEffortValues('antigravity', item.value))
            candidates.push({
                route: `antigravity|${item.value}|${effort}`,
                pick: { ...base, effort },
            });
    }
    // A model that failed lately (expired key, no quota) is left out for a while: the turn that failed went to the main
    // agent, and the next turns take the next model instead of failing on the same one again.
    const usable = candidates.filter(
        (item) =>
            Date.now() - (prehandleFailed.get(pickKey(item.pick)) ?? 0) >
            PREHANDLE_COOLDOWN_MS,
    );
    return routesOf(taskRoles, 'read')
        .map((route) => usable.find((item) => item.route === route))
        .find((item) => item !== undefined)?.pick;
}

/** A route as the user reads it: "Codex GPT 5.6 Terra". */
const routeLabel = (route: string) => {
    const [agent, model, effort] = route.split('|');
    const custom = connectors.custom.find((item) => item.id === agent);
    return `${custom?.name ?? agentDisplayName(agent)} ${modelLabel(custom ? `${agent}::${model}` : model)}${effort ? ` · ${effortLabel(effort)}` : ''}`;
};

/** The pick a failed pre-handle is remembered by. */
const pickKey = (pick: PreHandler) => `${pick.label}|${pick.model}`;
/** When each pick last failed to read pictures, and how long it is left out after that. */
const prehandleFailed = new SvelteMap<string, number>();
const PREHANDLE_COOLDOWN_MS = 10 * 60_000;

/** The conversation id a Claude chat takes after an account switch (by account epoch), so the CLI started ahead for it is the one used. */
const accountNext: Record<string, { epoch: number; id: string }> = {};
function accountConversationId(sessionId: string, epoch: number): string {
    const ready = accountNext[sessionId];
    if (ready?.epoch === epoch) return ready.id;
    const id = crypto.randomUUID();
    accountNext[sessionId] = { epoch, id };
    return id;
}

/** The conversation id a chat's own id names (`claude:<uuid>`), unless the conversation was reset. */
function idNamedByChat(
    session: SessionItem,
    agent: string,
): string | undefined {
    const prefix = `${agent}:`;
    return session.agentStarted === false || !session.id.startsWith(prefix)
        ? undefined
        : session.id.slice(prefix.length);
}

/** The conversation id a chat's agent already has: the one kept on the chat, else the one its id names. Shared by
 *  prewarmChat and startTurn (boundsOf), so both start or resume the same conversation (D10). */
function existingConversationId(
    session: SessionItem,
    agent: string,
): string | undefined {
    return session.agentSession ?? idNamedByChat(session, agent);
}

/**
 * Starts the CLI of a chat whose next message is being typed (Claude, Codex, Antigravity keep it open between turns,
 * see warm.rs), with what `startTurn` will send, so the first turn does not wait for it to load. Nothing is changed in
 * the chat, except that a new Claude chat gets the conversation id its first turn will use. A turn that will start a
 * new conversation (another model, another account) is left to start on its own.
 */
export function prewarmChat(sessionId: string) {
    // The epoch is compared only once the saved account counts have arrived (or their short wait ran out), so a chat
    // does not take a switch that has not happened for one (D6).
    if (!accountEpochsLoaded) {
        void accountEpochsReady.then(() => prewarmChat(sessionId));
        return;
    }
    const selected = workspace.sessions.find((item) => item.id === sessionId);
    if (
        selected &&
        credentialBusy(credentialScope(selected.agent, selected.model))
    )
        return;
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (
        !session ||
        !inTauri() ||
        ![
            'claude',
            'codex',
            'antigravity',
            'opencode',
            'workbuddy',
            'copilot',
        ].includes(session.agent) ||
        isRunning(session.id)
    )
        return;
    const picked = chatModel(session);
    // A model no longer offered is not started ahead: the chat's next send says so (see startTurn).
    if ('missing' in picked) return;
    const selectedModel = picked.model;
    const now = Date.now();
    const scope = credentialScope(session.agent, session.model);
    const epoch = accountEpoch[scope] ?? 0;
    // The account is part of the throttle: a switch makes a new CLI worth starting at once.
    const throttle = `${session.id}|${session.agent}|${selectedModel}|${epoch}`;
    if (now - (prewarmedAt.get(throttle) ?? 0) < 60_000) return;
    prewarmedAt.set(throttle, now);
    const first = firstAgentOf(session);
    let cliId: string | null;
    let resume: boolean;
    if (session.agent === first) {
        if (session.agentEpoch !== undefined && session.agentEpoch !== epoch) {
            // The account changed: the next turn starts a new conversation under it (see startTurn). Its CLI is started now,
            // with the id that turn will use, so the first message does not wait for the start.
            cliId =
                session.agent === 'claude'
                    ? accountConversationId(session.id, epoch)
                    : null;
            resume = false;
        } else if (
            session.conversationModel &&
            session.conversationModel !== selectedModel &&
            !liveModel(session.agent)
        ) {
            // Another model starts a new conversation (see startTurn), which its CLI starts on its own when the message comes.
            cliId = null;
            resume = false;
        } else {
            // The same choice of conversation id as startTurn makes (boundsOf): see existingConversationId.
            if (
                !existingConversationId(session, session.agent) &&
                session.agent === 'claude'
            )
                session.agentSession = crypto.randomUUID();
            cliId = existingConversationId(session, session.agent) ?? null;
            resume = cliId !== null && (session.agentStarted ?? !!session.path);
        }
    } else {
        const own = session.agentIds?.[session.agent];
        // A first turn of Claude here picks its id then; Codex and Antigravity name theirs, so they start without one.
        if (!own && session.agent === 'claude') return;
        if (own && own.epoch !== undefined && own.epoch !== epoch) return;
        if (
            session.agentModels?.[session.agent] &&
            session.agentModels[session.agent] !== selectedModel &&
            !liveModel(session.agent)
        )
            return;
        cliId = own?.id || null;
        resume = cliId !== null && Boolean(own?.started);
    }
    const cwd = sessionCwd(session);
    void prewarmAgent({
        session: session.id,
        agent: session.agent,
        agentSession: cliId,
        resume,
        model: selectedModel,
        permissionMode: PERMISSION_MODE[turnOptionsOf(session.id).permission],
        effort: effortFor(session),
        allowedTools: [...(approved[session.id] ?? [])],
        cwd,
    }).catch(() => {});
}

/**
 * Starts the CLI of the agent a chat would fall back to (Settings: keep working when an agent fails) while the chat's own
 * agent works, so a failure at a limit does not also wait for a cold start. Only Codex and Antigravity name their own
 * conversation, so only they can be started ahead without an id; Claude as a fallback starts when it is needed.
 */
function prewarmFallback(session: SessionItem) {
    if (!connectors.recovery.enabled || !inTauri()) return;
    const target = recoveryChain()
        .map((route) => ({ route, target: recoveryTarget(route) }))
        .find(
            ({ target }) =>
                target &&
                target.agent !== session.agent &&
                ['codex', 'antigravity'].includes(target.agent),
        );
    const picked = target?.target;
    if (!target || !picked) return;
    const throttle = `${session.id}|${target.route}|${picked.model}|${picked.effort ?? ''}|fallback`;
    const now = Date.now();
    if (now - (prewarmedAt.get(throttle) ?? 0) < 300_000) return;
    prewarmedAt.set(throttle, now);
    const cwd = sessionCwd(session);
    void prewarmAgent({
        session: session.id,
        agent: picked.agent,
        agentSession: null,
        resume: false,
        model: picked.model,
        permissionMode: PERMISSION_MODE[turnOptionsOf(session.id).permission],
        effort: picked.effort ?? null,
        allowedTools: [...(approved[session.id] ?? [])],
        cwd,
    }).catch(() => {});
}

/** The chat's CLI conversations as the binding rules see them (see binding.ts). The chat's first agent keeps its
 *  conversation in `agentSession` / `agentStarted` / `conversationModel` / `agentEpoch`; the others in `agentIds`. */
function boundsOf(
    session: SessionItem,
    first: Agent,
    mint: (() => string) | undefined,
): Partial<Record<string, Bound>> {
    const bounds: Partial<Record<string, Bound>> = {};
    bounds[first] = {
        id:
            existingConversationId(session, first) ??
            (first === session.agent ? (mint?.() ?? '') : ''),
        started: session.agentStarted ?? Boolean(session.path),
        model: session.conversationModel || undefined,
        epoch: session.agentEpoch,
        syncedSeq: session.syncedSeq?.[first] ?? 0,
    };
    for (const [agent, own] of Object.entries(session.agentIds ?? {})) {
        if (!own || agent === first) continue;
        bounds[agent] = {
            id: own.id || (agent === session.agent ? (mint?.() ?? '') : ''),
            started: own.started,
            model: session.agentModels?.[agent as Agent] || undefined,
            epoch: own.epoch,
            syncedSeq: session.syncedSeq?.[agent as Agent] ?? 0,
        };
    }
    return bounds;
}

/** Stores a conversation back on the chat, in the fields `boundsOf` reads. */
function writeBound(
    session: SessionItem,
    first: Agent,
    agent: string,
    bound: Bound,
) {
    if (agent === first) {
        session.agentSession = bound.id || undefined;
        session.agentStarted = bound.started;
        session.conversationModel = bound.model;
        session.agentEpoch = bound.epoch;
    } else {
        (session.agentIds ??= {})[agent as Agent] = {
            id: bound.id,
            started: bound.started,
            epoch: bound.epoch,
        };
        (session.agentModels ??= {})[agent as Agent] = bound.model ?? '';
    }
    (session.syncedSeq ??= {})[agent as Agent] = bound.syncedSeq;
}

/** D-A: a send whose saved model is no longer offered is not run; the chat says so, as the agent's answer would. */
function sayModelMissing(sessionId: string, model: string) {
    messagesOf(sessionId).push({
        id: nextId(),
        role: 'assistant',
        time: clock(new SvelteDate().toISOString()),
        blocks: [
            {
                kind: 'response',
                text: `The model ${model} is no longer available. Pick a model.`,
            },
        ],
    });
    persistLocal();
}

/** One CLI run (`claude -p`, `codex exec`) in `session`, with a fresh live reply. Images go to disk first so the CLI can open them. */
export function startTurn(
    session: SessionItem,
    text: string,
    images: Attachment[] = [],
    allow: string[] = [],
    preface = '',
    files: FileAttachment[] = [],
    silent?: Message,
    runGroup?: string,
    listener = false,
    report?: Pick<
        Message,
        'triggeredByMessageId' | 'taskTitle' | 'taskIds' | 'workflowRunId'
    >,
) {
    // The epoch is compared only once the saved account counts have arrived (D6): the turn waits for them, as the
    // sends behind a switch do.
    if (!accountEpochsLoaded) {
        void accountEpochsReady.then(() =>
            startTurn(
                session,
                text,
                images,
                allow,
                preface,
                files,
                silent,
                runGroup,
                listener,
                report,
            ),
        );
        return;
    }
    // D-A: a saved model that is no longer offered is not replaced by another one. Nothing starts; the chat says why.
    const offered = chatModel(session);
    if ('missing' in offered) {
        sayModelMissing(session.id, offered.missing);
        return;
    }
    // A new turn of the chat ends the "stopped by you" state: any start (a queued message, a recovery) clears it, or the
    // composer kept offering "Continue" for a request that had already moved on.
    if (!listener) delete manuallyStopped[session.id];
    const documentRequest = text.match(/^\/document(?:\s+([\s\S]*))?/i);
    if (documentRequest) {
        guide.tasks[session.id] = {
            request:
                documentRequest[1]?.trim() || 'Create the requested document',
            status: 'working',
            progress: 'Starting document task',
            result: '',
        };
        guide.open = true;
    }
    if (images.length || !allow.length) lastPrompt[session.id] = text;
    // The CLI's own id for the conversation. Claude takes one we choose; Codex names its thread on the first turn
    // and reports it, so a new Codex chat starts without one.
    const first = (session.firstAgent ??= firstAgentOf(session));
    const selectedModel = offered.model;
    rememberLastChat(
        session.agent,
        selectedModel,
        turnOptionsOf(session.id).effort as Effort,
    );
    // The chat's ledger: the turns before the one being sent (a hand-back, `silent`, has no message of its own). A
    // background lane never reads it here: its prompt carries its own digest (see `sendImmediate`).
    const chatHistory = messagesOf(session.id);
    const ledger = silent ? chatHistory : chatHistory.slice(0, -1);
    const accountGen =
        accountEpoch[credentialScope(session.agent, session.model)] ?? 0;
    // The id a new conversation gets: Claude takes one we choose (an account switch keeps the id it had per account);
    // a model change starts without one, as before; the other CLIs name their own.
    const mint = (reason?: Reason) =>
        session.agent !== 'claude' || reason === 'model'
            ? ''
            : reason === 'account' && session.agent === first
              ? accountConversationId(session.id, accountGen)
              : crypto.randomUUID();
    const view: ChatBindings = {
        bindings: boundsOf(
            session,
            first,
            session.agent === 'claude' ? () => crypto.randomUUID() : undefined,
        ),
        ledger: ledger.map((message) => ({
            agent:
                message.role === 'assistant'
                    ? (message.agent ?? session.source ?? session.agent)
                    : undefined,
        })),
    };
    const resolved = resolveBinding(view, {
        agent: session.agent,
        model: selectedModel ?? undefined,
        epoch: accountGen,
        listener,
        edited: !listener && pendingNew.delete(session.id),
        liveModel: liveModel(session.agent),
        mint,
    });
    const { binding, catchUp, reason } = resolved;
    const cliId = binding.id || null;
    const resume = !listener && resolved.resume;
    /** The conversation so far was put in `forkContext` for a new session (model or account change, an edit). */
    let digested = false;
    const conversationChanged = !listener && reason !== undefined;
    if (!listener) {
        // The conversations this turn ends are cleared (an edit ends every one of them).
        for (const agent of resolved.closed) {
            const old = view.bindings[agent];
            if (agent !== session.agent && old)
                writeBound(session, first, agent, {
                    ...old,
                    id: '',
                    started: false,
                    syncedSeq: 0,
                });
        }
        if (reason === 'model' || reason === 'account') {
            // Keep the old transcript attached to this AgentDeck chat, but never offer its id to the new conversation.
            rememberMixed(session);
            session.forkContext =
                (session.forkContext ?? '') +
                handoffDigest(
                    messagesOf(session.id),
                    reason === 'model' ? MODEL_LEAD : undefined,
                );
            digested = true;
        }
        // An edit: `editMessage` already put the ledger that is left into `forkContext`.
        if (reason === 'edit') digested = true;
        writeBound(session, first, session.agent, binding);
        if (reason === 'model' || reason === 'account') rememberMixed(session);
    }
    // A turn still marked live is replaced by this one: its events are ignored from now on (see `turns`), so it would
    // show "Thinking" for ever. It ends here, with what it wrote.
    const previous = listener ? undefined : liveReplies[session.id];
    if (previous?.live) {
        previous.live = false;
        if (previous.startedAt) previous.ms = Date.now() - previous.startedAt;
    }
    // Plan 6.3, trigger 1: a message sent to the side run while the chat's main run works is told to that run first.
    if (listener && text.trim() && text !== COMPACT_COMMAND)
        void notifyRun(
            session.id,
            userAskedMeanwhileNotice(text),
            'user-meanwhile',
        );
    const turn = nextId();
    if (!listener) turns[session.id] = turn;
    logFlow(
        session.id,
        'send',
        `turn=${turn} agent=${session.agent} model=${selectedModel ?? session.model ?? '-'} resume=${resume} silent=${Boolean(silent)} worker=${isWorkerChat(session.id)}`,
    );
    if (!isWorkerChat(session.id)) prewarmFallback(session);
    const list = messagesOf(session.id);
    const asked = silent ? undefined : list.at(-1);
    // A silent turn (the hand-back) continues the finished reply that handed work out: it is one message on screen.
    const host = silent ? list.at(-1) : undefined;
    const continues =
        !report &&
        !!host &&
        host.role === 'assistant' &&
        !host.live &&
        host.agent === session.agent;
    // With pictures, the model that reads them is picked now, so the placeholder can name it while it waits.
    const pictureReader =
        images.length && automation.prehandle ? prehandleProvider() : undefined;
    const reply: Message =
        !listener && continues && host
            ? host
            : {
                  id: nextId(),
                  role: 'assistant',
                  time: clock(new SvelteDate().toISOString()),
                  at: new SvelteDate().toISOString(),
                  blocks: [],
                  live: true,
                  // Shown from here, before the CLI is started: the attachments and the command are still being read.
                  dispatching: true,
                  ...(isWorkerChat(session.id) ? { handedOff: true } : {}),
                  ...(pictureReader
                      ? {
                            dispatchingImages: {
                                count: images.length,
                                reader:
                                    modelLabel(pictureReader.model) ||
                                    pictureReader.model,
                            },
                        }
                      : {}),
                  startedAt: Date.now(),
                  intentAt: requestAt(list) ?? Date.now(),
                  agent: session.agent,
                  model: selectedModel ?? session.model,
                  ...(asked?.role === 'user' ? { replyTo: asked.id } : {}),
                  ...(runGroup ? { runGroup } : {}),
                  ...(report ? { ...report, autoTurn: true } : {}),
              };
    if (continues && host) {
        if (runGroup) host.runGroup = runGroup;
        host.live = true;
        host.startedAt = Date.now() - (host.ms ?? 0);
        host.callOutput = 0;
    }
    reply.credentialId = currentCredentialId(
        session.agent,
        parseCustomModel(selectedModel ?? session.model)?.providerId,
    );
    // A silent turn (the hand-back) has no message of its own: its reply simply follows the message that handed work out.
    const context = listener
        ? preface
        : // The whole conversation already goes with a new session (a model or account change): the turns of the other agents
          // are in it, so they are not added a second time.
          preface +
          (session.forkContext ?? '') +
          (digested ? '' : missedTurns(session, ledger, catchUp));
    if (!listener) session.forkContext = undefined;
    // The line that says a session was resumed, compacted or replaced goes above the user's message that starts it (or
    // above the reply, for the compaction, which has no message of the user). A silent turn has none.
    const mark = silent
        ? undefined
        : sessionMark({
              resume,
              changed: conversationChanged,
              compacting: text === COMPACT_COMMAND,
              firstThisRun: !touchedThisRun.has(session.id),
              hasHistory: list.some(
                  (message) => message !== asked && message !== reply,
              ),
              now: new SvelteDate(),
          });
    touchedThisRun.add(session.id);
    if (!continues) list.push(reply);
    if (mark)
        (asked?.role === 'user' ? asked : list[list.length - 1]).mark = mark;
    if (!listener) liveReplies[session.id] = list[list.length - 1]; // the stored (reactive) object
    if (!listener && asked?.role === 'user') liveAsks[session.id] = asked;
    if (!listener && silent) {
        liveHandouts[session.id] = silent;
        delete liveAsks[session.id];
    } else if (!listener) delete liveHandouts[session.id];
    if (!listener) replies[session.id] = reply.id;
    runReplies.set(turn, {
        sessionId: session.id,
        reply: list[list.length - 1],
        listener,
        ask: asked?.role === 'user' ? asked : undefined,
        backgroundTools: new SvelteSet(),
    });
    updateLane(session.id, {
        id: turn,
        role: listener ? 'listener' : 'primary',
        state: 'running',
        backgroundWork: false,
    });
    session.status = 'working';
    // A turn that never says anything (a CLI that hangs while starting) is watched from its start.
    lastEventAt.set(session.id, Date.now());
    lastEventKind.set(session.id, 'start');
    const epoch = (runEpochs[session.id] = (runEpochs[session.id] ?? 0) + 1);
    advanceRun(session.id, { type: 'spawn', epoch });
    advanceRun(session.id, { type: 'turnStarted', epoch });
    const cwd = sessionCwd(session);
    void (async () => {
        // Nothing before the CLI starts may wait for ever: a call that never answers would leave the chat on "Thinking" with
        // no event to end it.
        const paths = await within(
            Promise.all(
                images.map((image) =>
                    image.path
                        ? image.path
                        : saveAttachment(
                              image.mime,
                              image.src.slice(image.src.indexOf(',') + 1),
                          ),
                ),
            ),
            PREPARE_LIMIT_MS,
            'saving the attached pictures',
        );
        // A message that starts with `/name` is a command: its text goes to the agent, the chat keeps what was typed.
        const body = isWorkerChat(session.id)
            ? text
            : await within(
                  expandSlash(text, session.agent, cwd),
                  PREPARE_LIMIT_MS,
                  'reading the command',
                  () => text,
              );
        // Stop/Send now can happen while attachments or a slash command are being prepared. Never start that old run.
        if (!runReplies.has(turn)) return;
        let dispatchBody = body;
        let dispatchPaths = paths;
        if (automation.prehandle && (paths.length || files.length)) {
            const selected = prehandleProvider();
            if (selected) {
                logFlow(
                    session.id,
                    'attachment pre-handle started',
                    `provider=${selected.label} model=${selected.model} images=${paths.length} files=${files.length}`,
                );
                try {
                    const request = {
                        model: selected.model,
                        effort: selected.effort,
                        prompt: body,
                        images: paths,
                        files: files.map((file) => file.path),
                    };
                    // A CLI start (OpenCode, Antigravity) takes longer than an HTTP call, so it gets the CLI's own limit.
                    const memo = await within(
                        selected.via === 'http'
                            ? prehandleAttachments({
                                  ...request,
                                  kind: selected.kind,
                                  baseUrl: selected.baseUrl,
                                  apiKey: selected.apiKey,
                              })
                            : selected.via === 'opencode'
                              ? prehandleOpencode({
                                    model: request.model,
                                    prompt: request.prompt,
                                    images: request.images,
                                    files: request.files,
                                })
                              : prehandleAntigravity(request),
                        selected.via === 'http'
                            ? PREPARE_LIMIT_MS
                            : CLI_PREPARE_LIMIT_MS,
                        'preparing attachment notes',
                    );
                    if (memo.trim()) {
                        dispatchBody = `${body}\n\n[Attachment pre-handle memo]\n${memo.trim()}`;
                        dispatchPaths = [];
                        logFlow(
                            session.id,
                            'attachment pre-handle completed',
                            `model=${selected.model} memo=${memo.trim().length} chars`,
                        );
                    }
                } catch (error) {
                    logFlow(
                        session.id,
                        'attachment pre-handle failed',
                        String(error).slice(0, 300),
                    );
                    prehandleFailed.set(pickKey(selected), Date.now());
                    logError(
                        'turn',
                        'attachment pre-handle failed; sending original attachments',
                        error,
                    );
                }
                // The reading is over (memo, or back to the main agent): the placeholder stops naming a reader.
                reply.dispatchingImages = undefined;
            } else {
                logFlow(
                    session.id,
                    'attachment pre-handle skipped',
                    'no model picked for the image role: the main agent reads the pictures',
                );
            }
        }
        if (session.agent === 'custom') {
            // A custom provider has no CLI to keep the conversation: the whole chat goes along with every turn.
            const target = parseCustomModel(selectedModel);
            const provider = connectors.custom.find(
                (item) => item.id === target?.providerId,
            );
            if (!target || !provider)
                throw new Error(
                    'This provider was removed or turned off. Pick another model.',
                );
            const spoken = (message: Message) =>
                message.blocks
                    .flatMap((block) =>
                        block.kind === 'response' ? [block.text] : [],
                    )
                    .join('\n')
                    .trim();
            const history = list
                .slice(0, silent ? -1 : -2)
                .filter((message) => !hiddenPrompt(message))
                // A free-tier provider only gets what the user wrote and what restricted providers answered: the other agents'
                // replies are about the project, and carry its code.
                .filter(
                    (message) =>
                        !provider.restricted ||
                        message.role === 'user' ||
                        customProviderOf(message.model)?.restricted,
                )
                .map((message) => ({
                    role: message.role,
                    content: spoken(message),
                }))
                .filter((message) => message.content);
            const pictureSources = dispatchPaths.length
                ? await within(
                      Promise.all(images.map((image) => pictureData(image))),
                      PREPARE_LIMIT_MS,
                      'reading the pictures',
                      () => [] as string[],
                  )
                : [];
            if (!runReplies.has(turn)) return;
            // Like the CLI path: a start that never answers ends in an error the chat shows, not in "Thinking" for good.
            await within(
                sendCustomTurn({
                    session: session.id,
                    turn,
                    messageId: asked?.role === 'user' ? asked.id : undefined,
                    kind: provider.kind,
                    baseUrl: provider.baseUrl,
                    apiKey: activeProviderKey(provider)?.apiKey || null,
                    keyEnv: providerKeyEnv(provider) || null,
                    model: target.model,
                    messages: [
                        ...history,
                        {
                            role: 'user',
                            // The preface (instructions of a flow, a worker, a hand-back) goes with the message, as on the CLI
                            // path. The digest (`forkContext`) is not sent: the history above already holds every turn.
                            content: preface
                                ? `${preface}\n\n${dispatchBody}`
                                : dispatchBody,
                            images: pictureSources,
                            files: files.map((file) => file.path),
                        },
                    ],
                    permissionMode:
                        PERMISSION_MODE[turnOptionsOf(session.id).permission],
                    allowedTools: [
                        ...new SvelteSet([
                            ...(approved[session.id] ?? []),
                            ...allow,
                        ]),
                    ],
                    cwd: provider.restricted ? null : cwd,
                    effort: effortFor(session),
                    restricted: Boolean(provider.restricted),
                    workbuddy: Boolean(provider.workbuddy),
                    authMode: provider.nativeAuth,
                }),
                PREPARE_LIMIT_MS,
                'starting the provider',
            );
            return;
        }
        // A flow's step is not told it may open pages: it reports back, the user did not ask to see anything.
        // Agents told about the Preview in their system prompt are not told again in every message that says "run" or "open".
        const openHint =
            !isWorkerChat(session.id) &&
            !KNOWS_PREVIEW.has(session.agent) &&
            OPEN_WORDS.test(dispatchBody)
                ? AGENTDECK_HINT
                : '';
        // How to delegate (DELEGATE_HINT): said when the conversation starts, and once for a chat this app never told (an
        // imported one), not with every turn: the agent keeps it in its history. Sub chats do not delegate.
        const hintKey = `${session.id}|${session.agent}`;
        // Auto-orchestrate (model popover): when it is off, the agent is told once not to hand work out by itself; when it
        // is switched on again, the delegation note is given again.
        const told = orchestrateTold.get(hintKey);
        // No AgentDeck bridge in this chat's CLI: antigravity until its link is set, and the agents in NO_DELEGATE_TOOLS.
        // (Custom providers returned above and never reach this point.)
        const noBridge =
            session.agent === 'antigravity' && !mcp.overview?.agy_link;
        const delegatable = !NO_DELEGATE_TOOLS.has(session.agent) && !noBridge;
        const orchestrate = automation.orchestrate && delegatable;
        const nativeDelegation = NATIVE_DELEGATION.has(session.agent);
        // Claude and Codex get their own note (native sub-agents first, AgentDeck for other providers) when the
        // conversation starts, so they also hand work across providers without being asked.
        const delegateHint =
            isWorkerChat(session.id) || !delegatable
                ? ''
                : orchestrate
                  ? nativeDelegation
                      ? !resume ||
                        !nativeDelegationHinted.has(hintKey) ||
                        told === false
                          ? NATIVE_DELEGATION_HINT
                          : ''
                      : !resume ||
                          !delegateHinted.has(hintKey) ||
                          told === false
                        ? DELEGATE_HINT
                        : ''
                  : told !== false
                    ? NO_DELEGATE_HINT
                    : '';
        // Task routing (Settings > Task roles) hands work to other agents, so it follows auto-orchestrate: off, nothing is routed.
        const routing =
            !isWorkerChat(session.id) && orchestrate
                ? taskRoleHint(taskRoles, routeLabel)
                : '';
        // Later turns: a short reminder for nontrivial prompts only (not twice in a row for a short one, and not with inline
        // @ai mentions, which already carry delegation instructions). Claude and Codex only get it when a task role routes
        // work to another agent: otherwise their native sub-agents cover it.
        let reminder = '';
        if (
            orchestrate &&
            (!nativeDelegation || routing) &&
            !isWorkerChat(session.id) &&
            !delegateHint &&
            !preface.includes('inline sub-agent requests')
        ) {
            const kinds = /Project "[^"]*" is at /.test(preface)
                ? [{ kind: 'project' }]
                : [];
            if (
                looksNontrivial(text, kinds) &&
                !(reminded.get(hintKey) && !isLongPrompt(text))
            )
                reminder = DELEGATE_REMINDER;
        }
        if (!isWorkerChat(session.id)) reminded.set(hintKey, Boolean(reminder));
        if (!isWorkerChat(session.id))
            orchestrateTold.set(hintKey, orchestrate);
        if (delegateHint === DELEGATE_HINT) rememberDelegateHint(hintKey);
        else if (delegateHint === NATIVE_DELEGATION_HINT)
            rememberNativeDelegationHint(hintKey);
        // The reply conventions (house-style.ts): only when the conversation starts, the agent keeps them in its history.
        const styleHint =
            !resume && !isWorkerChat(session.id)
                ? houseStyleHint(
                      replyStyle.houseStyle,
                      replyStyle.houseStyleText,
                  )
                : '';
        // The project's memory (project-memory.ts): read from its file when a conversation starts, so every agent of the
        // project begins with what earlier ones learned.
        const memoryNote =
            !resume &&
            !isWorkerChat(session.id) &&
            cwd &&
            replyStyle.projectMemory
                ? memoryHint(
                      true,
                      cwd,
                      await within(
                          readProjectMemory(cwd),
                          PREPARE_LIMIT_MS,
                          "reading the project's memory",
                          () => '',
                      ),
                  )
                : '';
        if (!runReplies.has(turn)) return;
        // The user's way of talking (user-profile.ts): learnt quietly from each prompt of a main chat, and told to the agent
        // when a conversation starts. Workers keep their own language rule.
        const mainChat = !isWorkerChat(session.id) && asked?.role === 'user';
        if (mainChat && replyStyle.userProfile) learnFromPrompt(text);
        const profileNote =
            !resume && mainChat && replyStyle.userProfile
                ? profileHint(loadProfile())
                : '';
        const hint = agentdeckLead(
            openHint,
            delegateHint,
            reminder,
            styleHint,
            memoryNote,
            profileNote,
            routing,
            LANGUAGE_RULE,
        );
        // Pictures and documents are on disk: the prompt names their paths, which the agent opens with its own tools.
        const attached =
            (dispatchPaths.length
                ? `Attached image${dispatchPaths.length > 1 ? 's' : ''} (open with the Read tool):\n${dispatchPaths.map((path) => `- ${path}`).join('\n')}`
                : '') +
            (files.length
                ? `${dispatchPaths.length ? '\n\n' : ''}Attached file${files.length > 1 ? 's' : ''} (open with the Read tool or a shell command):\n${files.map((file) => `- ${file.path}${file.note ? ` (${file.note})` : ''}`).join('\n')}`
                : '');
        // Notices from other runs (a file they changed, a worker's changes) come first, once, as the chat's next prompt (plan 6.2).
        const notices = listener ? '' : takeNoticeBlock(session.id);
        // `/compact` (auto-compress) goes as it is: anything before it would make it a plain message.
        const prompt =
            text === COMPACT_COMMAND
                ? text
                : notices +
                  hint +
                  context +
                  (attached
                      ? `${
                            dispatchBody ||
                            (files.length && !dispatchPaths.length
                                ? 'Read the attached file. If this conversation shows that the user is returning a task prompt you just drafted or explicitly asked them to run, carry it out within that prompt’s scope instead of only summarizing it. Otherwise, treat the file as context and ask what they want done if the intent is unclear.'
                                : 'Look at the attached image.')
                        }\n\n${attached}`
                      : dispatchBody);
        logRequest(
            session.id,
            session.title,
            workspace.projects.find(
                (project) => project.id === session.projectId,
            )?.name ?? '',
            agentLabel(session.agent, selectedModel ?? undefined),
            selectedModel,
            [
                `Effort: ${turnOptionsOf(session.id).effort}`,
                `Permission: ${turnOptionsOf(session.id).permission}`,
                `Conversation: ${resume ? `continues ${cliId}` : cliId ? `new (${cliId})` : 'new'}`,
                `Folder: ${cwd ?? 'none'}`,
                `Message: ${prompt.length} characters${images.length ? `, ${images.length} picture(s)` : ''}${files.length ? `, ${files.length} file(s)` : ''}`,
            ].join('\n'),
            session.agent,
            turn,
        );
        await within(
            sendAgentTurn({
                session: session.id,
                turn,
                messageId: asked?.role === 'user' ? asked.id : undefined,
                agent: session.agent,
                prompt,
                keepOpen: !listener && !isWorkerChat(session.id),
                agentSession: cliId,
                resume,
                // A model of another agent (left over from a switch) is never sent: the agent's own first model goes instead.
                model: selectedModel,
                permissionMode:
                    PERMISSION_MODE[turnOptionsOf(session.id).permission],
                effort: effortFor(session),
                allowedTools: [
                    ...new SvelteSet([
                        ...(approved[session.id] ?? []),
                        ...allow,
                    ]),
                ],
                cwd,
            }),
            PREPARE_LIMIT_MS,
            'starting the agent',
        );
    })().catch((error: unknown) => {
        // A start that timed out may still come up late: stop it, or its CLI runs next to the retry on the same conversation.
        if (/^Error: Timed out after .* starting the /.test(String(error)))
            void stopAgentTurn(session.id, turn).catch(() => undefined);
        handleAgentEvent(
            session.id,
            { kind: 'error', message: String(error) },
            turn,
        );
    });
}

/**
 * The user's answer to an approval card. "Allow" and "Always allow" let the CLI run the refused tools and
 * continue the work in a new turn; "Deny" just closes the card.
 */
export function answerPermission(
    messageId: string,
    blockIndex: number,
    answer: 'once' | 'always' | 'deny',
) {
    const session = activeSession();
    const block = chat.messages.find((message) => message.id === messageId)
        ?.blocks[blockIndex];
    // A Copilot turn is still running while its card waits: the answer goes to the SDK request, not to a new turn.
    const waiting = session?.agent === 'copilot';
    if (
        !session ||
        block?.kind !== 'permission' ||
        block.state !== 'pending' ||
        (!waiting && replies[session.id])
    )
        return;
    for (let index = 0; index < block.requests.length; index++)
        advanceRun(session.id, { type: 'waitEnd', kind: 'approval' });
    const entries = block.requests.map((request) => request.allow);
    if (answer === 'always') {
        approved[session.id] = [
            ...new SvelteSet([...(approved[session.id] ?? []), ...entries]),
        ];
        setPref('permissions.allowed', JSON.parse(JSON.stringify(approved)));
    }
    if (waiting) {
        // The card shows the answer at once; if the SDK no longer waits for it (the turn was gone), it says so instead.
        block.state = answer === 'deny' ? 'denied' : 'allowed';
        settleKeptPermission(session.id, messageId, blockIndex, block.state);
        persistLocal();
        void Promise.all(
            block.requests.map((request) =>
                answerCopilotPermission(request.id, answer !== 'deny'),
            ),
        ).catch(() => {
            block.state = 'expired';
            settleKeptPermission(session.id, messageId, blockIndex, 'expired');
            persistLocal();
        });
        if (answer === 'deny') sendNextQueued(session.id);
        return;
    }
    if (answer === 'deny') {
        block.state = 'denied';
        settleKeptPermission(session.id, messageId, blockIndex, 'denied');
        persistLocal();
        // A worker's task waits on this card: a "no" ends it instead of leaving it hanging until its time limit.
        answerWorkerApproval(session.id, false);
        sendNextQueued(session.id);
        return;
    }
    block.state = 'allowed';
    settleKeptPermission(session.id, messageId, blockIndex, 'allowed');
    persistLocal();
    answerWorkerApproval(session.id, true);
    startTurn(
        session,
        'Permission granted. Please continue with what you were doing.',
        [],
        entries,
    );
}

/** Adds the typed message to the open session. The first message turns a draft into a real session. */
/** The assistant message each live turn is writing into, per session. */
export const replies = $state<Record<string, string>>({});
/** The reply object of each running turn. */
export const liveReplies: Record<string, Message> = {};
/** Every live provider run owns its reply by turn id; primary aliases above remain for legacy queue/status UI. */
export const runReplies = new SvelteMap<
    string,
    {
        sessionId: string;
        reply: Message;
        listener: boolean;
        ask?: Message;
        backgroundTools: Set<string>;
    }
>();
export const sessionLanes = $state<Record<string, RunLane[]>>({});

type QueuePump = {
    scheduled: boolean;
    dispatching: boolean;
    retry?: ReturnType<typeof setTimeout>;
};

const queuePumps = new SvelteMap<string, QueuePump>();
const QUEUE_RETRY_MS = 1000;

function queuePumpOf(sessionId: string): QueuePump {
    const current = queuePumps.get(sessionId);
    if (current) return current;
    const created: QueuePump = { scheduled: false, dispatching: false };
    queuePumps.set(sessionId, created);
    return created;
}

/** Coalesces all queue wake-ups for a chat and gives blocked queues a bounded heartbeat. */
function requestQueuePump(sessionId: string, delay = 0) {
    const pump = queuePumpOf(sessionId);
    if (pump.scheduled) return;
    pump.scheduled = true;
    const run = () => {
        pump.scheduled = false;
        pump.retry = undefined;
        sendNextQueuedNow(sessionId, pump);
    };
    if (delay > 0) pump.retry = setTimeout(run, delay);
    else setTimeout(run, 0);
}

/** A terminal event can arrive after its lane was already removed; stale lanes must not block the next prompt. */
function clearStaleLanes(sessionId: string) {
    const lanes = sessionLanes[sessionId] ?? [];
    if (!lanes.length) return;
    const owned = new Set(
        [...runReplies.entries()]
            .filter(([, run]) => run.sessionId === sessionId)
            .map(([turn]) => turn),
    );
    const next = lanes.filter((lane) => owned.has(lane.id));
    if (next.length === lanes.length) return;
    sessionLanes[sessionId] = next;
    logFlow(
        sessionId,
        'queue',
        `cleared ${lanes.length - next.length} stale lane(s)`,
    );
}

function clearStalePrimaryReply(sessionId: string) {
    if (!replies[sessionId]) return;
    const primaryOwned = [...runReplies.values()].some(
        (run) => run.sessionId === sessionId && !run.listener,
    );
    if (primaryOwned) return;
    const reply = liveReplies[sessionId];
    if (reply?.live) reply.live = false;
    delete replies[sessionId];
    delete liveReplies[sessionId];
    delete liveAsks[sessionId];
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (session && (sessionLanes[sessionId]?.length ?? 0) === 0)
        session.status = 'idle';
    logFlow(
        sessionId,
        'queue',
        'cleared stale primary reply without an owned run',
    );
}

export function updateLane(sessionId: string, lane: RunLane) {
    const lanes = sessionLanes[sessionId] ?? [];
    // Every streamed delta reports its lane again: an unchanged lane is left as it is, so the whole list is not rebuilt
    // (and every reader of it woken) a hundred times per answer.
    const same = lanes.find((item) => item.id === lane.id);
    if (
        same &&
        same.role === lane.role &&
        same.state === lane.state &&
        same.backgroundWork === lane.backgroundWork &&
        lane.state !== 'done' &&
        lane.state !== 'failed' &&
        lane.state !== 'stopped'
    )
        return;
    const next = lanes.filter((item) => item.id !== lane.id);
    if (
        lane.state === 'done' ||
        lane.state === 'failed' ||
        lane.state === 'stopped'
    ) {
        sessionLanes[sessionId] = next;
        requestQueuePump(sessionId);
    } else {
        sessionLanes[sessionId] = [...next, lane];
    }
}

/** Only Claude takes a message between two answers (its warm process, see adapters `tail`). Any other CLI would start
 *  a new turn for it and stop the one running, so its messages wait in the queue until the turn ends. */
export function canListenToSession(sessionId: string): boolean {
    const agent = workspace.sessions.find(
        (item) => item.id === sessionId,
    )?.agent;
    return (
        agent === 'claude' &&
        deliveryFor(sessionLanes[sessionId] ?? []) === 'listener'
    );
}
/** Groups a live reply with follow-ups sent before the whole queue goes idle. */
export function continueCurrentRun(sessionId: string): string {
    const group =
        continuationGroups[sessionId] ??
        liveReplies[sessionId]?.runGroup ??
        nextId();
    continuationGroups[sessionId] = group;
    const current = liveReplies[sessionId] ?? messagesOf(sessionId).at(-1);
    if (current?.role === 'assistant') current.runGroup = group;
    return group;
}
/** The message that started each running turn. Reactive, so the Tasks panel can show the prompt while the reply runs. */
export const liveAsks = $state<Record<string, Message>>({});
/** For a running hand-back turn (it has no message of its own): the message whose delegate cards it answers. */
export const liveHandouts: Record<string, Message> = {};
/** For a hand-back that answers no message (a background task's report): its reply just follows the chat's last message. */
export const NO_HANDOUT: Message = {
    id: 'no-handout',
    role: 'user',
    time: '',
    blocks: [],
};

export const askText = (message: Message) =>
    message.blocks
        .filter((block) => block.kind === 'response')
        .map((block) => block.text)
        .join('\n')
        .trim();

/**
 * A chat opened again while its reply is still being written: what was loaded (a saved copy, or the file as the CLI
 * has written it so far) does not hold the running turn, or holds only part of it. The live question and reply go
 * on the end, in place of any copy of that question, so the text keeps growing where the reader left it.
 */
function withPrimaryLive(sessionId: string, list: Message[]): Message[] {
    const reply = liveReplies[sessionId];
    const handout = liveHandouts[sessionId];
    if (reply && handout === NO_HANDOUT)
        return list.includes(reply) ? list : [...list, reply];
    if (reply && handout && !list.includes(reply)) {
        // The file may already hold part of the reply, behind the message that handed work out: that is replaced by the live one.
        const at = list.findLastIndex((message) => message.id === handout.id);
        return at >= 0
            ? [...list.slice(0, at), handout, reply]
            : [...list, handout, reply];
    }
    const asked = liveAsks[sessionId];
    if (!reply || !asked || list.includes(reply)) return list;
    const want = askText(asked);
    let cut = list.length;
    // Only the last few can be this turn: an older message with the same words is another turn.
    for (
        let index = list.length - 1;
        index >= Math.max(0, list.length - 3);
        index--
    ) {
        if (list[index].role === 'user' && askText(list[index]) === want) {
            cut = index;
            break;
        }
    }
    return [...list.slice(0, cut), asked, reply];
}

/** Reattaches every live lane after transcript loading, including independent replies beside background work. */
export function withLive(sessionId: string, list: Message[]): Message[] {
    const visible = withPrimaryLive(sessionId, list);
    const next = [...visible];
    for (const run of runReplies.values()) {
        if (run.sessionId !== sessionId || !run.listener) continue;
        if (run.ask && !next.some((message) => message.id === run.ask!.id))
            next.push(run.ask);
        if (!next.some((message) => message.id === run.reply.id))
            next.push(run.reply);
    }
    return next;
}

/** Messages of a session: its own list (see `messagesById`), whichever chat is open. */
export function messagesOf(sessionId: string): Message[] {
    if (sessionId === workspace.activeId && chat.messages === mockMessages)
        setMessages(sessionId, [...mockMessages]);
    let list = messagesById.get(sessionId);
    if (!list) {
        list = localMessages[sessionId] ??= [];
        messagesById.set(sessionId, list);
    }
    return list;
}

/** Read-only view of a chat's messages, safe inside `$derived` and templates: it never creates or stores a list
 *  (`messagesOf` does, and writing state while a derived is computed is an error). */
export function messagesView(sessionId: string): Message[] {
    return messagesById.get(sessionId) ?? localMessages[sessionId] ?? [];
}

/** What the latest user turn still waits for: a permission request, or questions the agent asked. */
export function pendingInput(
    sessionId: string,
): 'permission' | 'question' | null {
    const list = messagesView(sessionId);
    const messages =
        liveReplies[sessionId] && !list.includes(liveReplies[sessionId])
            ? [...list, liveReplies[sessionId]]
            : list;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role === 'user') return null;
        // The user cancelled what this reply ended with: nothing waits on it.
        if (message.cancelled) return null;
        if (
            message.blocks.some(
                (block) =>
                    block.kind === 'permission' && block.state === 'pending',
            )
        )
            return 'permission';
        if (
            message.blocks.some(
                (block) =>
                    block.kind === 'response' &&
                    parseQuestions(block.text).questions.length > 0,
            )
        )
            return 'question';
    }
    return null;
}

/** A queued task must wait while the latest user turn still has a question or permission request to resolve. */
export const needsUserInput = (sessionId: string): boolean =>
    pendingInput(sessionId) !== null;

/** Told to the agent with a message that was written instead of answering its questions. What a skipped question means
 *  depends on its kind: an ordinary one is a preference the agent may settle itself; one marked `required` is not. */
export const SKIPPED_QUESTIONS =
    'The user did not answer your questions and wrote this instead. Treat it as their answer; for anything it leaves open, use your best judgement and say what you assumed. Do not ask the same questions again unless you still cannot go on without them.';
export const SKIPPED_REQUIRED =
    'The user did not answer the questions you marked required and wrote this instead. Do not guess those answers and do not do the work that depends on them: answer what they wrote, then ask again only what is still missing.';

/** The questions the latest user turn left open (the ones of the newest reply that has any). */
export function openQuestions(sessionId: string): Question[] {
    const list = messagesView(sessionId);
    for (let index = list.length - 1; index >= 0; index--) {
        const message = list[index];
        if (message.role === 'user') return [];
        for (const block of message.blocks) {
            if (block.kind !== 'response') continue;
            const questions = parseQuestions(block.text).questions;
            if (questions.length) return questions;
        }
    }
    return [];
}
/** How the session's model is reached for a one-shot JSON repair: `custom` carries the provider's address and key, the CLI
 *  providers just their name. Null for a provider that has no supported one-shot path (the deterministic text is kept). */
function repairRoute(
    reply: Message,
    session: { agent: string; model?: string },
): {
    provider: string | null;
    model: string;
    custom?: {
        kind: string;
        baseUrl: string;
        apiKey: string | null;
        keyEnv: string | null;
    };
} | null {
    const agent = (reply.agent ?? session.agent) as string;
    const model = reply.model ?? session.model ?? '';
    const target = parseCustomModel(model);
    const provider = target
        ? connectors.custom.find((item) => item.id === target.providerId)
        : undefined;
    if (agent === 'custom' || provider) {
        if (!provider || !target) return null;
        return {
            provider: 'custom',
            model: target.model,
            custom: {
                kind: provider.kind,
                baseUrl: provider.baseUrl,
                apiKey: activeProviderKey(provider)?.apiKey || null,
                keyEnv: providerKeyEnv(provider) || null,
            },
        };
    }
    if (agent === 'claude' || agent === 'opencode' || agent === 'antigravity') {
        return model ? { provider: agent, model } : null;
    }
    if (model.startsWith('claude-')) return { provider: 'claude', model };
    return null;
}

/** Ask the session's model to repair a question block whose JSON the deterministic parser could not fix. Returns the
 *  response block's index and its new text, or null when there is nothing to fix, no supported provider, the model
 *  failed, or the repair changed the wording (which `keepsWording` rejects, so wrong options never reach the card). It
 *  does not mutate the reply: the caller applies the fix once and marks it. */
export async function fetchQuestionRepair(
    reply: Message,
    session: { agent: string; model?: string; id: string },
): Promise<{ index: number; text: string } | null> {
    const index = reply.blocks.findIndex(
        (block) =>
            block.kind === 'response' &&
            unparsedQuestionBody(block.text) !== null,
    );
    if (index < 0) return null;
    const block = reply.blocks[index];
    if (block.kind !== 'response') return null;
    const body = unparsedQuestionBody(block.text);
    if (!body) return null;
    const route = repairRoute(reply, session);
    if (!route) return null;
    let repaired: string;
    try {
        repaired = (
            await repairQuestionJson({
                provider: route.provider,
                model: route.model,
                body,
                custom: route.custom,
            })
        ).trim();
    } catch (error) {
        logError('turn', 'question JSON repair failed', error, {
            chat: session.id,
        });
        return null;
    }
    if (!repaired || repaired === '{}' || !keepsWording(body, repaired))
        return null;
    return { index, text: withRepairedBody(block.text, repaired) };
}

/** Told to the agent with a message that was written instead of answering its permission request. */
export const SKIPPED_PERMISSION =
    'The user did not answer your permission request and wrote this instead. The request was cancelled: the command or tool call was NOT run and nothing it would have changed was changed. Do not assume it ran; ask again only if it is still needed.';

/** The line the chat shows once a cancelled question or request has nothing left behind it (in the style of the note for a
 *  reply the app closed on). */
const CANCEL_NOTE = '> ✕ Task cancelled. Send a message to go on.';
/** Chats where the user cancelled while messages were queued behind: those run first, the note comes after them. */
const cancelNotes = new SvelteSet<string>();

function addCancelNote(sessionId: string) {
    cancelNotes.delete(sessionId);
    const session = workspace.sessions.find((item) => item.id === sessionId);
    const list = messagesOf(sessionId);
    const last = list.at(-1);
    const lastBlock = last?.blocks.at(-1);
    if (
        last?.role === 'assistant' &&
        lastBlock?.kind === 'response' &&
        lastBlock.text === CANCEL_NOTE
    )
        return;
    list.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        time: clock(new Date().toISOString()),
        at: new Date().toISOString(),
        agent: session?.agent,
        blocks: [{ kind: 'response', text: CANCEL_NOTE }],
    });
    persistLocal();
}

/** The user cancels what the agent waits for (its questions or a permission request): nothing is sent to the agent. A
 *  message queued behind it goes out next and the chat works through the queue; when none is left, the chat says the
 *  task was cancelled. */
export function cancelPending(sessionId: string) {
    if (replies[sessionId] || !pendingInput(sessionId)) return;
    const list = messagesOf(sessionId);
    for (let index = list.length - 1; index >= 0; index--) {
        const message = list[index];
        if (message.role === 'user') break;
        if (
            message.blocks.some(
                (block) =>
                    block.kind === 'permission' && block.state === 'pending',
            )
        )
            closePendingPermissions(sessionId);
        message.cancelled = true;
    }
    persistLocal();
    if ((queued[sessionId]?.length ?? 0) > 0) {
        cancelNotes.add(sessionId);
        sendNextQueued(sessionId);
    } else addCancelNote(sessionId);
}

/** Closes the permission requests the latest user turn left unanswered, as "not answered" (what the cards say), and for a
 *  Copilot turn, which holds the request open, refuses it so that turn can end. */
export function closePendingPermissions(sessionId: string) {
    const list = messagesOf(sessionId);
    for (let index = list.length - 1; index >= 0; index--) {
        const message = list[index];
        if (message.role === 'user') break;
        for (const block of message.blocks) {
            if (block.kind !== 'permission' || block.state !== 'pending')
                continue;
            if (message.agent === 'copilot')
                for (const request of block.requests)
                    void answerCopilotPermission(request.id, false).catch(
                        () => {},
                    );
            block.state = 'expired';
        }
    }
    persistLocal();
}

/** Dispatches one queued message only after the active turn and all user decisions are complete. */
export function sendNextQueued(sessionId: string) {
    requestQueuePump(sessionId);
}

function sendNextQueuedNow(sessionId: string, pump: QueuePump) {
    const listenerAvailable = () =>
        canListenToSession(sessionId) &&
        !needsUserInput(sessionId) &&
        Boolean(queued[sessionId]?.length) &&
        !queued[sessionId][0].mentions?.some(
            (mention) => mention.kind === 'ai' || mention.kind === 'workflow',
        );
    if (pump.dispatching || queuePaused[sessionId]) return;
    if (flushCoordinationPrompt(sessionId)) return;
    if (!queued[sessionId]?.length) {
        if (backlog.get(sessionId)?.length) flushReports(sessionId);
        return;
    }
    clearStaleLanes(sessionId);
    clearStalePrimaryReply(sessionId);
    const nextIsQuestionAnswer =
        queued[sessionId]?.[0]?.questionAnswer === true;
    const canClearPendingQuestion =
        nextIsQuestionAnswer && !replies[sessionId] && !isRunning(sessionId);
    if (
        hasTurnWork(sessionId) &&
        !listenerAvailable() &&
        !canClearPendingQuestion
    ) {
        requestQueuePump(sessionId, QUEUE_RETRY_MS);
        return;
    }
    const listener = listenerAvailable();
    // A context near the window is compacted before the next message; the compaction turn calls back here when done.
    if (!listener && compressIfNeeded(sessionId)) return;
    // Claim exactly one item. Other completion/event callbacks coalesce behind this dispatch.
    const next = dequeue(queued, sessionId);
    if (!next) return;
    pump.dispatching = true;
    logFlow(
        sessionId,
        'queue',
        `sending one waiting message (${queued[sessionId]?.length ?? 0} remain)`,
    );
    try {
        if (listener) {
            sendImmediate(sessionId, next);
        } else {
            send(
                sessionId,
                next.text,
                next.images,
                next.elements,
                next.mentions,
                {
                    files: next.files,
                    runGroup: next.runGroup,
                    messageId: next.messageId,
                    questionAnswer: next.questionAnswer,
                },
            );
        }
    } catch (error) {
        enqueueNext(queued, sessionId, next);
        logFlow(
            sessionId,
            'queue',
            `dispatch failed; returned item to queue: ${String(error).slice(0, 160)}`,
        );
        requestQueuePump(sessionId, QUEUE_RETRY_MS);
    } finally {
        pump.dispatching = false;
    }
}

/** Expiry for a finished reply's presentation state when its virtual blocks are not mounted. */
export const RENDER_WAIT_LIMIT_MS = 15_000;

/** A finished reply can still be animating its final Markdown; presentation tracking does not block the queue. */
export const renderWaiters: Record<
    string,
    { messageId: string; blocks: Set<number> }
> = $state({});

/** Whether the reply is still being written out on screen (its text is not all rendered yet, see `replyBlockRendered`). */
export function replyRendering(sessionId: string, messageId: string): boolean {
    return renderWaiters[sessionId]?.messageId === messageId;
}

/** Called after a response block's final text has reached the DOM. */
export function replyBlockRendered(
    sessionId: string,
    messageId: string,
    blockIndex: number,
) {
    const waiting = renderWaiters[sessionId];
    if (!waiting || waiting.messageId !== messageId) return;
    waiting.blocks.delete(blockIndex);
    if (waiting.blocks.size) return;
    delete renderWaiters[sessionId];
    sendNextQueued(sessionId);
}

/** If the user leaves the chat before its final animation ends, let its queued work continue in the background. */
export function releaseReplyRender(sessionId: string) {
    if (!renderWaiters[sessionId]) return;
    delete renderWaiters[sessionId];
    sendNextQueued(sessionId);
}
