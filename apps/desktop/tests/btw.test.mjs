import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { btwQuestionOf } from '../src/lib/chat/session/btw-command.ts';
import * as taskHelpers from '../src/lib/tasks/delegate-task.ts';
import { planTask } from '../src/lib/tasks/delegate-plan.ts';

/** A parent chat on `agent`, and the stubs `btw.svelte.ts` reaches through its imports. */
async function setup(agent = 'claude', saved = {}, extra = {}) {
    const parent = {
        id: 'chat',
        agent,
        model: 'model',
        status: 'idle',
        projectId: 'project',
        gitBranch: 'main',
        draft: false,
        made: true,
    };
    const workspace = { activeId: 'chat', sessions: [parent], projects: [] };
    const localMessages = { chat: [] };
    const chatTurnOptions = { chat: { permission: 'auto', effort: 'high' } };
    const sent = [];
    const stops = [];
    const api = await load('btw', {
        workspace,
        localMessages,
        chatTurnOptions,
        send: (...args) => sent.push(args),
        stopTurn: (...args) => stops.push(args),
        askText: () => '',
        messagesView: () => [],
        btwQuestionOf,
        getPref: async (key) => saved[key],
        setPref: async (key, value) => {
            saved[key] = value;
        },
        ...extra,
    });
    return { api, workspace, chatTurnOptions, sent, stops, saved };
}

test('R4.1: a /btw side chat of Claude runs in plan mode (read-only), with the parent effort', async () => {
    const { api, chatTurnOptions, sent } = await setup('claude');
    const result = api.askBtw('chat', 'what does this do?');
    assert.equal(result.ok, true);
    const sideId = result.side.id;
    assert.equal(chatTurnOptions[sideId]?.permission, 'plan');
    assert.equal(chatTurnOptions[sideId]?.effort, 'high');
    assert.equal(sent.length, 1);
});

test('R4.1: /btw on a non-Claude chat is refused and starts no side chat', async () => {
    for (const agent of ['codex', 'copilot', 'custom']) {
        const { api, workspace, sent } = await setup(agent);
        const result = api.askBtw('chat', 'hi');
        assert.equal(result.ok, false, agent);
        assert.match(result.error, /Claude/, agent);
        assert.equal(sent.length, 0, agent);
        assert.equal(
            workspace.sessions.some((item) => item.side),
            false,
            agent,
        );
    }
});

/** A delegate module whose caller is `caller`; `onDelegateCall` is the entry the Rust bridge calls. */
async function delegateCaller(caller) {
    const replies = [];
    const invoked = [];
    const api = await load('delegate-task', {
        ...taskHelpers,
        planTask,
        elapsed: (ms) => `${ms} ms`,
        workspace: { activeId: 'chat', sessions: [caller], projects: [] },
        getPref: async () => null,
        setPref() {},
        persistLocal() {},
        logFlow() {},
        hasTurnWork: () => false,
        inTauri: () => false,
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
        invoke: async (...args) => {
            invoked.push(args);
            throw new Error('no invoke expected');
        },
        releaseWorkerSlot: async () => {},
        stopTurn() {},
        updateWorkflowWorker() {},
        settleWorkflowRun() {},
        taskWaiters: new Map(),
    });
    return { api, replies, invoked };
}

test('R4.2: a side chat cannot delegate, with or without a worktree', async () => {
    const side = {
        id: 'side',
        agent: 'claude',
        model: 'model',
        status: 'idle',
        projectId: 'project',
        side: { parentId: 'chat', question: 'q' },
    };
    for (const args of [
        { agent: 'claude', task: 'write the file' },
        { agent: 'claude', task: 'write the file', isolation: 'worktree' },
    ]) {
        const { api, replies, invoked } = await delegateCaller(side);
        api.onDelegateCall({
            callId: 'c1',
            caller: 'side',
            tool: 'delegate_task',
            args,
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(replies.length, 1);
        assert.equal(replies[0][2], true);
        assert.match(replies[0][1], /side chats cannot delegate/);
        assert.equal(invoked.length, 0, 'no worktree is created');
        assert.deepEqual(Object.keys(api.delegateTasks), []);
    }
});

test('R4.3: closing a side chat stops its run before it is removed, and a new /btw does the same', async () => {
    const { api, workspace, sent, stops } = await setup('claude');
    const first = api.askBtw('chat', 'first?').side;
    api.dropSide('chat');
    assert.deepEqual(
        stops.map(([id]) => id),
        [first.id],
        'closing stops the side chat',
    );
    assert.equal(
        workspace.sessions.some((item) => item.side),
        false,
    );
    const second = api.askBtw('chat', 'second?').side;
    api.askBtw('chat', 'third?');
    assert.deepEqual(
        stops.map(([id]) => id),
        [first.id, second.id],
        'a new /btw stops the one it replaces',
    );
    assert.equal(sent.length, 3);
});

test('R4.4: the transcript of a closed side chat is ignored by history, also after a restart', async () => {
    const { api, sent, stops, saved } = await setup('claude');
    const side = api.askBtw('chat', 'q').side;
    api.dropSide('chat');
    await api.btwIgnoredReady;
    const key = `claude:${side.agentSession}`;
    assert.equal(api.isBtwTranscript(key), true);
    assert.equal(api.isBtwTranscript('claude:someone-else'), false);
    // Arrays made inside the loaded module come from its own realm: compare copies.
    assert.deepEqual(Array.from(saved['btw.ignored']), [key]);
    assert.equal(sent.length, 1);
    assert.equal(stops.length, 1);
    // A later start (a new load of the module) reads the same list back.
    const later = await setup('claude', { ...saved });
    await later.api.btwIgnoredReady;
    assert.equal(later.api.isBtwTranscript(key), true);
});

test('R4.5: the /btw snapshot reads the parent through messagesView, not only localMessages', async () => {
    const parentMessages = [
        { role: 'user', blocks: [], text: 'earlier question' },
        { role: 'assistant', blocks: [], text: 'earlier answer' },
    ];
    const { api, sent } = await setup(
        'claude',
        {},
        {
            // The chat's messages live in messagesById while it is open; localMessages is empty.
            messagesView: (id) => (id === 'chat' ? parentMessages : []),
            askText: (message) => message.text,
        },
    );
    api.askBtw('chat', 'and now?');
    const prompt = sent[0][1];
    assert.match(prompt, /User: earlier question/);
    assert.match(prompt, /Assistant: earlier answer/);
});

test('R6.3: the /btw snapshot leaves out a reply still streaming, and keeps the newest turns within its budget', async () => {
    const body = 'x'.repeat(900);
    const turns = Array.from({ length: 30 }, (_, index) => {
        const text = `turn ${index} ${body}`;
        return {
            role: index % 2 ? 'assistant' : 'user',
            blocks: [{ kind: 'response', text }],
            text,
        };
    });
    turns.push({
        role: 'assistant',
        blocks: [{ kind: 'response', text: 'partial answer', streaming: true }],
        text: 'partial answer',
    });
    const { api, sent } = await setup(
        'claude',
        {},
        {
            messagesView: (id) => (id === 'chat' ? turns : []),
            askText: (message) => message.text,
        },
    );
    api.askBtw('chat', 'and now?');
    const prompt = sent[0][1];
    assert.doesNotMatch(prompt, /partial answer/);
    // The newest finished turn is kept, the oldest is cut (the budget is CONTEXT_CHARS, 12000).
    assert.match(prompt, /turn 29 /);
    assert.doesNotMatch(prompt, /turn 0 /);
    assert.ok(prompt.length < 13000, `${prompt.length} characters`);
});
