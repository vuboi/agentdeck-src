// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- node runs this file, not the Svelte checker
// @ts-nocheck: run by node (type stripping), not by the Svelte type checker.
// Run with: node --import ./tests/register.mjs --experimental-strip-types --test tests/worktree-merge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    WORKTREE_RULE,
    repoOfWorktreeFolder,
    mergeGate,
    mergeRootOf,
} from '../src/lib/tasks/worktree.ts';

test('R5.1: a worker branch is merged only when its worktree is clean and has commits', () => {
    assert.deepEqual(mergeGate({ dirtyFiles: 2, ahead: 1 }), {
        ok: false,
        message: 'the worker left uncommitted changes',
        canCommit: true,
    });
    assert.deepEqual(mergeGate({ dirtyFiles: 0, ahead: 0 }), {
        ok: false,
        message: 'nothing to merge: the worker made no commit',
        canCommit: false,
    });
    assert.deepEqual(mergeGate({ dirtyFiles: 0, ahead: 1 }), { ok: true });
});

test('R5.1: a merge into a caller worktree base runs in that worktree', () => {
    const project = 'E:/p';
    const callerWt = {
        path: 'E:/p/.agentdeck/worktrees/a-1',
        branch: 'agentdeck/a-1',
        base: 'main',
    };
    assert.equal(
        mergeRootOf(project, callerWt, 'agentdeck/a-1'),
        callerWt.path,
    );
    assert.equal(mergeRootOf(project, callerWt, 'main'), project);
    assert.equal(mergeRootOf(project, undefined, 'main'), project);
});

test('R5.1: an isolated worker is told to commit on its branch before it reports', () => {
    assert.match(WORKTREE_RULE, /own git worktree/);
    assert.match(
        WORKTREE_RULE,
        /Commit your changes on its branch before you report\./,
    );
});

test('R5.1: the worker brief adds the worktree rule only for isolation worktree', async () => {
    const source = await readFile(
        new URL(
            '../src/lib/chat/session/delegate-task.svelte.ts',
            import.meta.url,
        ),
        'utf8',
    );
    assert.match(source, /isolated \? ` \$\{WORKTREE_RULE\}` : ''/);
});

test('R5.5: a worktree folder is read back as its repository, other folders unchanged', () => {
    assert.equal(
        repoOfWorktreeFolder('E:\\repo\\.agentdeck\\worktrees\\fix-1a2b'),
        'E:\\repo',
    );
    assert.equal(
        repoOfWorktreeFolder('E:/repo/.agentdeck/worktrees/fix-1a2b'),
        'E:/repo',
    );
    assert.equal(repoOfWorktreeFolder('E:/repo'), 'E:/repo');
    assert.equal(repoOfWorktreeFolder(''), '');
});

test('R5.5: history import keeps a worker worktree and places its chat by the repository', async () => {
    const source = await readFile(
        new URL('../src/lib/chat/session/history.svelte.ts', import.meta.url),
        'utf8',
    );
    assert.match(source, /worktree: current\.get\(item\.id\)\?\.worktree/);
    assert.match(source, /repoOfWorktreeFolder\(item\.cwd\)/);
});
