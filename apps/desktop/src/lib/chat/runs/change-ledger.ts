// The change ledger: one record of which run wrote which file of a project, and which run read it during its turn.
// Pure (no stores, no Tauri) so plain node can test it. Plan: plan.md 6.1 (ledger), 6.5 (conflicts).
//
// `intentAt` orders the requests of the user: a run started by a later message has a larger value. A run that writes
// over a file a later request already changed is a conflict, because the later request is the user's latest intent.

export type LedgerLane =
    'primary' | 'listener' | 'worker' | 'subagent' | 'auto' | 'user';

export type RunRef = {
    sessionId: string;
    turn: string;
    lane: LedgerLane;
    /** When the message that started this run was sent (ms). Later requests have larger values. */
    intentAt: number;
    /** A sub-agent of the CLI (its tool_use_id or thread id), when the write came from one. */
    subId?: string;
    /** What the sub-agent or worker does, for the messages that name it (`Explore · Scan docs`). */
    label?: string;
};

/** Longest `after` text kept per write; a larger file is recorded without its text (diffs then show the size only). */
export const MAX_KEPT_CHARS = 200_000;

export type LedgerWrite = {
    /** Project root, as the chat knows it. */
    root: string;
    /** Path as the agent wrote it. Compared through `pathKey`. */
    path: string;
    run: RunRef;
    at: number;
    callId: string;
    before: string;
    after: string;
    /** `after` was cut at MAX_KEPT_CHARS; reverting from it is not possible. */
    truncated: boolean;
};

export type LedgerRead = {
    root: string;
    path: string;
    run: RunRef;
    at: number;
};

export type Conflict = {
    path: string;
    /** The run that just wrote over the other one's change. */
    writer: RunRef;
    /** The earlier write it changed. */
    over: LedgerWrite;
    /** The text the conflicting write left (what the file held after it). */
    after: string;
    /** `revert`: the new text is the text before `over`; `overwrite`: anything else. */
    kind: 'revert' | 'overwrite';
};

/** The key a path compares by: slashes unified, case folded (Windows paths), no trailing slash. */
export function pathKey(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Keeps a write's text within MAX_KEPT_CHARS. */
export function keepText(text: string): { text: string; truncated: boolean } {
    return text.length > MAX_KEPT_CHARS
        ? { text: text.slice(0, MAX_KEPT_CHARS), truncated: true }
        : { text, truncated: false };
}

/** Same run (a turn of one chat, or one sub-agent of it). */
export function sameRun(a: RunRef, b: RunRef): boolean {
    return (
        a.sessionId === b.sessionId && a.turn === b.turn && a.subId === b.subId
    );
}

/** The latest write to `path` under `root`, or undefined. */
export function latestWrite(
    writes: readonly LedgerWrite[],
    root: string,
    path: string,
): LedgerWrite | undefined {
    const key = pathKey(path);
    for (let index = writes.length - 1; index >= 0; index--) {
        const write = writes[index];
        if (write.root === root && pathKey(write.path) === key) return write;
    }
    return undefined;
}

/**
 * Checks a new write against the ledger: a conflict when the file's latest writer was a run of a NEWER request than the
 * writer now (the user's later intent is being undone or overwritten). Same-intent writes are not conflicts: they are
 * the same request continuing.
 */
export function checkWrite(
    writes: readonly LedgerWrite[],
    next: Omit<LedgerWrite, 'at' | 'truncated'> & { at?: number },
): Conflict | null {
    const previous = latestWrite(writes, next.root, next.path);
    if (!previous || sameRun(previous.run, next.run)) return null;
    if (previous.run.intentAt <= next.run.intentAt) return null;
    return {
        path: next.path,
        writer: next.run,
        over: previous,
        after: next.after,
        kind: next.after === previous.before ? 'revert' : 'overwrite',
    };
}

/** Appends a write, bounding the ledger to `limit` entries (oldest out first). */
export function appendWrite(
    writes: LedgerWrite[],
    next: Omit<LedgerWrite, 'at' | 'truncated' | 'after'> & {
        at?: number;
        after: string;
    },
    limit = 500,
): LedgerWrite {
    const kept = keepText(next.after);
    const entry: LedgerWrite = {
        ...next,
        at: next.at ?? Date.now(),
        after: kept.text,
        truncated: kept.truncated,
    };
    writes.push(entry);
    if (writes.length > limit) writes.splice(0, writes.length - limit);
    return entry;
}

/** When the user's latest request in a chat was sent (ms), or undefined when there is none. A retry or continuation
 *  answers that same request, so its run keeps this time, not the time it started. */
export function requestAt(
    list: readonly { role: string; at?: string }[],
): number | undefined {
    for (let index = list.length - 1; index >= 0; index--) {
        const message = list[index];
        if (message.role !== 'user' || !message.at) continue;
        const at = Date.parse(message.at);
        if (!Number.isNaN(at)) return at;
    }
    return undefined;
}

/** Writes of one turn, as a list of paths (for notices and for the parent's summary). */
export function pathsWrittenBy(
    writes: readonly LedgerWrite[],
    run: Pick<RunRef, 'sessionId' | 'turn'>,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const write of writes) {
        if (
            write.run.sessionId !== run.sessionId ||
            write.run.turn !== run.turn
        )
            continue;
        const key = pathKey(write.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(write.path);
    }
    return out;
}

/** The file path a read tool names, from its `Name  input` line (JSON input first, plain text as a fallback). */
export function readPathOf(name: string, input: string): string | undefined {
    if (
        !/^(Read|read_file|readfile|view|cat|open_file)$/i.test(
            name.split('.').at(-1) ?? name,
        )
    )
        return undefined;
    try {
        const value = JSON.parse(input) as Record<string, unknown>;
        const path = value.file_path ?? value.path;
        return typeof path === 'string' && path ? path : undefined;
    } catch {
        const trimmed = input.trim();
        return trimmed && !/\s/.test(trimmed) ? trimmed : undefined;
    }
}

/** Every path a chat wrote to, over all its turns (a worker's changes, for the run that depends on it). */
export function pathsWrittenInChat(
    writes: readonly LedgerWrite[],
    sessionId: string,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const write of writes) {
        if (write.run.sessionId !== sessionId) continue;
        const key = pathKey(write.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(write.path);
    }
    return out;
}
