import { invoke } from '@tauri-apps/api/core';
import { getPref, setPref } from '../../app/platform/prefs';
import { inTauri } from '../../app/platform/history';
import { ledger } from '../index/ledger';
import type { Message } from '../mock';
import { stripCommandImageData } from './command-images';

// AgentDeck's own copy of every conversation turn: which agent and model wrote it, when, and what it said.
// The agent CLIs keep their own history in their own formats; this is one format of ours, kept in IndexedDB, and
// the single place a sync (to a GitHub repo, a Gist, a folder…) reads from and writes to later. A sync target
// only has to implement `SyncTarget`; nothing else in the app needs to know where the data goes.
//
// Records are keyed by chat and message id, so saving the same turn again replaces it instead of piling up.
// Each carries `savedAt`; a target remembers the last `savedAt` it pushed and gets only what changed after that.

export const ARCHIVE_VERSION = 1;

export type ArchiveSession = {
    v: typeof ARCHIVE_VERSION;
    id: string;
    title: string;
    agent: string;
    model: string | null;
    projectPath: string | null;
    savedAt: string;
};

export type ArchiveMessage = {
    v: typeof ARCHIVE_VERSION;
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    /** ISO time of the message. */
    at: string | null;
    /** Who wrote an assistant message, and on which model. */
    agent: string | null;
    model: string | null;
    /** Answer text only; tool output stays in the CLI's own history. */
    text: string;
    tools: number;
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    } | null;
    /** Last model call's context size, kept because provider transcripts may omit it. */
    context: number | null;
    cost: number | null;
    ms: number | null;
    /** AgentDeck-only fields needed to redraw automatic work reports after the provider transcript is reloaded. */
    snapshot?: Message;
    savedAt: string;
};

/** What moves between devices: everything saved after `from` (exclusive), up to `to`. */
export type ArchiveBatch = {
    version: typeof ARCHIVE_VERSION;
    from: string | null;
    to: string;
    sessions: ArchiveSession[];
    messages: ArchiveMessage[];
};

/** A place the archive can be copied to (and read back from). */
export interface SyncTarget {
    id: string;
    label: string;
    push(batch: ArchiveBatch): Promise<void>;
    /** Everything the target holds that was saved after `since`. Optional: a target may be write-only. */
    pull?(since: string | null): Promise<ArchiveBatch>;
}

/** The ledger row of a chat's own record (its title, agent, project), next to its replies. */
const SESSION_ROW = '@session';
/** One ledger row per record: `msgId` is the message id, or SESSION_ROW for the chat. Its `at` is `savedAt`. */
type ArchiveRow = {
    chatId: string;
    msgId: string;
    at: string;
    tokens: number | null;
    snapshot: unknown;
};
const KEY_PUSHED = (target: string) => `archivecursor.push.${target}`;
const KEY_PULLED = (target: string) => `archivecursor.pull.${target}`;

const textOf = (message: Message) =>
    message.blocks
        .filter((block) => block.kind === 'response')
        .map((block) => (block as { text: string }).text)
        .join('\n\n')
        .trim();

const hasWorkBlocks = (message: Message) =>
    message.blocks.some(
        (block) =>
            block.kind === 'delegate' ||
            (block.kind === 'command' &&
                Boolean(
                    block.taskId ||
                    block.task ||
                    block.children ||
                    block.background,
                )),
    );

const snapshotOf = (message: Message): Message | undefined => {
    if (!message.autoTurn && !hasWorkBlocks(message)) return undefined;
    // Command screenshots are indexed separately and can be large; keep their local file references, not base64 data.
    return JSON.parse(
        JSON.stringify(stripCommandImageData([message])[0]),
    ) as Message;
};

/** Saves the messages of a finished turn, and the chat they belong to. */
export function archiveTurn(
    session: {
        id: string;
        title: string;
        agent: string;
        model: string | null | undefined;
        projectPath: string | null;
    },
    messages: Message[],
) {
    const savedAt = new Date().toISOString();
    const rows: ArchiveRow[] = [
        {
            chatId: session.id,
            msgId: SESSION_ROW,
            at: savedAt,
            tokens: null,
            snapshot: {
                v: ARCHIVE_VERSION,
                id: session.id,
                title: session.title,
                agent: session.agent,
                model: session.model ?? null,
                projectPath: session.projectPath,
                savedAt,
            } satisfies ArchiveSession,
        },
    ];
    for (const message of messages) {
        const snapshot = snapshotOf(message);
        const record: ArchiveMessage = {
            v: ARCHIVE_VERSION,
            id: message.id,
            sessionId: session.id,
            role: message.role,
            at: message.at ?? null,
            agent:
                message.role === 'assistant'
                    ? (message.agent ?? session.agent)
                    : null,
            model:
                message.role === 'assistant'
                    ? (message.model ?? session.model ?? null)
                    : null,
            text: textOf(message),
            tools: message.blocks.filter((block) => block.kind === 'command')
                .length,
            tokens: message.tokens ? { ...message.tokens } : null,
            context: message.context ?? null,
            cost: message.cost ?? null,
            ms: message.ms ?? null,
            ...(snapshot ? { snapshot } : {}),
            savedAt,
        };
        rows.push({
            chatId: session.id,
            msgId: message.id,
            at: savedAt,
            tokens: record.tokens
                ? record.tokens.input + record.tokens.output
                : null,
            snapshot: record,
        });
    }
    // Queued after the turn's own ledger write (`ledger.recordTurn` is called right after this), so a new chat exists first.
    queueMicrotask(() => {
        for (const row of rows) putRow(row);
    });
}

/** Writes one archive row to the chat ledger (plan storage-sqlite P5.4), in the ledger's queue. */
function putRow(row: ArchiveRow) {
    ledger.run(
        'chat_put_archive',
        {
            chatId: row.chatId,
            msgId: row.msgId,
            at: row.at,
            tokens: row.tokens,
            snapshot: row.snapshot,
        },
        row.chatId,
    );
}

/** Every archive row of the ledger, as read back from `chat_archive_all`. */
async function allRows(): Promise<ArchiveRow[]> {
    if (!inTauri()) return [];
    const entries = await invoke<
        [
            string,
            {
                msgId: string;
                at: string;
                tokens: number | null;
                snapshot: unknown;
            },
        ][]
    >('chat_archive_all');
    return entries.map(([chatId, entry]) => ({ chatId, ...entry }));
}

/** Reads AgentDeck's extra turn data without replacing the provider's own transcript. */
export async function archivedMessages(
    sessionId: string,
): Promise<ArchiveMessage[]> {
    if (!inTauri()) return [];
    const entries = await invoke<{ msgId: string; snapshot: unknown }[]>(
        'chat_archive',
        { chatId: sessionId },
    );
    return entries
        .filter((entry) => entry.msgId !== SESSION_ROW)
        .map((entry) => entry.snapshot as ArchiveMessage)
        .filter(
            (message) =>
                message.context != null ||
                message.snapshot?.autoTurn ||
                (message.snapshot && hasWorkBlocks(message.snapshot)),
        );
}

/** Everything saved after `since` (all of it when `null`). */
export async function exportArchive(
    since: string | null = null,
): Promise<ArchiveBatch> {
    const rows = await allRows();
    const newer = rows.filter((row) => since === null || row.at > since);
    const sessions = newer
        .filter((row) => row.msgId === SESSION_ROW)
        .map((row) => row.snapshot as ArchiveSession);
    const messages = newer
        .filter((row) => row.msgId !== SESSION_ROW)
        .map((row) => row.snapshot as ArchiveMessage);
    const stamps = newer.map((row) => row.at).sort();
    return {
        version: ARCHIVE_VERSION,
        from: since,
        to: stamps.at(-1) ?? since ?? new Date().toISOString(),
        sessions,
        messages,
    };
}

/** Merges a batch from elsewhere: a record is replaced only by a newer copy of itself. */
export async function importArchive(batch: ArchiveBatch) {
    if (batch.version !== ARCHIVE_VERSION)
        throw new Error(`archive version ${batch.version} is not supported`);
    const have = new Map<string, string>();
    for (const row of await allRows())
        have.set(`${row.chatId}\u0000${row.msgId}`, row.at);
    const merge = (
        chatId: string,
        msgId: string,
        savedAt: string,
        snapshot: unknown,
        tokens: number | null,
    ) => {
        const current = have.get(`${chatId}\u0000${msgId}`);
        if (current === undefined || current < savedAt)
            putRow({ chatId, msgId, at: savedAt, tokens, snapshot });
    };
    for (const item of batch.sessions)
        merge(item.id, SESSION_ROW, item.savedAt, item, null);
    for (const item of batch.messages) {
        const tokens = item.tokens
            ? item.tokens.input + item.tokens.output
            : null;
        merge(item.sessionId, item.id, item.savedAt, item, tokens);
    }
}

const targets = new Map<string, SyncTarget>();
export const registerSyncTarget = (target: SyncTarget) =>
    void targets.set(target.id, target);
export const syncTargets = () => [...targets.values()];

/** Sends what changed since the last push to a target, then moves its cursor. Returns how many messages went. */
export async function pushArchive(targetId: string): Promise<number> {
    const target = targets.get(targetId);
    if (!target) throw new Error(`no sync target "${targetId}"`);
    const since = (await getPref<string>(KEY_PUSHED(targetId))) ?? null;
    const batch = await exportArchive(since);
    if (batch.messages.length === 0 && batch.sessions.length === 0) return 0;
    await target.push(batch);
    setPref(KEY_PUSHED(targetId), batch.to);
    return batch.messages.length;
}

/** Reads what a target holds that is newer than the last pull and merges it in. Returns how many messages came. */
export async function pullArchive(targetId: string): Promise<number> {
    const target = targets.get(targetId);
    if (!target?.pull) throw new Error(`"${targetId}" cannot be read back`);
    const since = (await getPref<string>(KEY_PULLED(targetId))) ?? null;
    const batch = await target.pull(since);
    await importArchive(batch);
    setPref(KEY_PULLED(targetId), batch.to);
    return batch.messages.length;
}
