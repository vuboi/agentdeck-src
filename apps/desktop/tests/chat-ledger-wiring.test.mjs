import assert from 'node:assert/strict';
import test from 'node:test';
import { historyWith, tick } from './support/history-harness.mjs';

/** A ledger that records what the app asks it to do. */
function recorder() {
    const calls = [];
    return {
        calls,
        recordTurn: (chat, messages, outcome) =>
            calls.push(['recordTurn', chat.id, messages.length, outcome]),
        bindNative: (chat, provider, nativeId) =>
            calls.push(['bindNative', chat.id, provider, nativeId]),
        remove: (id) => calls.push(['remove', id]),
        shadowRead: (id, count) => calls.push(['shadowRead', id, count]),
    };
}

const session = (extra = {}) => ({
    id: 'chat',
    title: 'Chat',
    projectId: 'p1',
    agent: 'claude',
    agents: ['claude', 'codex'],
    model: 'claude-sonnet-5-5',
    agentSession: 'C1',
    agentIds: { codex: { id: 'T2' } },
    draft: false,
    status: 'idle',
    ...extra,
});

const providerState = {
    chat: {
        agent: 'claude',
        agents: ['claude', 'codex'],
        source: 'claude',
        firstAgent: 'claude',
        agentSession: 'C1',
        agentIds: { codex: { id: 'T2' } },
        providerAliases: ['claude:C1', 'codex:T2'],
    },
};

const bindings = (rec) => rec.calls.filter((call) => call[0] === 'bindNative');

test('N5.1 wiring: flag off, saving a chat provider state binds nothing in the ledger', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        mixed: structuredClone(providerState),
        sessions: [session()],
        ledger: rec,
        ledgerOn: false,
    });
    api.rememberMixed(workspace.sessions[0]);
    await tick();
    assert.deepEqual(rec.calls, []);
});

test('N5.1 wiring: flag on, saving the provider state offers each native session of the chat to the ledger', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        mixed: structuredClone(providerState),
        sessions: [session()],
        ledger: rec,
    });
    api.rememberMixed(workspace.sessions[0]);
    await tick();
    // The writer sends each binding once (dual-write.test.ts); here the app only offers them.
    assert.deepEqual(bindings(rec), [
        ['bindNative', 'chat', 'claude', 'C1'],
        ['bindNative', 'chat', 'codex', 'T2'],
    ]);
});

test('N5.1 wiring: a draft has no native session yet, so nothing is bound', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        mixed: structuredClone(providerState),
        sessions: [session({ draft: true })],
        ledger: rec,
    });
    api.rememberMixed(workspace.sessions[0]);
    await tick();
    assert.deepEqual(bindings(rec), []);
});

test('N5.2 wiring: opening a chat that is shown whole counts it in the ledger', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        sessions: [session({ agentSession: undefined, agentIds: undefined })],
        ledger: rec,
        messages: [
            { id: 'u1', blocks: [] },
            { id: 'a1', blocks: [] },
        ],
    });
    await api.openTranscript(workspace.sessions[0]);
    await tick();
    assert.deepEqual(
        rec.calls.filter((call) => call[0] === 'shadowRead'),
        [['shadowRead', 'chat', 2]],
    );
});

test('N5.2 wiring: flag off, opening a chat counts nothing', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        sessions: [session({ agentSession: undefined, agentIds: undefined })],
        ledger: rec,
        ledgerOn: false,
        messages: [{ id: 'u1', blocks: [] }],
    });
    await api.openTranscript(workspace.sessions[0]);
    await tick();
    assert.deepEqual(rec.calls, []);
});

test('N5.2 wiring: a reply still streaming is not counted yet', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        sessions: [session({ agentSession: undefined, agentIds: undefined })],
        ledger: rec,
        messages: [
            { id: 'u1', blocks: [] },
            { id: 'a1', blocks: [], live: true },
        ],
    });
    await api.openTranscript(workspace.sessions[0]);
    await tick();
    assert.deepEqual(rec.calls, []);
});

test('N5.1 wiring: deleting a chat removes it from the ledger', async () => {
    const rec = recorder();
    const { api, workspace } = await historyWith({
        mixed: structuredClone(providerState),
        sessions: [session()],
        ledger: rec,
    });
    await api.deleteSession('chat');
    await tick();
    assert.deepEqual(
        rec.calls.filter((call) => call[0] === 'remove'),
        [['remove', 'chat']],
    );
    assert.equal(workspace.sessions.length, 0);
});
