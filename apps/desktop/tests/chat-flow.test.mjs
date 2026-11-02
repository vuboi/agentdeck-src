// R3 (plan_refactor.md): chat flow state machine. Run with the node test command from plan_fix.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { updateHistoricalTask } from '../src/lib/chat/agent-reply.ts';
import { credentialScopeOf } from '../src/lib/chat/recovery/turn-failure.ts';
import { credentialScope } from '../src/lib/agents/credential-scope.ts';
import * as taskHelpers from '../src/lib/tasks/delegate-task.ts';

/** Lets the promise that answers a delegate call (and its fallback) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const report = {
    taskId: 't1',
    sourceMessageId: 'm1',
    sourceTask: 'task',
    label: 'worker',
    text: 'result',
};

/**
 * A delegate-task module with the chat's collaborators stubbed. `sent` records every hand-back send. `delivered` is what
 * replyDelegateCall answers: false when the caller's call is no longer waiting, so a report would fall back to the backlog.
 */
async function delegateWith({
    owed = false,
    delivered = true,
    prefs = {},
} = {}) {
    const session = {
        id: 'chat',
        title: 'Chat',
        agent: 'claude',
        model: 'model',
        status: 'idle',
        projectId: 'project',
    };
    const sent = [];
    const replies = [];
    const api = await load('delegate-task', {
        ...taskHelpers,
        elapsed: (ms) => `${ms} ms`,
        workspace: { activeId: 'chat', sessions: [session], projects: [] },
        getPref: async (key) => prefs[key] ?? null,
        setPref() {},
        persistLocal() {},
        logFlow() {},
        hasTurnWork: () => false,
        inTauri: () => false,
        owesTurn: () => owed,
        queued: {},
        queuePaused: {},
        send: (...args) => sent.push(args),
        sendNextQueued() {},
        handbackPrompt: () => 'handback',
        NO_HANDOUT: {},
        replyDelegateCall: async (...args) => {
            replies.push(args);
            return delivered;
        },
        releaseWorkerSlot: async () => {},
        stopTurn() {},
        failSessionWork() {},
        updateWorkflowWorker() {},
        settleWorkflowRun() {},
        taskWaiters: new Map(),
    });
    return { api, sent, replies };
}

/** A running wait=true task of the chat, as startTask leaves it. */
function runningWaitTask(api) {
    api.delegateTasks.t1 = {
        id: 't1',
        childId: 'child',
        caller: 'chat',
        wait: true,
        label: 'worker',
        task: 'Original request',
        sourceMessageId: 'm1',
        sourceTask: 'Original request',
        state: 'running',
        startedAt: 0,
        reportState: 'running',
    };
    api.taskRuns.set('t1', {
        callId: 'call-1',
        timeoutS: 60,
        remainingMs: 0,
        deadline: 0,
    });
}

// ---------- R3.1: a held hand-back must not take over the failed turn owed a retry ----------

test('R3.1: flushReports sends nothing while a failed turn is owed a retry, and keeps the report', async () => {
    const { api, sent } = await delegateWith({ owed: true });
    api.backlog.set('chat', [report]);
    api.flushReports('chat');
    assert.equal(sent.length, 0, 'hand-back must wait for the retry');
    assert.deepEqual(api.backlog.get('chat'), [report]);
});

test('R3.1: once nothing is owed, flushReports delivers the held report', async () => {
    const { api, sent } = await delegateWith({ owed: false });
    api.backlog.set('chat', [report]);
    api.flushReports('chat');
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'chat');
});

// ---------- R3.2: no report after the caller was stopped or the task was aborted ----------

test('R3.2: stopping the caller ends its wait task without any report to it', async () => {
    const { api } = await delegateWith({ delivered: false });
    runningWaitTask(api);
    api.endWaitingTasks('chat', true);
    await settle();
    assert.equal(api.taskRuns.has('t1'), false, 'the task ended');
    assert.equal(api.backlog.get('chat')?.length ?? 0, 0);
});

// D-B (plan_next.md): a task that ends without a user stop (its connection lost, or its caller ended the turn normally)
// still reports to its caller, through the backlog when nobody waits for the call any more.
test('D-B: a task aborted when its caller ends its turn keeps its report in the caller backlog', async () => {
    const { api } = await delegateWith({ delivered: false });
    runningWaitTask(api);
    api.endWaitingTasks('chat', false);
    await settle();
    assert.equal(api.taskRuns.has('t1'), false, 'the task ended');
    const held = api.backlog.get('chat') ?? [];
    assert.equal(held.length, 1, 'exactly one report');
    assert.equal(held[0].taskId, 't1');
});

test('D-B: the user stopping the task itself leaves no report anywhere', async () => {
    const { api } = await delegateWith({ delivered: false });
    runningWaitTask(api);
    api.stopDelegateTask('t1');
    await settle();
    assert.equal(api.taskRuns.has('t1'), false, 'the task ended');
    assert.equal(api.backlog.get('chat')?.length ?? 0, 0);
});

// N1.1: a timed-out task gives its caller one notice: the waiting call if it still waits, else the backlog.
test('N1.1: a timed-out task answers its waiting call and adds nothing to the backlog', async () => {
    const { api, replies } = await delegateWith({ delivered: true });
    runningWaitTask(api);
    api.finishTask('t1', 'timed out', 'timed out', '');
    await settle();
    assert.equal(replies.length, 1, 'one reply to the call');
    assert.equal(api.backlog.get('chat')?.length ?? 0, 0);
});

test('N1.1: a timed-out task whose call is gone leaves exactly one report in the backlog', async () => {
    const { api, replies } = await delegateWith({ delivered: false });
    runningWaitTask(api);
    api.finishTask('t1', 'timed out', 'timed out', '');
    await settle();
    assert.equal(replies.length, 1, 'the reply was refused');
    assert.equal(api.backlog.get('chat')?.length, 1, 'one notice, not two');
});

// ---------- R3.3: a picker change made during a turn applies when the chat's turns end ----------

async function eventsWith(pending) {
    const session = {
        id: 'chat',
        title: 'Chat',
        agent: 'claude',
        model: 'old-model',
        status: 'idle',
        projectId: 'project',
    };
    const calls = { persist: 0, cancelAutoSwitch: 0 };
    const api = await load('events', {
        workspace: { activeId: 'chat', sessions: [session], projects: [] },
        pendingSwitch: pending,
        persistLocal: () => calls.persist++,
        cancelAutoSwitch: () => calls.cancelAutoSwitch++,
        getPref: async () => null,
        setPref() {},
        logFlow() {},
        inTauri: () => false,
    });
    return { api, session, calls };
}

test('R3.3: the pick made during the turn is applied once the turns end, and the pending entry is removed', async () => {
    const pending = { chat: { agent: 'codex', model: 'gpt-next' } };
    const { api, session, calls } = await eventsWith(pending);
    api.applyPendingSwitch('chat');
    assert.equal(session.agent, 'codex');
    assert.equal(session.model, 'gpt-next');
    assert.equal(pending.chat, undefined);
    assert.equal(calls.persist, 1, 'the applied route is saved');
    assert.equal(
        calls.cancelAutoSwitch,
        0,
        'applying a model does not cancel an account switch',
    );
});

// ---------- R3.4: a card drawn from history that already ended is not reopened by a late event ----------

test('R3.4: a historical card that ended stays ended when a late progress event arrives', () => {
    const messages = [
        {
            id: 'old',
            role: 'assistant',
            time: '',
            blocks: [
                {
                    kind: 'command',
                    id: 'agent1',
                    name: 'Agent',
                    input: 'scan',
                    background: true,
                    task: {
                        status: 'done',
                        label: 'Scan',
                        startedAt: 1,
                        endedAt: 2,
                    },
                },
            ],
        },
    ];
    const late = {
        kind: 'task',
        id: 'task-1',
        tool_use_id: 'agent1',
        status: 'progress',
        label: 'Scan',
    };
    assert.equal(updateHistoricalTask(messages, late), true);
    assert.equal(messages[0].blocks[0].task.status, 'done');
    assert.equal(messages[0].blocks[0].task.endedAt, 2);
});

// ---------- R3.8: one rule for the credential of a route ----------

test("R3.8: credentialScopeOf names a custom provider's credential, the same as credentialScope", () => {
    assert.equal(credentialScopeOf('custom|p::m'), 'custom:p');
    assert.equal(credentialScopeOf('custom|plain'), 'custom');
    assert.equal(credentialScopeOf('antigravity|x'), 'agy');
    assert.equal(credentialScopeOf('codex|gpt'), 'codex');
    assert.equal(
        credentialScopeOf('custom|p::m'),
        credentialScope('custom', 'p::m'),
    );
});

// ---------- R3.7: one "recovering" note per recovery; watchdog notes are not restored after a reload ----------

test('R3.7: three recoveries of one worker leave one "recovering" note in the backlog', async () => {
    const { api } = await delegateWith();
    api.delegateTasks.t1 = {
        id: 't1',
        childId: 'child',
        caller: 'chat',
        wait: false,
        label: 'worker',
        task: 'Original request',
        sourceMessageId: 'm1',
        sourceTask: 'Original request',
        state: 'running',
        startedAt: 0,
        reportState: 'running',
    };
    api.taskRuns.set('t1', { timeoutS: 60, remainingMs: 0, deadline: 0 });
    // Each recovery comes later than the one before (the ids used to carry a timestamp: the test must not rely on that).
    for (let attempt = 0; attempt < 3; attempt++) {
        api.noteWorkerRecovering('child', 'the CLI failed');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(api.backlog.get('chat')?.length, 1);
});

test('R3.7: a reload drops the watchdog notes from the restored backlog and keeps the reports', async () => {
    const saved = [
        [
            'chat',
            [
                {
                    taskId: 't1#recover',
                    sourceMessageId: 'm1',
                    sourceTask: 'a',
                    label: 'w',
                    text: 'recovering',
                },
                {
                    taskId: 't1#check2',
                    sourceMessageId: 'm1',
                    sourceTask: 'a',
                    label: 'w',
                    text: 'progress',
                },
                {
                    taskId: 't1',
                    sourceMessageId: 'm1',
                    sourceTask: 'a',
                    label: 'w',
                    text: 'done',
                },
            ],
        ],
    ];
    const { api } = await delegateWith({
        prefs: { 'delegate.backlog': saved },
    });
    await settle();
    assert.deepEqual(
        api.backlog.get('chat').map((item) => item.taskId),
        ['t1'],
    );
});
