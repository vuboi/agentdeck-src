// Pure rules for the git worktree of a worker chat: what may be merged, where the merge runs, and what the worker is told.
// The Svelte components and the coordinator call these; tests run them without Tauri.

/** The worker's brief when it runs in its own worktree (isolation: worktree). */
export const WORKTREE_RULE =
    'You work in your own git worktree. Commit your changes on its branch before you report.';

/** A short, ASCII folder and branch part from the task text: "Fix export PDF" -> "fix-export-pdf". */
export function worktreeSlug(task: string): string {
    const slug = task
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20)
        .replace(/-+$/, '');
    return slug || 'task';
}

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

/**
 * The repository a worktree folder belongs to: `<repo>/.agentdeck/worktrees/<name>` gives `<repo>`. Any other folder comes back
 * unchanged. A transcript written in a worktree names that folder as its cwd; the chat belongs to the repository.
 */
export function repoOfWorktreeFolder(cwd: string): string {
    const at = cwd.replace(/\\/g, '/').indexOf('/.agentdeck/worktrees/');
    if (at <= 0) return cwd;
    // The same separator style as the input, up to the repository folder.
    return cwd.slice(0, at);
}

/** What removing a worker's worktree needs from the app: stop the chat's turn, end its processes, remove the folder. */
export type WorkerWorktreeIo = {
    stopTurn: (chatId: string) => void;
    stopProcesses: (chatId: string) => Promise<unknown>;
    removeWorktree: (args: {
        root: string;
        path: string;
        branch: string;
        force: boolean;
    }) => Promise<unknown>;
};

/**
 * Removes a worker's worktree. The worker is stopped and its processes ended first: a process still running in the folder
 * would write into a folder that is gone. If a process cannot be ended the folder is kept, and the error goes up.
 */
export async function removeWorkerWorktree(
    input: {
        childId: string;
        root: string;
        worktree: { path: string; branch: string };
        force: boolean;
    },
    io: WorkerWorktreeIo,
): Promise<void> {
    io.stopTurn(input.childId);
    await io.stopProcesses(input.childId);
    await io.removeWorktree({
        root: input.root,
        path: input.worktree.path,
        branch: input.worktree.branch,
        force: input.force,
    });
}
