// R3 (plan_refactor.md): chat flow state machine. Run with the node test command from plan_fix.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { updateHistoricalTask } from '../src/lib/chat/agent-reply.ts';
import { credentialScopeOf } from '../src/lib/chat/recovery/turn-failure.ts';
import { credentialScope } from '../src/lib/agents/credential-scope.ts';
import * as taskHelpers from '../src/lib/tasks/delegate-task.ts';
import { planTask } from '../src/lib/tasks/delegate-plan.ts';

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
    notes = {},
} = {}) {
    const pumps = [];
    const waiters = new Map();
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
        planTask,
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
        sendNextQueued: (id) => pumps.push(id),
        hasCoordinationPrompt: (id) => (notes[id]?.length ?? 0) > 0,
        queueCoordinationPrompt: (id, item) => (notes[id] ??= []).push(item),
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
        taskWaiters: waiters,
    });
    return { api, sent, replies, pumps, notes, waiters };
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

// ---------- team notes: a worker's first report survives the note turns that follow it ----------

test('team notes: the first report waits for the note turns and settles once none is left', async () => {
    const notes = { child: [{ prompt: 'note from a teammate' }] };
    const { api, pumps, waiters } = await delegateWith({ notes });
    runningWaitTask(api);
    // What settle keeps when its turn ends while a note is queued.
    api.taskRuns.get('t1').report = { answer: 'first report' };
    const ended = [];
    waiters.set('child', (...args) => ended.push(args));
    // The note turn ends and no note is left: the first report is settled, once.
    notes.child = [];
    api.teamNoteDone('child');
    assert.deepEqual(pumps, []);
    assert.equal(ended.length, 1);
    assert.deepEqual(ended[0], ['first report', null, undefined]);
    assert.equal(waiters.has('child'), false);
});

test('team notes: a note turn that leaves another note queued starts it and keeps the report waiting', async () => {
    const notes = { child: [{ prompt: 'second note' }] };
    const { api, pumps, waiters } = await delegateWith({ notes });
    runningWaitTask(api);
    api.taskRuns.get('t1').report = { answer: 'first report' };
    const ended = [];
    waiters.set('child', (...args) => ended.push(args));
    api.teamNoteDone('child');
    assert.deepEqual(pumps, ['child']);
    assert.equal(ended.length, 0);
    assert.equal(waiters.has('child'), true);
});

test('team notes: a note that ran while the worker was paused leaves its real end to come', async () => {
    const { api, waiters } = await delegateWith();
    runningWaitTask(api);
    const ended = [];
    waiters.set('child', (...args) => ended.push(args));
    api.teamNoteDone('child');
    assert.equal(ended.length, 0);
    assert.equal(waiters.has('child'), true);
});

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
    const calls = { persist: 0, cancelAutoSwitch: 0, remember: 0 };
    const api = await load('events', {
        // events.svelte.ts registers its save listener when it loads: the ledger is not under test here.
        onUserFileSave() {},
        workspace: { activeId: 'chat', sessions: [session], projects: [] },
        pendingSwitch: pending,
        persistLocal: () => calls.persist++,
        cancelAutoSwitch: () => calls.cancelAutoSwitch++,
        rememberMixed: () => calls.remember++,
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

// ---------- R3.6 (D-A, plan_next.md): a saved model that is no longer offered blocks the send; it is never swapped ----------

const { creditModel: realCreditModel } =
    await import('../src/lib/agents/credit-model.ts');

/** The turns module with the catalogue given: `chatModel`, `modelFor`, `effortFor` are the real ones. */
async function loadTurns({ catalogue = {}, ready = {}, sessions = [] } = {}) {
    return load('turns', {
        getPref: async () => null,
        setPref() {},
        inTauri: () => false,
        creditModel: realCreditModel,
        MODELS: catalogue,
        modelsReady: ready,
        findModel: (agent, value) =>
            (catalogue[agent] ?? []).find((item) => item.value === value),
        customProviderName: () => undefined,
        workspace: { activeId: null, sessions, projects: [] },
    });
}

const claudeCatalogue = {
    claude: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5' },
        { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ],
};

/** The run module, for startTurn and prewarmChat, with a chat and its catalogue. Records what reaches the CLI. */
async function runWith(
    session,
    { catalogue = claudeCatalogue, ready = { claude: true } } = {},
) {
    const turns = await loadTurns({ catalogue, ready });
    const calls = { custom: [], agent: [], prewarm: [] };
    const localMessages = {};
    const run = await load('run', {
        accountEpochsLoaded: true,
        accountEpochsReady: Promise.resolve(),
        inTauri: () => true,
        credentialBusy: () => false,
        credentialScope: credentialScope,
        isRunning: () => false,
        workspace: { activeId: null, sessions: [session], projects: [] },
        MODELS: catalogue,
        modelsReady: ready,
        chatModel: turns.chatModel,
        modelFor: turns.modelFor,
        effortFor: turns.effortFor,
        firstAgentOf: turns.firstAgentOf,
        messagesById: new Map(),
        localMessages,
        chat: { messages: [] },
        mockMessages: [],
        setMessages() {},
        persistLocal() {},
        nextId: () => 'id',
        clock: () => '00:00',
        SvelteDate: Date,
        logFlow() {},
        turnOptionsOf: () => ({ permission: 'ask', effort: 'medium' }),
        PERMISSION_MODE: {},
        approved: {},
        sessionCwd: () => '/project',
        liveModel: () => false,
        accountEpoch: {},
        sendCustomTurn: (args) => calls.custom.push(args),
        sendAgentTurn: (args) => calls.agent.push(args),
        prewarmAgent: async (args) => {
            calls.prewarm.push(args);
        },
    });
    return { run, turns, calls, localMessages };
}

test('R3.6: pickModel keeps a listed model, takes the first when none is saved, and names a missing one', async () => {
    const turns = await loadTurns();
    const list = [{ value: 'a' }, { value: 'b' }];
    // The module runs in its own realm: results are compared as plain JSON.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(turns.pickModel('b', list)), { model: 'b' });
    assert.deepEqual(plain(turns.pickModel(undefined, list)), { model: 'a' });
    assert.deepEqual(plain(turns.pickModel('gone', list)), { missing: 'gone' });
    assert.deepEqual(plain(turns.pickModel('gone', [])), { missing: 'gone' });
});

test('R3.6: a listed saved model is what the chat runs on, and its effort is kept', async () => {
    const session = { id: 'chat', agent: 'claude', model: 'claude-haiku-5-5' };
    const { turns } = await runWith(session);
    assert.deepEqual(JSON.parse(JSON.stringify(turns.chatModel(session))), {
        model: 'claude-haiku-5-5',
    });
    assert.equal(turns.modelFor(session), 'claude-haiku-5-5');
});

test('R3.6: a chat whose saved model is gone is not sent: the chat says why, and no CLI is started', async () => {
    const session = { id: 'chat', agent: 'claude', model: 'claude-removed-9' };
    const { run, calls, localMessages } = await runWith(session);
    run.startTurn(session, 'hello');
    assert.equal(calls.agent.length, 0, 'sendAgentTurn was not called');
    assert.equal(calls.custom.length, 0, 'sendCustomTurn was not called');
    const said = localMessages.chat.at(-1);
    assert.equal(said.role, 'assistant');
    assert.equal(
        said.blocks[0].text,
        'The model claude-removed-9 is no longer available. Pick a model.',
    );
});

test('R3.6: a chat whose saved model is gone is not prewarmed, and its effort is null', async () => {
    const session = {
        id: 'chat',
        agent: 'claude',
        firstAgent: 'claude',
        model: 'claude-removed-9',
    };
    const { run, turns, calls } = await runWith(session);
    run.prewarmChat('chat');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        calls.prewarm.length,
        0,
        'no CLI is started for a missing model',
    );
    assert.equal(turns.effortFor(session), null);
});

test('R3.6: a custom provider deleted under a chat that used its model blocks the send', async () => {
    const session = {
        id: 'chat',
        agent: 'custom',
        model: 'custom|providerA::m1',
    };
    const { run, calls } = await runWith(session, {
        catalogue: { custom: [{ value: 'custom|providerB::m2', label: 'm2' }] },
        ready: { custom: true },
    });
    run.startTurn(session, 'hello');
    assert.equal(calls.custom.length, 0, 'sendCustomTurn was not called');
});

// R3.3 (plan_next.md): the picker's route change is made in one place, applyPendingSwitch, at once or when the turn ends.

test('R3.3: a route applied from the picker lists the agent the chat has had, and remembers the chat', async () => {
    const pending = { chat: { agent: 'codex', model: 'gpt-next' } };
    const { api, session, calls } = await eventsWith(pending);
    api.applyPendingSwitch('chat');
    // The module runs in its own realm: the list is compared as JSON.
    assert.equal(JSON.stringify(session.agents), '["claude","codex"]');
    assert.equal(calls.remember, 1, 'the chat is remembered with its agents');
    assert.equal(session.agent, 'codex');
});

test('R3.3: a pick made during a retry applies when the retry is stopped', async () => {
    const pending = { chat: { agent: 'codex', model: 'gpt-next' } };
    const { api, session } = await eventsWith(pending);
    api.stopOwedTurn('chat');
    assert.equal(session.agent, 'codex');
    assert.equal(session.model, 'gpt-next');
    assert.equal(pending.chat, undefined, 'the pending pick is used up');
});

// R3.8 (plan_next.md): one rule for the chat's first agent, and for the conversation a turn forgets.

test('R3.8: firstAgentOf names the agent of the first conversation, whichever field keeps it', async () => {
    const turns = await loadTurns();
    assert.equal(
        turns.firstAgentOf({ agent: 'codex', firstAgent: 'claude' }),
        'claude',
    );
    assert.equal(
        turns.firstAgentOf({ agent: 'codex', source: 'claude' }),
        'claude',
    );
    assert.equal(
        turns.firstAgentOf({ agent: 'codex', agents: ['claude', 'codex'] }),
        'claude',
    );
    assert.equal(turns.firstAgentOf({ agent: 'codex' }), 'codex');
});

test('R3.8: forgetUnstartedConversation keeps a started conversation and drops an unstarted one', async () => {
    const session = {
        id: 'chat',
        agent: 'claude',
        firstAgent: 'claude',
        agentSession: 's1',
        agentStarted: false,
        agentIds: {
            codex: { id: 'c1', started: false },
            antigravity: { id: 'a1', started: true },
        },
    };
    const turns = await loadTurns({ sessions: [session] });
    turns.forgetUnstartedConversation('chat');
    assert.equal(
        session.agentSession,
        undefined,
        'the unstarted first conversation is forgotten',
    );
    assert.equal(session.agentStarted, false);

    session.agentSession = 's2';
    session.agentStarted = true;
    turns.forgetUnstartedConversation('chat');
    assert.equal(session.agentSession, 's2', 'a started conversation is kept');

    turns.forgetUnstartedConversation('chat', 'codex');
    assert.equal(
        session.agentIds.codex,
        undefined,
        'an unstarted other conversation is dropped',
    );
    turns.forgetUnstartedConversation('chat', 'antigravity');
    assert.equal(
        session.agentIds.antigravity?.id,
        'a1',
        'a started other conversation is kept',
    );
});
