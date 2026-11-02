// Pure rules for the git worktree of a worker chat: what may be merged, where the merge runs, and what the worker is told.
// The Svelte components and the coordinator call these; tests run them without Tauri.

/** The worker's brief when it runs in its own worktree (isolation: worktree). */
export const WORKTREE_RULE =
    'You work in your own git worktree. Commit your changes on its branch before you report.';

export type WorktreeGate =
    { ok: true } | { ok: false; message: string; canCommit: boolean };

/**
 * Whether a worker's branch may be merged now. Uncommitted files are never merged (the merge would keep only the commits);
 * a branch with no commit has nothing to merge.
 */
export function mergeGate(status: {
    dirtyFiles: number;
    ahead: number;
}): WorktreeGate {
    if (status.dirtyFiles > 0)
        return {
            ok: false,
            message: 'the worker left uncommitted changes',
            canCommit: true,
        };
    if (status.ahead === 0)
        return {
            ok: false,
            message: 'nothing to merge: the worker made no commit',
            canCommit: false,
        };
    return { ok: true };
}

/**
 * The folder whose checkout receives the merge. The worker's base is a branch: when that branch is the worktree of the
 * calling chat, the merge goes there; otherwise it goes to the project's checkout.
 */
export function mergeRootOf(
    projectPath: string,
    callerWorktree: { path: string; branch: string } | undefined,
    base: string,
): string {
    return callerWorktree && callerWorktree.branch === base
        ? callerWorktree.path
        : projectPath;
}
