// The app's wiring of the dual write (`dual-write.ts`) to the chat ledger. Off unless the pref `chat_index.dual_write`
// is on when the app starts (a change takes effect after a restart). Nothing here is shown to the user.

import { invoke } from '@tauri-apps/api/core';
import { inTauri } from '../../app/platform/history';
import { getPref } from '../../app/platform/prefs';
import { logError } from '../../app/platform/error-log.svelte';
import { stripCommandImageData } from '../content/command-images';
import type { SessionItem } from '../session/state.svelte';
import { createDualWriter, type ChatMeta } from './dual-write';
import { loadChatFromLedger } from './ledger-read';

export const LEDGER_FLAG = 'chat_index.dual_write';

// On by default (plan storage-sqlite P5.1): only an explicit `false` in the pref turns the ledger off.
let flagOn = true;
if (inTauri()) {
    void getPref<boolean>(LEDGER_FLAG).then(
        (on) => {
            flagOn = on !== false;
        },
        () => {},
    );
}

/** Whether the ledger is written at all. Callers check it before they build what a write needs. */
export const ledgerOn = () => flagOn;

export const LEDGER_READ_FLAG = 'chat_index.read_ledger';

// Off by default: an open chat is drawn from IndexedDB until the ledger read is checked in the app (plan P5.3).
let readOn = false;
if (inTauri()) {
    void getPref<boolean>(LEDGER_READ_FLAG).then(
        (on) => {
            readOn = on === true;
        },
        () => {},
    );
}

/** Whether an open chat is drawn from the ledger when it has turns there. Read at start-up; a change needs a restart. */
export const ledgerReadOn = () => readOn;

export const ledger = createDualWriter({
    invoke: (command, args) => invoke(command, args),
    enabled: ledgerOn,
    prepare: stripCommandImageData,
    onError: (command, error, chatId) =>
        logError(
            'app',
            'chat index write failed',
            `${command}: ${error instanceof Error ? error.message : String(error)}`,
            chatId ? { chat: chatId } : undefined,
        ),
    onMismatch: (chatId, detail) =>
        logError('app', 'chat index mismatch', detail, { chat: chatId }),
});

/** Every turn of a chat as the app's messages, read from the ledger. `null` when the ledger has no such chat. */
export const readLedgerChat = (chatId: string) =>
    loadChatFromLedger((command, args) => invoke(command, args), chatId);

/** The chat as the ledger's `ChatMeta`. `cwd` is the project folder, if the chat has one. */
export function chatMetaOf(session: SessionItem, cwd: string | null): ChatMeta {
    const now = new Date().toISOString();
    return {
        id: session.id,
        title: session.title,
        projectId: session.projectId,
        cwd,
        activeAgent: session.agent,
        createdAt: now,
        updatedAt: now,
    };
}
