// Putting back the change a run overwrote, when the file still holds what the conflicting run left (plan 6.5).
import type { Conflict } from './change-ledger';
import { ledgerConflicts } from './change-ledger.svelte';

export type RestoreResult = 'restored' | 'changed' | 'unavailable' | 'failed';

/** Writes back the text the earlier run left. Only when the file still holds the text of the conflicting write: a file
 *  edited again since is not touched ('changed'). The conflict leaves the list once it is dealt with. */
export async function restoreOverwritten(
    root: string,
    conflict: Conflict,
): Promise<RestoreResult> {
    if (conflict.over.truncated) return 'unavailable';
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const now = await invoke<string>('file_read', {
            root,
            path: conflict.path,
        });
        if (now !== conflict.after) return 'changed';
        await invoke('file_write', {
            root,
            path: conflict.path,
            text: conflict.over.after,
        });
    } catch {
        return 'failed';
    }
    dismissConflict(conflict);
    return 'restored';
}

/** Keeps the change of the conflicting run: the conflict is no longer shown. */
export function dismissConflict(conflict: Conflict): void {
    const index = ledgerConflicts.indexOf(conflict);
    if (index !== -1) ledgerConflicts.splice(index, 1);
}
