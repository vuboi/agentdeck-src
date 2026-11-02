// Bridge to the Rust chat index (`~/.agentdeck/chats.db`). The one-time migration reads the chat state kept in IndexedDB
// and hands it to Rust. IndexedDB is only read, never changed: the rollback flag tells the app to keep using it.

import { invoke } from '@tauri-apps/api/core';
import { inTauri } from '../../app/platform/history';
import { getPref, listPrefs } from '../../app/platform/prefs';

export type MigrationReport = {
    chats: number;
    bindings: number;
    messages: number;
    skipped: number;
    conflicts: string[];
};

export type MigrationStatus = {
    migrated: boolean;
    rollback: boolean;
    report: MigrationReport | null;
};

/** One row of the sidebar's history index (`index.history`), only the fields the migration needs. */
type HistoryRow = { id: string; source: string; path: string };

const MESSAGES = 'local.messages.';
const TRANSCRIPT = 'transcript.';

function withoutPrefix<T>(
    entries: [string, T][],
    prefix: string,
): Record<string, T> {
    return Object.fromEntries(
        entries.map(([key, value]) => [key.slice(prefix.length), value]),
    );
}

/** The IndexedDB chat state in the shape `LegacyDump` reads on the Rust side. */
async function legacyDump() {
    const [mixed, otherTurns, messages, transcripts, history] =
        await Promise.all([
            getPref<Record<string, unknown>>('chat.mixed'),
            getPref<Record<string, unknown[]>>('chat.otherTurns'),
            listPrefs<unknown[]>(MESSAGES),
            listPrefs<unknown>(TRANSCRIPT),
            getPref<HistoryRow[]>('index.history'),
        ]);
    const historyPaths = (history ?? []).flatMap((row) => {
        // A history id is `<source>:<native id>`, the same key the provider's own file is found by.
        const at = row.id.indexOf(':');
        if (at < 0 || !row.path) return [];
        return [
            {
                provider: row.source,
                nativeId: row.id.slice(at + 1),
                path: row.path,
            },
        ];
    });
    return {
        mixed: mixed ?? {},
        otherTurns: otherTurns ?? {},
        localMessages: withoutPrefix(messages, MESSAGES),
        transcripts: withoutPrefix(transcripts, TRANSCRIPT),
        historyPaths,
    };
}

export async function chatIndexStatus(): Promise<MigrationStatus | null> {
    if (!inTauri()) return null;
    return invoke<MigrationStatus>('chat_index_status');
}

/** Imports the IndexedDB chat state. `force` clears the index's chat data first and imports again. */
export async function migrateChatIndex(
    force = false,
): Promise<MigrationReport | null> {
    if (!inTauri()) return null;
    return invoke<MigrationReport>('chat_index_migrate', {
        dump: await legacyDump(),
        force,
    });
}

/**
 * Runs the migration at startup unless it already ran or the rollback flag is on. Best-effort: when it fails, IndexedDB
 * is still the source of truth and nothing else changes.
 */
export async function migrateChatIndexOnce(): Promise<void> {
    try {
        const status = await chatIndexStatus();
        if (!status || status.migrated || status.rollback) return;
        await migrateChatIndex();
    } catch {
        // The app keeps running on IndexedDB; the next start tries again.
    }
}
