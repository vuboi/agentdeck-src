import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { getPref, setPref } from '../../app/platform/prefs';
import { type Message } from '../mock';
import { inTauri } from '../../app/platform/history';
import { openInPreview } from '../../browser/browser.svelte';
import { pageAddress } from '../../browser/preview-address';
import { connectors } from '../../agents/connectors.svelte';
import { creditModel } from '../../agents/credit-model';
import {
    sendSystemNotification,
    requestSystemNotificationPermission,
} from '../../app/platform/system-notifications';
import { stopAgentTurn } from '../agent';
import { logFlow } from '../../tasks/flow-log';
import { applyAgentEvent, stopCallTasks } from '../agent-reply';
import {
    customProviderName,
    findModel,
    modelsReady,
    type ProviderId,
} from '../../agents/models.svelte';
import { agentDisplayName } from '../../agents/provider-registry';
import { isHandbackPrompt } from '../runs/handback';
import {
    MODELS,
    advanceRun,
    persistLocal,
    workspace,
    type Agent,
    type Attachment,
    type Effort,
    type FileAttachment,
    type Mention,
    type PageElement,
    type Permission,
    type SessionItem,
} from './state.svelte';
import {
    liveReplies,
    messagesOf,
    needsUserInput,
    replies,
    runReplies,
    sendNextQueued,
    sessionLanes,
} from './run.svelte';
import {
    cancelAutoSwitch,
    dropRecovery,
    handleAgentEvent,
    owesTurn,
    stopOwedTurn,
    userStoppedAt,
} from './events.svelte';
import { delegateRuns } from './delegation.svelte';
import {
    delegateTasks,
    isWorkerChat,
    stopDelegateTask,
    taskRuns,
} from './delegate-task.svelte';
import { clipText } from './orchestration.svelte';
import { closeRunningActivity } from '../runs/activity.svelte';

/**
 * Said to the agent when a message is about running or opening something. Agents follow the project's own notes
 * (a skill that opens the user's Chrome, a shell command that starts the server), and a server started in the agent's
 * own shell dies when the command ends, which leaves the Preview on a refused connection. These tools do not.
 */
export const AGENTDECK_HINT =
    '[AgentDeck] You run inside AgentDeck. To start a dev server or open a page, use the agentdeck tools: browser_serve (checks for and reuses an existing matching server in the same project, so repeated calls from chats or workers do not spawn duplicates; otherwise starts the server so it keeps running after your turn, and opens it in the Preview) or browser_open for an address that already answers. Then use browser_screenshot, browser_console and browser_network to look at it. Do not start servers in your own shell and do not open the system browser or Chrome: that server would stop when your command ends, and the user is looking at the AgentDeck Preview.';

/**
 * Chats (and the agent in them) already told how to delegate. Kept between runs of the app: a resumed conversation
 * still has the hint in its history, so sending it again after every restart only costs tokens.
 */
/** What each chat was last told about handing work out (auto-orchestrate on or off), this run of the app. */
export const orchestrateTold = new SvelteMap<string, boolean>();
export const NO_DELEGATE_HINT =
    'Auto-orchestration is off in AgentDeck: do the work yourself. Call delegate_task only when the user asks you to hand work to another agent.';
/** These CLIs already own and invoke their native sub-agent orchestration; AgentDeck only adds its handoff hint to other providers. */
export const NATIVE_DELEGATION = new SvelteSet<Agent>(['claude', 'codex']);
/** Agents whose CLI is not given AgentDeck's MCP bridge (crates/adapters write it for claude, codex, opencode, command-code,
 *  workbuddy; antigravity is linked in mcp_manage): delegate_task and list_agents do not exist for them, so the delegation
 *  notes and task routing are not sent to them at all. Empty while every built-in CLI has the bridge. */
export const NO_DELEGATE_TOOLS = new SvelteSet<Agent>();
export const NATIVE_DELEGATION_HINT =
    'Use your native CLI sub-agent tools for internal parallel work when useful. AgentDeck delegate_task is for handing work across providers; do not replace native sub-agents with it. Do not wait for the user to ask: for a nontrivial request, use delegate_task (wait:false) on your own when another provider clearly adds value, such as a clean-context review or security check of your diff, research, or a role routed below, and keep integration and the final answer here.';
export const delegateHinted = new SvelteSet<string>();
void getPref<string[]>('chat.delegateHinted.v2').then((saved) => {
    for (const key of saved ?? []) delegateHinted.add(key);
});
export const priorDelegateHinted = new SvelteSet<string>();
void getPref<string[]>('chat.delegateHinted').then((saved) => {
    for (const key of saved ?? []) priorDelegateHinted.add(key);
});
export const nativeDelegationHinted = new SvelteSet<string>();
void getPref<string[]>('chat.nativeDelegationHinted.v2').then((saved) => {
    for (const key of saved ?? []) nativeDelegationHinted.add(key);
});
export function rememberDelegateHint(key: string) {
    delegateHinted.add(key);
    setPref('chat.delegateHinted.v2', [...delegateHinted].slice(-500));
}
export function rememberNativeDelegationHint(key: string) {
    nativeDelegationHinted.add(key);
    setPref(
        'chat.nativeDelegationHinted.v2',
        [...nativeDelegationHinted].slice(-500),
    );
}

/** Agents whose own system prompt already says how to use the Preview (claude.rs, codex.rs, custom_chat.rs). */
export const KNOWS_PREVIEW = new SvelteSet<Agent>([
    'claude',
    'codex',
    'custom',
]);

/** The last thing asked in each chat: "open it", "run the app" decides whether a served page opens by itself. */
export const lastPrompt: Record<string, string> = {};
export const OPEN_WORDS =
    /\b(open|opened|preview|browser|run|running|start|started|serve)\b|mở|chạy|xem thử/i;

/** Pick the requested framework's address when a turn starts more than one local dev server. */
function previewUrl(text: string, prompt: string): string | undefined {
    const wantsSvelte = /\bsvelte(?:\s*5)?\b|z-ui-svelte/i.test(
        `${prompt}\n${text}`,
    );
    // A template such as `http://localhost:{port}/` that the reply quotes is not an address: pageAddress drops it.
    const urls = [
        ...text.matchAll(
            /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s`'")\]>]*/gi,
        ),
    ].flatMap((match) => {
        const url = pageAddress(match[0]);
        return url ? [{ url, at: match.index ?? 0 }] : [];
    });
    const unique = urls.filter(
        (item, index) =>
            urls.findIndex((other) => other.url === item.url) === index,
    );
    return unique
        .map((item) => {
            const lineStart = text.lastIndexOf('\n', item.at) + 1;
            const lineEnd = text.indexOf('\n', item.at);
            const line = text.slice(
                lineStart,
                lineEnd < 0 ? text.length : lineEnd,
            );
            let score = item.at;
            if (wantsSvelte) {
                if (/svelte|vite|z-ui-svelte/i.test(line)) score += 100000;
                if (/angular|4200/.test(line)) score -= 100000;
                if (/:(?:4310|4301)\b/.test(item.url)) score += 50000;
            }
            return { ...item, score };
        })
        .sort((a, b) => b.score - a.score)[0]?.url;
}

/** After a turn: if you asked to open or run something and a local address came out of it, show it in the AgentDeck browser. */
export function openServedPage(sessionId: string, reply: Message) {
    if (!inTauri()) return;
    // Background handbacks can contain a local URL from the worker's work. Do not let completion steal Preview focus
    // from the chat; explicit browser_open/browser_serve calls already opened their intended page.
    if (reply.autoTurn || reply.taskIds?.length) return;
    // A flow's steps and the turn that writes its final answer only report: an address they mention (an API a search
    // found, a URL in a README) is not a page the user asked to see, and opening it showed a refused connection.
    if (
        isWorkerChat(sessionId) ||
        delegateRuns.some((run) => run.main === sessionId && !run.endedAt)
    )
        return;
    const text = reply.blocks
        .map((block) =>
            block.kind === 'response'
                ? block.text
                : block.kind === 'command'
                  ? `${block.command}\n${block.output}`
                  : '',
        )
        .join('\n');
    const asked = OPEN_WORDS.test(lastPrompt[sessionId] ?? '');
    // You asked for it, or the answer says the page is open or running.
    if (!asked && !OPEN_WORDS.test(text)) return;
    // Without that ask, only an address a command printed (a server that was started) counts, not one the prose mentions.
    const source = asked
        ? text
        : reply.blocks
              .map((block) =>
                  block.kind === 'command'
                      ? `${block.command}\n${block.output}`
                      : '',
              )
              .join('\n');
    const found = previewUrl(source, lastPrompt[sessionId] ?? '');
    // An agent that opened the page itself (browser_open, browser_serve) has put it where it wanted: nothing to add.
    const opened = reply.blocks.some(
        (block) =>
            block.kind === 'command' &&
            /browser_(open|serve)/.test(block.command),
    );
    if (found && !opened) openInPreview(found);
}

/**
 * Words in a picked element's markup that are worth searching the project's files for: its text, ids, class names
 * and the values of its attributes. The source of a rendered element is found by what it says and is called, not by
 * its tag, so these are what a model should Grep for first.
 */
function searchHints(item: PageElement): string[] {
    const hints = new SvelteSet<string>();
    const add = (value: string | undefined | null, min = 3) => {
        const word = (value ?? '').trim();
        if (word.length >= min && word.length <= 60) hints.add(word);
    };
    add(item.text.length <= 60 ? item.text : item.text.slice(0, 40), 2);
    for (const match of item.html.matchAll(
        /\b(?:id|aria-label|title|placeholder|formcontrolname|name|data-[\w-]+|routerlink|ng-reflect-[\w-]+)="([^"]{2,60})"/gi,
    ))
        add(match[1]);
    const generic =
        /^(flex|grid|block|inline|hidden|relative|absolute|items-|justify-|gap-|p[xytblr]?-|m[xytblr]?-|w-|h-|min-|max-|text-|bg-|border|rounded|shadow|font-|size-|z-|overflow|cursor|transition|hover:|focus:|disabled:|ring|outline|opacity|sr-only|truncate|shrink|grow|self-|col-|row-|space-|divide-)/;
    for (const match of item.html.matchAll(/\bclass="([^"]*)"/gi))
        for (const name of match[1].split(/\s+/))
            if (name && !generic.test(name) && !/^\d/.test(name)) add(name, 4);
    const custom = item.html.match(/^<([a-z]+-[a-z0-9-]+)/i)?.[1];
    add(custom, 4);
    return [...hints].slice(0, 12);
}

/** The picked page elements as text the agent can use: where they are, what they look like, their markup. */
export function withElements(text: string, elements: PageElement[]): string {
    if (elements.length === 0) return text;
    const parts = elements.map((item, index) => {
        const hints = searchHints(item);
        return [
            `Element ${index + 1} on ${item.title || 'the page'} (${item.url}): \`${item.selector}\` ${item.box.w}×${item.box.h}`,
            ...(item.note ? [`Note: ${item.note}`] : []),
            `Text: ${item.text || '(none)'}`,
            `Styles: ${Object.entries(item.style)
                .map(([key, value]) => `${key}: ${value}`)
                .join('; ')}`,
            '```html',
            item.html,
            '```',
            ...(item.around
                ? ['Its place on the page:', '```', item.around, '```']
                : []),
            ...(hints.length
                ? [
                      `To find its source in the project, search the files for these (they come from this element's text, ids and classes): ${hints.map((hint) => `"${hint}"`).join(', ')}`,
                  ]
                : []),
        ].join('\n');
    });
    const guide =
        'These elements are what the request is about. Change the code that renders them, in the place they are rendered: find it by searching the project for the words listed, read the file around the match, and put the change exactly where the element sits (see "Its place on the page"), written like the markup around it. Do not add it anywhere else.';
    return `${text || 'Look at the element(s) below.'}\n\n${guide}\n\n${parts.join('\n\n')}`;
}

/** How the Composer's permission setting maps onto the CLI's `--permission-mode`; "ask" passes none. */
/**
 * The agent, model and effort of the last message the user actually sent. A new chat starts from them instead of a
 * fixed default. Opening a chat to read it never changes this: only sending does.
 */
export const lastChat = $state<
    { agent: Agent; model: string; effort: Effort } | { agent: null }
>({ agent: null });
void getPref<{ agent: Agent; model: string; effort: Effort }>(
    'composer.lastChat',
).then((saved) => {
    if (saved?.agent && saved.model) Object.assign(lastChat, saved);
});
export function rememberLastChat(
    agent: Agent,
    model: string | null,
    effort: Effort,
) {
    if (!model) return;
    const saved = { agent, model, effort };
    Object.assign(lastChat, saved);
    setPref('composer.lastChat', saved);
}

// The app's own names: each agent's adapter maps them onto its CLI (crates/adapters/src/agent/permission.rs).
export const PERMISSION_MODE: Record<Permission, string> = {
    ask: 'ask',
    edits: 'edits',
    plan: 'plan',
    auto: 'auto',
    yolo: 'yolo',
};
/** The permission setting of the Composer, read when a turn starts. */
export const turnOptions = $state<{ permission: Permission; effort: Effort }>({
    permission: 'yolo',
    effort: 'medium',
});

/**
 * The same settings per chat, written by that chat's composer. A turn that starts in the background (a queued message,
 * a recovery, a worker) reads its own chat's settings, never those of the chat that happens to be on screen.
 */
export const chatTurnOptions: Record<
    string,
    { permission: Permission; effort: Effort }
> = {};
/** Used only for a chat whose own settings are not known yet: the safest one (ask before acting, medium effort). It is
 *  never the settings of the chat on screen, which would give a background turn another chat's permission. */
const SAFE_TURN_OPTIONS: { permission: Permission; effort: Effort } = {
    permission: 'ask',
    effort: 'medium',
};
/** An agent and model picked in the picker while the chat's turn runs. They are applied when that turn ends (D3): the
 *  turn keeps the route it started with, and the picker shows that the pick applies after this turn. */
export const pendingSwitch = $state<
    Record<string, { agent: Agent; model: string }>
>({});
export const turnOptionsOf = (sessionId: string) =>
    chatTurnOptions[sessionId] ?? SAFE_TURN_OPTIONS;

/** The run of each chat that is current: events of an older (stopped) run are ignored. */
export const turns: Record<string, string> = {};

/** Messages typed while the agent was still busy, waiting their turn. */
export type Queued = {
    /** Explicit Send now request waiting for an available provider lane. */
    priority?: boolean;
    /** A reply to an already displayed question: it may clear that pending input when the active turn ends. */
    questionAnswer?: boolean;
    /** Stable transcript identity retained from enqueue until dispatch. */
    messageId?: string;
    text: string;
    images: Attachment[];
    elements: PageElement[];
    mentions?: Mention[];
    files?: FileAttachment[];
    runGroup?: string;
};
export const queued = $state<Record<string, Queued[]>>({});
/** A paused queue stays in place when a running turn ends or gets interrupted. */
export const queuePaused = $state<Record<string, 'manual' | 'interrupted'>>({});
export function pauseQueue(sessionId: string) {
    queuePaused[sessionId] = 'manual';
}
export function resumeQueue(sessionId: string) {
    if (!queuePaused[sessionId]) return;
    delete queuePaused[sessionId];
    sendNextQueued(sessionId);
}
export function clearQueue(sessionId: string) {
    delete queued[sessionId];
    delete queuePaused[sessionId];
    sendNextQueued(sessionId);
}
/** Visual group for a reply and follow-ups submitted before its work queue finishes. */
export const continuationGroups: Record<string, string> = {};

/** An agent whose account is being switched: a send to it waits, since the CLI it would start keeps the old sign-in
 *  until the switch is done (see account-epoch.svelte.ts). The sends are kept whole (prompt, preface, silent turn) and
 *  made, in order, when the switch ends. */
export const switchingAgent = (scope: string) =>
    Boolean(connectors.busy[`switch:${scope}`]);
export const afterSwitch = new SvelteMap<string, (() => void)[]>();
let switchingBefore = new Set<string>();
$effect.root(() => {
    $effect(() => {
        const now = new Set(
            Object.keys(connectors.busy)
                .filter((key) => key.startsWith('switch:'))
                .map((key) => key.slice('switch:'.length)),
        );
        for (const agent of switchingBefore) {
            if (now.has(agent)) continue;
            const waiting = afterSwitch.get(agent) ?? [];
            afterSwitch.delete(agent);
            for (const go of waiting) go();
        }
        switchingBefore = now;
    });
});

type SessionWorkBatch = { failed: boolean };
const sessionWorkBatches: Record<string, SessionWorkBatch> = {};

export function beginSessionWork(sessionId: string) {
    sessionWorkBatches[sessionId] ??= { failed: false };
}

export function failSessionWork(sessionId: string) {
    const batch = sessionWorkBatches[sessionId];
    if (batch) batch.failed = true;
}

/** Provider execution or a pending user answer blocks delivery. Drawing a finished reply must not block the queue. */
export function hasTurnWork(sessionId: string): boolean {
    if ((sessionLanes[sessionId]?.length ?? 0) > 0) return true;
    return Boolean(replies[sessionId] || needsUserInput(sessionId));
}

/** The agent of a chat's first conversation (the one its own id field, `agentSession`, belongs to). Pure. */
export function firstAgentOf(session: SessionItem): Agent {
    return (
        session.firstAgent ??
        session.source ??
        session.agents?.[0] ??
        session.agent
    );
}

/**
 * Drops a provider conversation id only when the turn that used it never received a confirmed session/rollout. The one
 * copy for every caller (Stop, Send now, retry, fallback). `failedAgent` is the agent whose turn it was (reply.agent);
 * the chat's current agent when left out.
 */
export function forgetUnstartedConversation(
    sessionId: string,
    failedAgent?: Agent,
) {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const first = firstAgentOf(session);
    const agent = failedAgent ?? session.agent;
    if (agent === first) {
        if (session.agentStarted === true) return;
        session.agentSession = undefined;
        session.agentStarted = false;
    } else if (session.agentIds?.[agent] && !session.agentIds[agent]?.started) {
        delete session.agentIds[agent];
    }
}

/** Any work of the chat is outstanding, delegated work included: used to decide the "done" notification. */
export function hasOutstandingSessionWork(sessionId: string): boolean {
    if (hasTurnWork(sessionId)) return true;
    if (delegateRuns.some((run) => run.main === sessionId && !run.endedAt))
        return true;
    if (
        [...taskRuns.keys()].some(
            (taskId) => delegateTasks[taskId]?.caller === sessionId,
        )
    )
        return true;
    return false;
}

export function notifySessionWorkDone(sessionId: string) {
    const batch = sessionWorkBatches[sessionId];
    if (!batch) return;
    delete sessionWorkBatches[sessionId];
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    // "Notify when done" opts this chat in whenever AgentDeck is in the background. Otherwise only with notifications on,
    // and not for the chat the user is looking at (the answer is in front of them, a notification would only interrupt).
    if (!notifyDone[sessionId]) {
        if (!connectors.alerts.system) return;
        if (
            typeof document !== 'undefined' &&
            document.hasFocus() &&
            workspace.activeId === sessionId
        )
            return;
    }
    const last = [...messagesOf(sessionId)]
        .reverse()
        .find((message) => message.role === 'assistant');
    const answer =
        last?.blocks
            .flatMap((block) => (block.kind === 'response' ? [block.text] : []))
            .join(' ') ?? '';
    const title = batch.failed
        ? `${session.title}: failed`
        : `${session.title}: done`;
    const body = answer.trim()
        ? clipText(answer, 180)
        : batch.failed
          ? 'At least one task failed. Nothing else is running.'
          : 'All tasks are done and nothing remains queued.';
    void sendSystemNotification(title, body);
}

/** Chats with "Notify when done" on, by id: kept apart from the chats, which may be read again from the CLIs' files. */
const notifyDone = $state<Record<string, true>>({});
void getPref<Record<string, true>>('chat.notifyDone').then((saved) => {
    if (saved) Object.assign(notifyDone, saved);
});
export const notifiesWhenDone = (sessionId: string) =>
    Boolean(notifyDone[sessionId]);

/** Turns "Notify when done" on or off for a chat (asks for the system permission the first time). */
export function toggleNotifyDone(sessionId: string) {
    if (notifyDone[sessionId]) delete notifyDone[sessionId];
    else {
        notifyDone[sessionId] = true;
        void requestSystemNotificationPermission();
    }
    setPref('chat.notifyDone', { ...notifyDone });
}

/** Whether a chat has a reply in progress (for the send / stop button). */
/** A chat whose failed turn is still owed (a retry or an account switch waits) counts as running: Stop is offered. */
export const isRunning = (sessionId: string) =>
    workspace.sessions.find((item) => item.id === sessionId)?.status ===
        'working' ||
    (sessionLanes[sessionId]?.length ?? 0) > 0 ||
    owesTurn(sessionId);

/** Stops the reply of a chat now. What was written so far stays. `quiet`: the stop is only to make room for a newer
 *  message (sent while the reply ran, an edit), not the user's Stop button: the reply does not say "You stopped after". */
/**
 * Ends the chat's background work everywhere it is shown: the Work tray (the activity log) and the chat's own task cards
 * (the sub agent and background-command rows in the transcript). Both stop paths use it, so the two views cannot disagree.
 */
export function stopChatWork(sessionId: string) {
    closeRunningActivity(sessionId);
    let changed = false;
    for (const message of messagesOf(sessionId)) {
        for (const block of message.blocks) {
            if (
                block.kind !== 'command' ||
                (block.task?.status !== 'started' &&
                    block.task?.status !== 'progress')
            )
                continue;
            // Every task of the call ends too, so a late progress from one of them cannot bring the card back.
            stopCallTasks(block);
            changed = true;
        }
    }
    if (changed) persistLocal(sessionId);
}

export function stopTurn(sessionId: string, quiet = false) {
    cancelAutoSwitch(sessionId);
    if (!quiet) userStoppedAt[sessionId] = Date.now();
    if (!quiet) forgetUnstartedConversation(sessionId);
    if (!quiet && (queued[sessionId]?.length ?? 0) > 0)
        queuePaused[sessionId] = 'interrupted';
    // A retry or an account switch that waits for a failed turn ends here: the turn is closed as stopped (A2). The queue is
    // paused above first, so closing the turn does not start a queued message.
    if (!quiet) stopOwedTurn(sessionId);
    if (!quiet) {
        const listeners = [...runReplies.entries()].filter(
            ([, run]) => run.sessionId === sessionId && run.listener,
        );
        // Prefer the user's side request. An unsolicited report must not steal Stop from the foreground conversation.
        const listener =
            listeners.findLast(([, run]) => Boolean(run.ask)) ??
            (!liveReplies[sessionId]?.live ? listeners.at(-1) : undefined);
        if (listener) {
            const [turn] = listener;
            void stopAgentTurn(sessionId, turn).catch(() => {});
            handleAgentEvent(
                sessionId,
                { kind: 'error', message: 'stopped' },
                turn,
            );
            return;
        }
    } else {
        // An explicit interrupt ends both lanes; ordinary Stop above targets the foreground listener only.
        for (const [turn, run] of [...runReplies.entries()]) {
            if (run.sessionId !== sessionId || !run.listener) continue;
            void stopAgentTurn(sessionId, turn).catch(() => {});
            handleAgentEvent(
                sessionId,
                { kind: 'error', message: 'stopped' },
                turn,
            );
        }
    }
    logFlow(
        sessionId,
        'stop',
        `turn=${turns[sessionId] ?? '-'} quiet=${quiet} live=${Boolean(liveReplies[sessionId]?.live)}`,
    );
    // The user's own Stop ends everything of this chat. An interrupt for a new message (quiet) does not: the work that
    // already runs in the background goes on, and a stop aimed at one side lane returned above.
    if (!quiet) stopChatWork(sessionId);
    // Stopped by the user: a retry or a hand-over waiting to start does not start.
    dropRecovery(sessionId);
    advanceRun(sessionId, { type: 'cancel' });
    // Delegated workers stop with the lead chat that started them.
    for (const run of delegateRuns) {
        if (run.main !== sessionId || run.endedAt) continue;
        run.cancelled = true;
        for (const node of run.nodes) {
            // Queued workers are still live task runs: stopping only the running
            // nodes leaves their slot waiter armed, so they can start after the
            // lead chat has already been stopped.
            if (node.state !== 'running' && node.state !== 'idle') continue;
            // Through its task when it has one: a worker stopped on its own handed its report back to a lead the user had just stopped.
            const task = Object.values(delegateTasks).find(
                (item) =>
                    item.childId === node.childId && taskRuns.has(item.id),
            );
            if (task) stopDelegateTask(task.id);
            else stopTurn(node.childId);
        }
    }
    if (!replies[sessionId]) {
        // Nothing is running any more but the chat still says so (a lost event): clear it, and close the reply that was
        // still open, so its thinking and text stop spinning.
        const open = liveReplies[sessionId];
        if (open?.live) {
            open.blocks = applyAgentEvent(open.blocks, {
                kind: 'error',
                message: 'stopped',
            }).blocks;
            open.live = false;
        }
        const stuck = workspace.sessions.find((item) => item.id === sessionId);
        if (stuck?.status === 'working') stuck.status = 'idle';
        // A lost `done` left the foreground lane behind: with it the chat counts as running for good, its queue stays
        // blocked and Stop did nothing. Side lanes (a hand-back, a background report) are not this chat's reply.
        if (sessionLanes[sessionId]?.some((lane) => lane.role === 'primary'))
            sessionLanes[sessionId] = sessionLanes[sessionId].filter(
                (lane) => lane.role !== 'primary',
            );
        return;
    }
    const turn = turns[sessionId];
    // Every agent and provider stops here, so every stopped reply says so, with how long it had run.
    const live = liveReplies[sessionId];
    if (live?.live && !quiet)
        live.stoppedAfter = Date.now() - (live.startedAt ?? Date.now());
    void stopAgentTurn(sessionId, turn).catch(() => {});
    handleAgentEvent(sessionId, { kind: 'error', message: 'stopped' }, turn);
}

/** Tools the user approved with "Always allow", per chat. */
export const approved: Record<string, string[]> = {};
void getPref<Record<string, string[]>>('permissions.allowed').then((saved) => {
    if (saved) Object.assign(approved, saved);
});

/**
 * The model a chat's turn runs on, from the saved one and the agent's list (pure): the saved model when the list has it,
 * the first model when none is saved, and `missing` when the saved one is no longer offered. A missing model is never
 * replaced by another one (D-A): the send is blocked instead (see startTurn).
 */
export function pickModel(
    saved: string | null | undefined,
    list: readonly { value: string }[],
): { model: string | null } | { missing: string } {
    if (!saved) return { model: list[0]?.value ?? null };
    if (list.some((item) => item.value === saved)) return { model: saved };
    return { missing: saved };
}

/** The model a chat runs on: see pickModel. Pure: the chat is not written here. */
export function chatModel(session: SessionItem): ReturnType<typeof pickModel> {
    // A Console credit model stays picked while its key is missing: the turn then stops and says so (agent.ts), instead of
    // quietly running on the plan's model. Only the user's own pick changes it.
    if (creditModel(session.model)) return { model: session.model ?? null };
    // Until the CLI's own list has been read, the catalogue is only a fallback: the saved model is trusted as it is.
    if (session.model && modelsReady[session.agent as ProviderId] === false)
        return { model: session.model };
    return pickModel(session.model, MODELS[session.agent] ?? []);
}

/** The effort a turn is sent with. A model the CLI lists without reasoning levels (Antigravity's Claude models) gets
 *  none: `agy --effort` refuses it, and the level picked for another model must not follow it. */
export function effortFor(session: SessionItem): Effort | null {
    const picked = chatModel(session);
    // A model that is no longer offered has no effort: the send is blocked (see startTurn).
    if ('missing' in picked) return null;
    const level = turnOptionsOf(session.id).effort;
    const model = picked.model;
    const known = model ? findModel(session.agent, model) : undefined;
    // Antigravity sends a level only when its own list gives this model levels: `agy` refuses --effort for the rest.
    if (session.agent === 'antigravity')
        return known?.efforts?.length ? level : null;
    return known && !known.efforts?.length ? null : level;
}

/** The model a turn runs on (see chatModel); null when the saved one is no longer offered, so callers check chatModel first. */
export function modelFor(session: SessionItem): string | null {
    const picked = chatModel(session);
    return 'model' in picked ? picked.model : null;
}

export const agentLabel = (agent?: Agent, model?: string | null) =>
    (agent === 'custom' && customProviderName(model)) ||
    (agent === 'custom'
        ? 'Custom provider'
        : agentDisplayName(agent ?? 'claude'));

/**
 * A user message that is only the hand-back prompt (or, in a chat saved by an older version, its stand-in
 * "↩ Claude answered"): it is never shown or quoted.
 */
export const hiddenPrompt = (message: Message) =>
    message.role === 'user' &&
    message.blocks.some(
        (block) =>
            block.kind === 'response' &&
            (isHandbackPrompt(block.text) ||
                /^↩ .{1,200} answered$/.test(block.text.trim())),
    );

/**
 * The turns of the chat that a conversation has not seen, as text to put before the prompt: `ledger` is the chat
 * before the message being sent, `seqs` the 1-based positions the conversation is missing (see `resolveBinding`).
 * Each agent keeps its own conversation, so one that joins (or comes back to) a chat would not know the turns it
 * missed. The newest turns are kept when it is long.
 */
export function missedTurns(
    session: SessionItem,
    ledger: Message[],
    seqs: number[],
): string {
    const writer = (message: Message) =>
        message.agent ?? session.source ?? session.agent;
    const missed = seqs.flatMap((seq) =>
        ledger[seq - 1] ? [ledger[seq - 1]] : [],
    );
    if (!missed.some((message) => message.role === 'assistant')) return '';
    const lines = missed
        .filter((message) => !hiddenPrompt(message))
        .map((message) => {
            const text = message.blocks
                .flatMap((block) =>
                    block.kind === 'response'
                        ? [block.text]
                        : block.kind === 'command'
                          ? [`(ran: ${block.command.slice(0, 160)})`]
                          : [],
                )
                .join('\n')
                .trim();
            const cut = text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
            return `${message.role === 'user' ? 'User' : agentLabel(writer(message), message.model)}: ${cut}`;
        });
    let digest = lines.join('\n\n');
    if (digest.length > 16000) digest = `…${digest.slice(-16000)}`;
    return `Earlier in this chat, other agents answered these turns (you were not part of them):\n\n${digest}\n\n---\nNow the user says:\n`;
}
