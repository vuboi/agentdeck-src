import { inTauri } from '../../app/platform/history';
import { getPref, setPref } from '../../app/platform/prefs';
import { credentialScope } from '../../agents/credential-scope';

// Counts the account switches of each agent. A conversation begun under one account is not resumed under another:
// resuming it there stalls the reply, so the next turn starts a new session with the conversation so far.
// The counts are kept between runs of the app: chats remember the count they began under, and a count that went back
// to zero at start would look like a switch.
const KEY = 'accounts.epochs';

/** Counts are kept per credential scope (see credential-scope.ts): antigravity's under `agy`, a custom provider's under its own key. */
export const accountEpoch = $state<Record<string, number>>({});

/** Until the saved counts have arrived, a chat's epoch cannot be compared: a turn waits for this (with a short limit). */
export let accountEpochsLoaded = false;
export const accountEpochsReady: Promise<void> = Promise.race([
    getPref<Record<string, number>>(KEY)
        .then((saved) => {
            if (!saved) return;
            const early = Object.keys(accountEpoch).length > 0;
            // A switch made before the saved counts arrived is added on top of them, not lost. The old `antigravity` count is
            // the `agy` one now.
            for (const [key, count] of Object.entries(saved)) {
                const scope = key === 'antigravity' ? 'agy' : key;
                accountEpoch[scope] = count + (accountEpoch[scope] ?? 0);
            }
            if (early) void setPref(KEY, { ...accountEpoch });
        })
        .catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
]).then(() => {
    accountEpochsLoaded = true;
});

/**
 * Records a switch of the account of `agent`. Resolves once the CLI kept open for it has been ended, so the caller can
 * release its busy state only after that (an earlier send would otherwise reach the old CLI and the old epoch).
 */
export async function accountSwitched(agent: string): Promise<void> {
    const scope = credentialScope(agent);
    accountEpoch[scope] = (accountEpoch[scope] ?? 0) + 1;
    void setPref(KEY, { ...accountEpoch });
    // A CLI kept open between turns still holds the old sign-in: it is ended, so the next message starts with the new one.
    if (!inTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_warm_reset', { agent }).catch(() => {});
}
