import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import * as taskHelpers from '../src/lib/tasks/delegate-task.ts';
import { planTask } from '../src/lib/tasks/delegate-plan.ts';
import { worktreeSlug } from '../src/lib/tasks/worktree.ts';

const WORKTREE = {
    path: 'E:/repo/.agentdeck/worktrees/write-1a2b',
    branch: 'agentdeck/write-1a2b',
    base: 'main',
};

/**
 * A delegate module on the desktop app (inTauri), whose caller is `chat` (or any chat in `sessions`). `invoke` records every
 * Tauri call; worktree_create answers with WORKTREE.
 */
async function worktreeCaller(sessions, { hold = false } = {}) {
    const workspace = { activeId: 'chat', sessions, projects: [] };
    const replies = [];
    const invoked = [];
    // With `hold`, worktree_create waits until `release()` is called: the chat can be stopped while the worktree is made.
    let release = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    // The module starts the Tauri listeners when it loads on the desktop app: off until it is loaded, on for the calls.
    const env = { tauri: false };
    const api = await load('delegate-task', {
        ...taskHelpers,
        planTask,
        worktreeSlug,
        elapsed: (ms) => `${ms} ms`,
        workspace,
        // The folder of a chat: its worktree, else its project (none in these fixtures, so the chat's own folder).
        sessionCwd: (session) =>
            session.worktree?.path || session.workingDirectory || null,
        // One installed agent, claude, with one model: a call for it passes every check and reaches the worktree step.
        // Any other agent name is refused by planTask, before any worktree is made.
        MODELS: {
            claude: [{ value: 'model', label: 'model', description: '' }],
        },
        connectors: {
            detected: { tools: [{ id: 'claude', path: 'C:/claude.exe' }] },
            custom: [],
        },
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
            if (command !== 'worktree_create') return undefined;
            if (hold) await gate;
            return WORKTREE;
        },
        releaseWorkerSlot: async () => {},
        stopTurn() {},
        updateWorkflowWorker() {},
        settleWorkflowRun() {},
        taskWaiters: new Map(),
    });
    env.tauri = true;
    return { api, workspace, replies, invoked, release };
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

test('N2.1: a call refused for its agent makes no worktree at all', async () => {
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
    assert.match(replies[0][1], /No agent "no-such-agent"/);
    assert.equal(
        invoked.filter(([command]) => command === 'worktree_create').length,
        0,
        'a refused call is checked before its worktree is made',
    );
    assert.equal(
        invoked.filter(([command]) => command === 'worktree_remove').length,
        0,
        'nothing was made, so nothing is removed',
    );
});

test('R5.3: a chat stopped while its worktree is being made gets no worker, and the worktree is removed', async () => {
    const { api, workspace, replies, invoked, release } = await worktreeCaller(
        [chat],
        { hold: true },
    );
    api.onDelegateCall({
        callId: 'c1',
        caller: 'chat',
        tool: 'delegate_task',
        args: {
            agent: 'claude',
            task: 'write the file',
            isolation: 'worktree',
        },
    });
    await settle();
    assert.equal(
        invoked.filter(([command]) => command === 'worktree_create').length,
        1,
        'the worktree is being made',
    );
    // The user stops the chat: its turn ends stopped, and its waiting work is cancelled.
    api.endWaitingTasks('chat', true);
    release();
    await settle();
    assert.equal(replies.length, 1);
    assert.equal(replies[0][2], true);
    assert.match(replies[0][1], /stopped before its worker started/);
    assert.equal(workspace.sessions.length, 1, 'no worker chat is added');
    assert.equal(
        invoked.filter(([command]) => command === 'worktree_remove').length,
        1,
        'the worktree made for the stopped call is removed',
    );
});
