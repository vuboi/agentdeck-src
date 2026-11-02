// R3 (plan_refactor.md): chat flow state machine. Run with the node test command from plan_fix.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { updateHistoricalTask } from '../src/lib/chat/agent-reply.ts';
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
async function delegateWith({ owed = false, delivered = true } = {}) {
    const session = {
        id: 'chat',
        title: 'Chat',
        agent: 'claude',
        model: 'model',
        status: 'idle',
        projectId: 'project',
    };
    const sent = [];
    const api = await load('delegate-task', {
        ...taskHelpers,
        elapsed: (ms) => `${ms} ms`,
        workspace: { activeId: 'chat', sessions: [session], projects: [] },
        getPref: async () => null,
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
        replyDelegateCall: async () => delivered,
        releaseWorkerSlot: async () => {},
        stopTurn() {},
        updateWorkflowWorker() {},
        settleWorkflowRun() {},
        taskWaiters: new Map(),
    });
    return { api, sent };
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

test('R3.2: a task aborted with its caller leaves no report in the backlog', async () => {
    const { api } = await delegateWith({ delivered: false });
    runningWaitTask(api);
    api.endWaitingTasks('chat', false);
    await settle();
    assert.equal(api.taskRuns.has('t1'), false, 'the task ended');
    assert.equal(api.backlog.get('chat')?.length ?? 0, 0);
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
