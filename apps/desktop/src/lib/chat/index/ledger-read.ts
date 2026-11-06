// Reads a chat's turns back from the chat ledger (`chats.db`) as the app's `Message`s (plan storage-sqlite P5.3).
// Pure rules plus one paged reader that takes `invoke` as a parameter, so the node tests run it without Tauri.
// Nothing calls this yet: IndexedDB stays the source the app draws from until the reads are checked in the app.

import type { Message } from '../mock';
import type { Invoke } from './dual-write';

/** A stored turn as `chat_open` returns it (`StoredMessage`, camelCase). */
export type LedgerRow = {
    seq: number;
    clientId: string | null;
    role: 'user' | 'assistant';
    agent: string | null;
    model: string | null;
    time: string;
    blocks: unknown;
};

/** One page of `chat_open`. */
type LedgerPage = { messages: LedgerRow[]; hasMore: boolean } | null;

const PAGE = 50;

/**
 * The app's message for a stored turn. Two shapes are in the ledger:
 * - a whole message (migrated from IndexedDB, and dual-write since storedCopy): its fields come back as they were;
 * - a bare block list (dual-write before storedCopy): the row's columns say the rest.
 * The id is the message's own id, else the screen id the row kept, else a stable `ledger-<seq>`.
 */
export function messageFromLedger(row: LedgerRow): Message {
    const fallbackId = row.clientId ?? `ledger-${row.seq}`;
    if (Array.isArray(row.blocks)) {
        return {
            id: fallbackId,
            role: row.role,
            time: row.time,
            at: row.time || undefined,
            agent: (row.agent ?? undefined) as Message['agent'],
            model: row.model ?? undefined,
            blocks: row.blocks as Message['blocks'],
        };
    }
    const stored = (row.blocks ?? {}) as Partial<Message>;
    return {
        ...(stored as Message),
        id: typeof stored.id === 'string' && stored.id ? stored.id : fallbackId,
        role: row.role,
        time: stored.time ?? row.time,
        blocks: (stored.blocks ?? []) as Message['blocks'],
    };
}

/**
 * Every turn of a chat, oldest first, read page by page. `null` when the ledger has no such chat.
 * The newest page is read first; each older page is read below the one before it.
 */
export async function loadChatFromLedger(
    invoke: Invoke,
    chatId: string,
): Promise<Message[] | null> {
    const pages: LedgerRow[][] = [];
    let before: number | null = null;
    for (;;) {
        const page = (await invoke('chat_open', {
            id: chatId,
            beforeSeq: before,
            limit: PAGE,
        })) as LedgerPage;
        // No such chat on the first page; a chat gone while its older pages were read keeps the pages already read.
        if (!page) return before === null ? null : finish(pages);
        pages.unshift(page.messages);
        if (!page.hasMore || !page.messages.length) break;
        before = page.messages[0].seq;
    }
    return finish(pages);
}

function finish(pages: LedgerRow[][]): Message[] {
    return pages.flat().map(messageFromLedger);
}
