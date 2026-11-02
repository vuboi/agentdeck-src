import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeWorkerWorktree } from './worktree.ts';

const WORKTREE = {
    path: 'E:/repo/.agentdeck/worktrees/write-1a2b',
    branch: 'agentdeck/write-1a2b',
};

test('N2.3: a worker is stopped, its processes ended, then its worktree removed, in that order', async () => {
    const calls: string[] = [];
    await removeWorkerWorktree(
        {
            childId: 'child-1',
            root: 'E:/repo',
            worktree: WORKTREE,
            force: true,
        },
        {
            stopTurn: (chatId) => {
                calls.push(`stopTurn ${chatId}`);
            },
            stopProcesses: async (chatId) => {
                calls.push(`stopProcesses ${chatId}`);
                return [41, 42];
            },
            removeWorktree: async (args) => {
                calls.push(`remove ${args.path}`);
            },
        },
    );
    assert.deepEqual(calls, [
        'stopTurn child-1',
        'stopProcesses child-1',
        `remove ${WORKTREE.path}`,
    ]);
});

test('N2.3: the removal passes its root, branch and force flag on', async () => {
    let sent: unknown;
    await removeWorkerWorktree(
        {
            childId: 'child-1',
            root: 'E:/repo',
            worktree: WORKTREE,
            force: false,
        },
        {
            stopTurn: () => {},
            stopProcesses: async () => [],
            removeWorktree: async (args) => {
                sent = args;
            },
        },
    );
    assert.deepEqual(sent, {
        root: 'E:/repo',
        path: WORKTREE.path,
        branch: WORKTREE.branch,
        force: false,
    });
});

test('N2.3: a worker whose processes cannot be ended keeps its worktree', async () => {
    let removed = false;
    await assert.rejects(
        removeWorkerWorktree(
            {
                childId: 'child-1',
                root: 'E:/repo',
                worktree: WORKTREE,
                force: true,
            },
            {
                stopTurn: () => {},
                stopProcesses: async () => {
                    throw new Error('access denied');
                },
                removeWorktree: async () => {
                    removed = true;
                },
            },
        ),
        /access denied/,
    );
    assert.equal(
        removed,
        false,
        'a folder a process still uses is not removed',
    );
});
