// Which native transcripts belong to one AgentDeck chat. Pure (no stores, no Tauri) so plain node can test it.
//
// The history index is a cache and can lag: a transcript written after its last scan is not in it yet. A file the chat
// already knew stays while its id is still one of the chat's aliases, so a lagging scan does not drop it.
// Used by `applyHistory` in history.svelte.ts.

import type { NativeFile } from './history.svelte';

/** Files of one chat: the ones the index lists for it, then the ones it already knew that the index does not list. */
export function chatFiles(
    indexed: readonly NativeFile[],
    known: readonly NativeFile[] | undefined,
    aliases: readonly string[],
): NativeFile[] {
    // A native id is `<agent>:<conversation id>` both in the index and in the chat's aliases.
    const out = [...indexed];
    const seen = new Set(out.map((file) => file.nativeId));
    for (const file of known ?? []) {
        if (seen.has(file.nativeId) || !aliases.includes(file.nativeId))
            continue;
        seen.add(file.nativeId);
        out.push(file);
    }
    return out;
}
