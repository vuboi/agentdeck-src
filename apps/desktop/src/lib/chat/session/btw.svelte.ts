import { SvelteSet } from 'svelte/reactivity';
import { workspace, localMessages, type SessionItem } from './state.svelte';
import { send } from './sending.svelte';
import { askText } from './run.svelte';
import { chatTurnOptions, stopTurn } from './turns.svelte';
import { getPref, setPref } from '../../app/platform/prefs';

export { btwQuestionOf } from './btw-command';

/** The side chat asked about this chat, if one is open. */
export const sideOf = (parentId: string) =>
    workspace.sessions.find((item) => item.side?.parentId === parentId);

/**
 * Transcripts (`claude:<session>`) of closed side chats. Claude Code keeps every session file it writes, so history
 * would import these as chats of their own. Kept as a pref so the list survives a restart.
 */
const IGNORED_PREF = 'btw.ignored';
const IGNORED_LIMIT = 200;
const ignored = new SvelteSet<string>();
export const btwIgnoredReady = getPref<string[]>(IGNORED_PREF).then(
    (saved) => {
        for (const key of saved ?? []) ignored.add(key);
    },
    () => {},
);
/** Whether a history item is the transcript of a closed side chat (its id, as history lists it). */
export const isBtwTranscript = (historyId: string) => ignored.has(historyId);

function ignoreTranscript(key: string) {
    ignored.delete(key);
    ignored.add(key);
    while (ignored.size > IGNORED_LIMIT)
        ignored.delete(ignored.values().next().value as string);
    void btwIgnoredReady.then(() => setPref(IGNORED_PREF, [...ignored]));
}

/** Closes the side chat of a chat: its run is stopped, then it is removed from the app and never saved. */
export function dropSide(parentId: string) {
    const side = sideOf(parentId);
    if (!side) return;
    stopTurn(side.id, true);
    if (side.agentSession)
        ignoreTranscript(`${side.agent}:${side.agentSession}`);
    workspace.sessions = workspace.sessions.filter(
        (item) => item.id !== side.id,
    );
    delete localMessages[side.id];
    delete chatTurnOptions[side.id];
}

const CONTEXT_CHARS = 12000;

/** The parent chat so far as text, newest last, within the budget. Turns still streaming are left out. */
export function snapshotOf(parentId: string): string {
    const lines: string[] = [];
    for (const message of localMessages[parentId] ?? []) {
        if (
            message.blocks.some(
                (block) => 'streaming' in block && block.streaming,
            )
        )
            continue;
        const text = askText(message);
        if (text)
            lines.push(
                `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`,
            );
    }
    let out = '';
    for (let index = lines.length - 1; index >= 0; index--) {
        if (out.length + lines[index].length > CONTEXT_CHARS) break;
        out = `${lines[index]}\n${out}`;
    }
    return out.trim();
}

/**
 * Asks a side question about a chat. The side chat is its own session: the parent's run is not touched,
 * nothing enters its queue, and the side chat is never listed or saved. It runs in Claude's plan mode, which
 * cannot edit files, so only a Claude chat can ask one.
 */
export function askBtw(
    parentId: string,
    question: string,
): { ok: true; side: SessionItem } | { ok: false; error: string } {
    const parent = workspace.sessions.find((item) => item.id === parentId);
    if (!parent) return { ok: false, error: 'This chat is no longer open.' };
    if (parent.agent !== 'claude')
        return {
            ok: false,
            error: '/btw is only available in Claude chats for now (it runs in read-only plan mode).',
        };
    dropSide(parentId);
    const id = crypto.randomUUID();
    chatTurnOptions[id] = {
        permission: 'plan',
        effort: chatTurnOptions[parentId]?.effort ?? 'medium',
    };
    const side: SessionItem = {
        id,
        projectId: parent.projectId,
        title: `/btw ${question.split('\n')[0].slice(0, 40)}`,
        agent: parent.agent,
        model: parent.model,
        gitBranch: parent.gitBranch,
        status: 'idle',
        draft: false,
        made: true,
        agentSession:
            parent.agent === 'claude' ? crypto.randomUUID() : undefined,
        side: { parentId, question },
    };
    workspace.sessions.push(side);
    localMessages[id] = [];
    const snapshot = snapshotOf(parentId);
    const prompt = [
        'This is a side question (/btw) about the conversation below. Answer it briefly from that context. Do not edit files, run commands that change anything, or delegate work.',
        snapshot ? `<conversation>\n${snapshot}\n</conversation>` : '',
        `Question: ${question}`,
    ]
        .filter(Boolean)
        .join('\n\n');
    send(id, prompt, [], []);
    return { ok: true, side };
}
