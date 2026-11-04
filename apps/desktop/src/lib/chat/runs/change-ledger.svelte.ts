// The ledger's state: every file write of every run of the open app, and the conflicts found among them.
// Logic lives in change-ledger.ts; this file only holds it reactively. Plan: plan.md 6.1, 6.5, 6.8.
import {
    appendWrite,
    checkWrite,
    pathKey,
    type LedgerRead,
    type Conflict,
    type LedgerWrite,
    type RunRef,
} from './change-ledger';

export const ledgerWrites = $state<LedgerWrite[]>([]);
/** Conflicts found so far, newest last. The reply that made the write shows its own (see the ConflictNotice). */
export const ledgerConflicts = $state<Conflict[]>([]);

/** Records one file write. Returns the conflict it made, if any. `callId` makes a repeated report of the same write a no-op. */
export function noteLedgerWrite(input: {
    root: string;
    path: string;
    run: RunRef;
    callId: string;
    before: string;
    after: string;
}): Conflict | null | undefined {
    if (
        ledgerWrites.some(
            (write) =>
                write.callId === input.callId &&
                write.path === input.path &&
                write.run.turn === input.run.turn,
        )
    )
        return undefined;
    const conflict = checkWrite(ledgerWrites, input);
    appendWrite(ledgerWrites, input);
    if (conflict) ledgerConflicts.push(conflict);
    return conflict;
}

/** Reads of files by runs (the tool reads of a turn), for the trigger that tells a run when a file it read changed. */
export const ledgerReads = $state<LedgerRead[]>([]);

export function noteLedgerRead(read: LedgerRead): void {
    if (
        ledgerReads.some(
            (item) =>
                item.run.turn === read.run.turn &&
                item.run.sessionId === read.run.sessionId &&
                pathKey(item.path) === pathKey(read.path),
        )
    )
        return;
    ledgerReads.push(read);
    if (ledgerReads.length > 500)
        ledgerReads.splice(0, ledgerReads.length - 500);
}

/** A file the user saved in the editor. The events layer listens (it knows the runs); this module knows nothing of them. */
type SaveListener = (
    root: string,
    path: string,
    before: string,
    after: string,
) => void;
let saveListener: SaveListener | null = null;
export function onUserFileSave(listener: SaveListener): void {
    saveListener = listener;
}
export function reportUserFileSave(
    root: string,
    path: string,
    before: string,
    after: string,
): void {
    saveListener?.(root, path, before, after);
}
