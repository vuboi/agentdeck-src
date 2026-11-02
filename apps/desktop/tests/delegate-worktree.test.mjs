import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import * as taskHelpers from '../src/lib/tasks/delegate-task.ts';

const WORKTREE = {
    path: 'E:/repo/.agentdeck/worktrees/write-1a2b',
    branch: 'agentdeck/write-1a2b',
    base: 'main',
};

/**
 * A delegate module on the desktop app (inTauri), whose caller is `chat` (or any chat in `sessions`). `invoke` records every
 * Tauri call; worktree_create answers with WORKTREE.
 */
async function worktreeCaller(sessions) {
    const workspace = { activeId: 'chat', sessions, projects: [] };
    const replies = [];
    const invoked = [];
    // The module starts the Tauri listeners when it loads on the desktop app: off until it is loaded, on for the calls.
    const env = { tauri: false };
    const api = await load('delegate-task', {
        ...taskHelpers,
        elapsed: (ms) => `${ms} ms`,
        workspace,
        // The folder of a chat: its worktree, else its project (none in these fixtures, so the chat's own folder).
        sessionCwd: (session) =>
            session.worktree?.path || session.workingDirectory || null,
        // No agent is installed here: the agent list is empty, so an unknown agent name is refused after the worktree is made.
        connectors: { detected: undefined, custom: [] },
        roomLine: () => '',
        agentHasRoom: () => true,
        agentLabel: (id) => id,
        getPref: async () => null,
        setPref() {},
        persistLocal() {},
        logFlow() {},
        hasTurnWork: () => false,
        inTauri: () => env.tauri,
        owesTurn: () => false,
        queued: {},
        queuePaused: {},
        send() {},
        sendNextQueued() {},
        handbackPrompt: () => 'handback',
        NO_HANDOUT: {},
        replyDelegateCall: async (...args) => {
            replies.push(args);
            return true;
        },
        invoke: async (command, args) => {
            invoked.push([command, args]);
            return command === 'worktree_create' ? WORKTREE : undefined;
        },
        releaseWorkerSlot: async () => {},
        stopTurn() {},
        updateWorkflowWorker() {},
        settleWorkflowRun() {},
        taskWaiters: new Map(),
    });
    env.tauri = true;
    return { api, workspace, replies, invoked };
}

const chat = {
    id: 'chat',
    agent: 'claude',
    model: 'model',
    status: 'idle',
    projectId: 'project',
    gitBranch: 'main',
    workingDirectory: 'E:/repo',
    draft: false,
    made: true,
};

/** Lets the Tauri promise chain of startTask run to its reply. */
async function settle() {
    for (let i = 0; i < 20; i++)
        await new Promise((resolve) => setImmediate(resolve));
}

test('R5.2: a call past the delegation depth creates no worktree', async () => {
    // chat -> c1 -> c2 -> c3 -> c4: c4 is four levels below the user's chat, the limit.
    const workers = ['c1', 'c2', 'c3', 'c4'].map((childId, index) => ({
        id: `c${index + 1}`,
        agent: 'claude',
        model: 'model',
        status: 'idle',
        projectId: 'project',
        parentId: index ? `c${index}` : 'chat',
        workingDirectory: 'E:/repo',
        draft: false,
        made: true,
    }));
    const { api, workspace, replies, invoked } = await worktreeCaller([
        chat,
        ...workers,
    ]);
    ['c1', 'c2', 'c3', 'c4'].forEach((childId, index) => {
        api.delegateTasks[`t${index + 1}`] = {
            id: `t${index + 1}`,
            caller: index ? `c${index}` : 'chat',
            childId,
            state: 'done',
            dependsOn: [],
            wait: false,
            label: 'x',
            agent: 'claude',
            agentId: 'claude',
            model: 'model',
            task: 'x',
            startedAt: 0,
        };
    });
    assert.ok(workspace.sessions.length > 0);
    api.onDelegateCall({
        callId: 'c9',
        caller: 'c4',
        tool: 'delegate_task',
        args: {
            agent: 'claude',
            task: 'write the file',
            isolation: 'worktree',
        },
    });
    await settle();
    assert.equal(replies.length, 1);
    assert.equal(replies[0][2], true);
    assert.match(replies[0][1], /Delegation depth is limited/);
    assert.equal(
        invoked.filter(([command]) => command === 'worktree_create').length,
        0,
        'no worktree is made for a refused call',
    );
});

test('R5.2: a worktree made for a call that then fails is removed again', async () => {
    const { api, replies, invoked } = await worktreeCaller([chat]);
    api.onDelegateCall({
        callId: 'c1',
        caller: 'chat',
        tool: 'delegate_task',
        args: {
            agent: 'no-such-agent',
            task: 'write the file',
            isolation: 'worktree',
        },
    });
    await settle();
    assert.equal(replies.length, 1);
    assert.equal(replies[0][2], true);
    // Objects made inside the module's vm context have another prototype: compare plain copies.
    const removed = JSON.parse(
        JSON.stringify(
            invoked.filter(([command]) => command === 'worktree_remove'),
        ),
    );
    assert.deepEqual(removed, [
        [
            'worktree_remove',
            {
                root: 'E:/repo',
                path: WORKTREE.path,
                branch: WORKTREE.branch,
                force: true,
            },
        ],
    ]);
});
