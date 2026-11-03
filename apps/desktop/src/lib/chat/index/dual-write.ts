// The dual write to the chat ledger (`chats.db`, see `ag_adapters::chat_index`). While the flag `chat_index.dual_write`
// is on, every chat change is also sent to the ledger; IndexedDB stays the source the app reads from.
//
// This module holds the rules only: it takes `invoke`, the flag and the error sinks as parameters, so the node tests
// run it without Tauri. `ledger.ts` wires it to the app.

import type { Message } from '../mock';

export type Invoke = (
    command: string,
    args?: Record<string, unknown>,
) => Promise<unknown>;

/** A chat as the ledger's `ChatMeta` reads it (camelCase, as Tauri passes it). */
export type ChatMeta = {
    id: string;
    title: string;
    projectId: string | null;
    cwd: string | null;
    activeAgent: string | null;
    createdAt: string;
    updatedAt: string;
};

/** A native session of one provider inside a chat, as `ledger::Binding` reads it. */
export type Binding = {
    id: string;
    chatId: string;
    provider: string;
    nativeId: string | null;
    path: string | null;
    model: string | null;
    epoch: number;
    origin: 'created' | 'imported' | 'exported';
    state: 'pending' | 'live' | 'closed';
    syncedSeq: number;
    cursor: unknown;
};

/** A turn to append, as `ledger::NewMessage` reads it. The ledger keeps `blocks` as given. */
export type NewMessage = {
    role: 'user' | 'assistant';
    agent: string | null;
    model: string | null;
    bindingId: string | null;
    time: string;
    native: null;
    blocks: unknown;
};

/** What a turn ended with. Only `done` is written; anything else leaves the ledger as it was. */
export type Outcome = 'done' | 'error';

export type DualWriteOptions = {
    invoke: Invoke;
    /** Read at each call: when it returns false nothing is sent. */
    enabled: () => boolean;
    /** A command failed. The queue goes on with the next command. */
    onError: (command: string, error: unknown, chatId?: string) => void;
    /** Milliseconds a chat's finished turns wait for more before they are appended together. */
    debounceMs?: number;
    /** Turns are copied for the ledger through this (for example, to drop command images). Identity by default. */
    prepare?: (messages: Message[]) => Message[];
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
};

export type DualWriter = {
    /** A turn ended. Its messages are written once, in order, after the debounce; a turn that did not finish writes nothing. */
    recordTurn(chat: ChatMeta, messages: Message[], outcome: Outcome): void;
    /** A native session now belongs to the chat. Written once per session. */
    bindNative(
        chat: ChatMeta,
        provider: string,
        nativeId: string,
        epoch?: number,
    ): void;
    /** The chat was deleted. Its waiting turns are written first, then the delete. */
    remove(chatId: string): void;
    /** Sends every waiting turn now. */
    flush(): void;
    /** Resolves when every command queued so far has run. */
    idle(): Promise<void>;
};

type ChatState = {
    /** `chat_save` was queued for this chat in this session. */
    saved: boolean;
    /** Ids of the messages already queued. */
    sent: Set<string>;
    /** `provider:nativeId` keys already bound. */
    bound: Set<string>;
    /** The latest binding id of each provider, given to the turns that provider wrote. */
    bindings: Map<string, string>;
    pending: NewMessage[];
    timer?: unknown;
};

const DEFAULT_DEBOUNCE_MS = 500;

export function createDualWriter(options: DualWriteOptions): DualWriter {
    const { invoke, enabled, onError } = options;
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const prepare = options.prepare ?? ((messages: Message[]) => messages);
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer =
        options.clearTimer ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const chats = new Map<string, ChatState>();
    // Every command runs after the one before it, so the ledger sees them in the order they were queued.
    let chain: Promise<unknown> = Promise.resolve();

    const order = <T>(
        command: string,
        chatId: string | undefined,
        work: () => Promise<T>,
    ): Promise<T | undefined> => {
        const next = chain.then(async () => {
            try {
                return await work();
            } catch (error) {
                onError(command, error, chatId);
                return undefined;
            }
        });
        chain = next;
        return next;
    };
    const send = (
        command: string,
        args: Record<string, unknown>,
        chatId?: string,
    ) => {
        void order(command, chatId, () => invoke(command, args));
    };

    const stateOf = (chatId: string): ChatState => {
        let state = chats.get(chatId);
        if (!state) {
            state = {
                saved: false,
                sent: new Set(),
                bound: new Set(),
                bindings: new Map(),
                pending: [],
            };
            chats.set(chatId, state);
        }
        return state;
    };

    const ensureSaved = (chat: ChatMeta, state: ChatState) => {
        if (state.saved) return;
        state.saved = true;
        send('chat_save', { chat: { ...chat } }, chat.id);
    };

    /** Sends the waiting turns of a chat as one `chat_append`. */
    const flushChat = (chatId: string) => {
        const state = chats.get(chatId);
        if (!state) return;
        if (state.timer !== undefined) {
            clearTimer(state.timer);
            state.timer = undefined;
        }
        if (!state.pending.length) return;
        const messages = state.pending;
        state.pending = [];
        if (!enabled()) return;
        send('chat_append', { chatId, messages }, chatId);
    };

    const flush = () => {
        for (const chatId of [...chats.keys()]) flushChat(chatId);
    };

    return {
        recordTurn(chat, messages, outcome) {
            if (!enabled() || outcome !== 'done') return;
            // A reply still being written is not a finished turn.
            if (messages.some((message) => message.live)) return;
            const state = stateOf(chat.id);
            const fresh = messages.filter(
                (message) => !state.sent.has(message.id),
            );
            if (!fresh.length) return;
            ensureSaved(chat, state);
            for (const message of prepare(fresh)) {
                const agent = message.agent ?? null;
                state.pending.push({
                    role: message.role,
                    agent,
                    model: message.model ?? null,
                    bindingId: agent
                        ? (state.bindings.get(agent) ?? null)
                        : null,
                    time: message.at ?? message.time,
                    native: null,
                    // Copied now: the message keeps changing on screen after the turn ends.
                    blocks: JSON.parse(JSON.stringify(message.blocks)),
                });
            }
            for (const message of fresh) state.sent.add(message.id);
            if (state.timer !== undefined) clearTimer(state.timer);
            state.timer = setTimer(() => flushChat(chat.id), debounceMs);
        },

        bindNative(chat, provider, nativeId, epoch = 0) {
            if (!enabled()) return;
            const state = stateOf(chat.id);
            const key = `${provider}:${nativeId}`;
            if (state.bound.has(key)) return;
            state.bound.add(key);
            ensureSaved(chat, state);
            const id = `${chat.id}/${key}`;
            state.bindings.set(provider, id);
            const binding: Binding = {
                id,
                chatId: chat.id,
                provider,
                nativeId,
                path: null,
                model: null,
                epoch,
                origin: 'created',
                state: 'live',
                syncedSeq: 0,
                cursor: null,
            };
            send('chat_bind', { chatId: chat.id, binding }, chat.id);
        },

        remove(chatId) {
            if (!enabled()) return;
            flushChat(chatId);
            chats.delete(chatId);
            send('chat_delete', { chatId }, chatId);
        },

        flush,

        // Waits for the commands already sent; turns still in their debounce window stay where they are.
        async idle() {
            await chain;
        },
    };
}
