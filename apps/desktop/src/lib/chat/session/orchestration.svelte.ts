import { SvelteMap } from 'svelte/reactivity';
import { type Message } from '../mock';

/** Language guidance shared by the lead model and delegated workers. */
export const LANGUAGE_RULE =
    'Write all user-facing replies and progress updates in the language the user has been using in this conversation, even when attached files, tool output, or these notes are in another language. Keep code, paths, commands, and quoted source text unchanged.';

/** Shortens text included in a worker prompt or history card. */
export const shorten = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

/** Flattens and shortens text shown in a notification or recovery message. */
export const clipText = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Resolves a delegate_task call when its child chat finishes. */
export const taskWaiters = new SvelteMap<
    string,
    (text: string, error: string | null, reply?: Message) => void
>();

/** A hidden coordination prompt waits for the target chat's current turn to finish. */
export type SilentCoordinationPrompt = {
    prompt: string;
    silent: Message;
    preface?: string;
    report?: Pick<
        Message,
        'triggeredByMessageId' | 'taskTitle' | 'taskIds' | 'workflowRunId'
    >;
    questionId?: string;
    /** Checked when the prompt is about to start: a prompt whose target is gone is dropped, not sent. */
    deliverable?: () => boolean;
    /** A teammate's note to a running worker: its turn is not the worker's report (see teamNoteDone). */
    teamNote?: boolean;
};
const silentCoordination = new SvelteMap<string, SilentCoordinationPrompt[]>();
const activeCoordination = new SvelteMap<string, SilentCoordinationPrompt>();

export function queueCoordinationPrompt(
    sessionId: string,
    item: SilentCoordinationPrompt,
): void {
    const list = silentCoordination.get(sessionId) ?? [];
    list.push(item);
    silentCoordination.set(sessionId, list);
}

export function takeCoordinationPrompt(
    sessionId: string,
): SilentCoordinationPrompt | undefined {
    const list = silentCoordination.get(sessionId);
    const item = list?.shift();
    if (!list?.length) silentCoordination.delete(sessionId);
    return item;
}

export function hasCoordinationPrompt(sessionId: string): boolean {
    return (silentCoordination.get(sessionId)?.length ?? 0) > 0;
}

export function startCoordinationPrompt(
    sessionId: string,
    item: SilentCoordinationPrompt,
): void {
    activeCoordination.set(sessionId, item);
}

export function finishCoordinationPrompt(
    sessionId: string,
): SilentCoordinationPrompt | undefined {
    const item = activeCoordination.get(sessionId);
    activeCoordination.delete(sessionId);
    return item;
}

/** Sends an answer to a question asked by an agent in its chat. */
