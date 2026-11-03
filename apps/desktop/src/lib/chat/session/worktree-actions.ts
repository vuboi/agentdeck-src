import { invoke } from '@tauri-apps/api/core';
import { toast } from '../../app/platform/toast';
import { workspace } from '../sessions.svelte';
import { newSession, projectOf, type WorktreeInfo } from './state.svelte';
import { stopTurn } from './turns.svelte';
import {
    mergeGate,
    mergeRootOf,
    removeWorkerWorktree,
} from '../../tasks/worktree';

export type WorktreeStatus = {
    dirtyFiles: number;
    ahead: number;
    behind: number;
};

/** A new chat in its own worktree of the project, on a branch from the project's checked-out branch. */
export async function newWorktreeSession(projectId: string) {
    const project = workspace.projects.find((item) => item.id === projectId);
    if (!project?.path) return;
    try {
        const worktree = await invoke<WorktreeInfo>('worktree_create', {
            root: project.path,
            slug: 'chat',
            base: 'HEAD',
        });
        newSession(projectId, worktree);
    } catch (error) {
        toast.error(`Could not create a worktree: ${String(error)}`);
    }
}

/** Merges a chat's branch into the project's checked-out branch and removes its worktree, or discards both. Both ask first. */
export async function finishWorktree(childId: string, merge: boolean) {
    const session = workspace.sessions.find((item) => item.id === childId);
    const wt = session?.worktree;
    const projectPath = session ? projectOf(session)?.path : undefined;
    if (!session || !wt || !projectPath) return;
    const root = mergeRootOf(
        projectPath,
        workspace.sessions.find((item) => item.id === session.parentId)
            ?.worktree,
        wt.base,
    );
    try {
        if (merge) {
            // Uncommitted files stay out of the merge: offer a commit in the worktree instead, and merge on the next press.
            const status = await invoke<WorktreeStatus>('worktree_status', {
                path: wt.path,
                base: wt.base,
            });
            const gate = mergeGate(status);
            if (!gate.ok) {
                if (
                    gate.canCommit &&
                    confirm(
                        `${gate.message}. Commit them in the worktree now? The merge is not run; press Merge again after.`,
                    )
                )
                    await invoke('worktree_commit', {
                        path: wt.path,
                        message: 'worker: uncommitted changes',
                    });
                else if (!gate.canCommit) alert(gate.message);
                return;
            }
        }
        const ask = merge
            ? `Merge ${wt.branch} into ${wt.base}, then remove its worktree?`
            : `Discard worktree ${wt.branch} and its branch? Unmerged changes are lost.`;
        if (!confirm(ask)) return;
        if (merge)
            await invoke('worktree_merge', {
                root,
                branch: wt.branch,
                base: wt.base,
            });
        // The chat is stopped and its processes ended before its folder goes (removeWorkerWorktree).
        await removeWorkerWorktree(
            {
                childId,
                root,
                worktree: wt,
                force: !merge,
            },
            {
                stopTurn: (id) => stopTurn(id),
                stopProcesses: (id) =>
                    invoke('stop_chat_processes', { chatId: id }),
                removeWorktree: (args) => invoke('worktree_remove', args),
            },
        );
        session.worktree = undefined;
    } catch (error) {
        alert(String(error));
    }
}

/** Brings the base branch into a chat's worktree. A conflict aborts the merge: the files are named, nothing is resolved. */
export async function syncWorktree(sessionId: string) {
    const wt = workspace.sessions.find(
        (item) => item.id === sessionId,
    )?.worktree;
    if (!wt) return;
    try {
        const status = await invoke<WorktreeStatus>('worktree_status', {
            path: wt.path,
            base: wt.base,
        });
        if (status.dirtyFiles > 0) {
            toast.error(
                'Commit the worktree changes before updating from base',
            );
            return;
        }
        if (status.behind === 0) {
            toast.success(`Already up to date with ${wt.base}`);
            return;
        }
        const conflicts = await invoke<string[]>('worktree_sync', {
            path: wt.path,
            base: wt.base,
        });
        if (conflicts.length > 0)
            toast.error(
                `Conflicts with ${wt.base} in ${conflicts.join(', ')}. The update was not applied.`,
            );
        else toast.success(`Updated from ${wt.base}`);
    } catch (error) {
        toast.error(String(error));
    }
}
