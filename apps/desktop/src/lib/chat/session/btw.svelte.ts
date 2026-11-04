import { SvelteSet } from 'svelte/reactivity';
import { workspace, drafts } from './state.svelte';
import { askText } from './run.svelte';
import { getPref } from '../../app/platform/prefs';
import { clock, inTauri } from '../../app/platform/history';
import { listen } from '../../app/platform/tauri-event';
import { applyAgentEvent } from '../agent-reply';
import type { AgentEvent } from '../agent';
import type { Message } from '../mock';
import { BTW_ENABLED } from './btw-command';

export { btwQuestionOf } from './btw-command';

/**
 * A side question about a chat, answered by the chat's own Claude process (the CLI's `side_question`, as Claude Code's
 * `/btw`). It is not a chat: no session, no queue, and nothing enters the chat's conversation. Its messages live here.
 */
export type SideChat = {
    parentId: string;
    /** Identity of the panel's messages (their components look them up by it); not a session. */
    session: string;
    /** The answer in progress: its events carry this id. A new answer gets a new one, so late events are dropped. */
    id: string;
    question: string;
    busy: boolean;
    /** Question and answers, in order, drawn with the chat's own message components. */
    messages: Message[];
};

/** The side question open now, if any: one at a time. */
export const btwChat = $state<{ current: SideChat | null }>({ current: null });

/** The side question of a chat, when that chat's is the one open. */
export function sideFor(parentId: string): SideChat | null {
    const current = btwChat.current;
    return current && current.parentId === parentId ? current : null;
}

/** Transcripts written by older builds (a side chat as its own session file); history keeps them out of the list. */
const IGNORED_PREF = 'btw.ignored';
const ignored = new SvelteSet<string>();
export const btwIgnoredReady = getPref<string[]>(IGNORED_PREF).then(
    (saved) => {
        for (const key of saved ?? []) ignored.add(key);
    },
    () => {},
);
/** Whether a history item is the transcript of a closed side chat (kept for transcripts written by older builds). */
export const isBtwTranscript = (historyId: string) => ignored.has(historyId);

/** Puts a side answer into the parent chat's message box, after what is already typed there. */
export function insertBtwAnswer(parentId: string, answer: string) {
    const current = drafts[parentId]?.trimEnd() ?? '';
    drafts[parentId] = current ? `${current}\n\n${answer}` : answer;
}

/** The earlier questions and answers of the open side chat, as the CLI takes them: pairs, oldest first. */
function historyOf(current: SideChat): [string, string][] {
    const pairs: [string, string][] = [];
    let question: string | null = null;
    for (const message of current.messages) {
        if (message.role === 'user') question = askText(message);
        else if (question !== null) {
            pairs.push([question, askText(message)]);
            question = null;
        }
    }
    return pairs;
}

function newMessage(role: 'user' | 'assistant', text = ''): Message {
    return {
        id: crypto.randomUUID(),
        role,
        time: clock(new Date().toISOString()),
        at: new Date().toISOString(),
        blocks: text ? [{ kind: 'response', text }] : [],
        live: role === 'assistant',
    } as Message;
}

let listening: Promise<unknown> | null = null;

/** The one listener for the side answers' events, set up on first use. */
function ensureListening() {
    listening ??= Promise.all([
        listen<{ id: string; event: AgentEvent }>(
            'btw-event',
            ({ payload }) => {
                const current = btwChat.current;
                if (!current || current.id !== payload.id) return;
                const reply = current.messages.at(-1);
                if (!reply || reply.role !== 'assistant') return;
                const update = applyAgentEvent(reply.blocks, payload.event);
                reply.blocks = update.blocks;
                if (update.finished) endAnswer(current);
            },
        ),
        listen<{ id: string }>('btw-done', ({ payload }) => {
            const current = btwChat.current;
            if (current && current.id === payload.id) endAnswer(current);
        }),
    ]);
}

/** The answer is over: the reply stops being live. */
function endAnswer(current: SideChat) {
    current.busy = false;
    const reply = current.messages.at(-1);
    if (reply) reply.live = false;
}

/** Starts one answer of a side chat, asked of the parent chat's own Claude process. */
async function startAnswer(
    parentId: string,
    question: string,
    history: [string, string][],
) {
    const current = sideFor(parentId);
    if (!current) return;
    current.id = crypto.randomUUID();
    if (!inTauri()) {
        failAnswer(current, 'Side questions run only in the desktop app.');
        return;
    }
    ensureListening();
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('btw_ask', {
            id: current.id,
            chat: parentId,
            question,
            history,
        });
    } catch (error) {
        failAnswer(current, String(error));
    }
}

function failAnswer(current: SideChat, message: string) {
    const reply = current.messages.at(-1);
    if (reply) {
        reply.blocks = [
            ...reply.blocks,
            { kind: 'response', text: `⚠ ${message}` },
        ];
        reply.live = false;
    }
    current.busy = false;
}

/**
 * Asks a side question about a chat. The answer streams into the side panel. Only Claude chats can ask one for now.
 */
export function askBtw(
    parentId: string,
    question: string,
): { ok: true } | { ok: false; error: string } {
    if (!BTW_ENABLED)
        return { ok: false, error: '/btw is turned off for now.' };
    const parent = workspace.sessions.find((item) => item.id === parentId);
    if (!parent) return { ok: false, error: 'This chat is no longer open.' };
    if (parent.agent !== 'claude')
        return {
            ok: false,
            error: `/btw is only available in Claude chats for now. This chat's agent is ${parent.agent}.`,
        };
    const text = question.trim();
    if (!text) return { ok: false, error: 'Type a question after /btw.' };
    stopBtw();
    btwChat.current = {
        parentId,
        session: crypto.randomUUID(),
        id: '',
        question: text,
        busy: true,
        messages: [newMessage('user', text), newMessage('assistant')],
    };
    void startAnswer(parentId, text, []);
    return { ok: true };
}

/** Asks the open side question of a chat a follow-up: the same side conversation, after the answer in progress. */
export function followUpBtw(parentId: string, text: string) {
    const current = sideFor(parentId);
    const question = text.trim();
    if (!current || current.busy || !question) return;
    const history = historyOf(current);
    current.messages.push(newMessage('user', question));
    current.messages.push(newMessage('assistant'));
    current.busy = true;
    void startAnswer(parentId, question, history);
}

/** Stops listening to the answer in progress. The CLI process belongs to the chat and is left alone. */
export function stopBtw() {
    const current = btwChat.current;
    if (!current || !current.busy) return;
    endAnswer(current);
    current.id = '';
}

/** Closes the side question of a chat: nothing of it is kept. */
export function dropSide(parentId: string) {
    const current = sideFor(parentId);
    if (!current) return;
    stopBtw();
    btwChat.current = null;
}
