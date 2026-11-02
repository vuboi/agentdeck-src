// R3 (plan_refactor.md): chat flow state machine. Run with the node test command from plan_fix.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';

const report = {
    taskId: 't1',
    sourceMessageId: 'm1',
    sourceTask: 'task',
    label: 'worker',
    text: 'result',
};

/** A delegate-task module with the chat's collaborators stubbed; `sent` records every hand-back send. */
async function delegateWith({ owed }) {
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
    });
    return { api, sent };
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
