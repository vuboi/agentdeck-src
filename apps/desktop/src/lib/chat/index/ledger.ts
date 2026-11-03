// The app's wiring of the dual write (`dual-write.ts`) to the chat ledger. Off unless the pref `chat_index.dual_write`
// is on when the app starts (a change takes effect after a restart). Nothing here is shown to the user.

import { invoke } from '@tauri-apps/api/core';
import { inTauri } from '../../app/platform/history';
import { getPref } from '../../app/platform/prefs';
import { logError } from '../../app/platform/error-log.svelte';
import { stripCommandImageData } from '../content/command-images';
import type { SessionItem } from '../session/state.svelte';
import { createDualWriter, type ChatMeta } from './dual-write';

export const LEDGER_FLAG = 'chat_index.dual_write';

let flagOn = false;
if (inTauri()) {
    void getPref<boolean>(LEDGER_FLAG).then(
        (on) => {
            flagOn = on === true;
        },
        () => {},
    );
}

/** Whether the ledger is written at all. Callers check it before they build what a write needs. */
export const ledgerOn = () => flagOn;

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
});

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
