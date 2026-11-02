import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { btwQuestionOf } from '../src/lib/chat/session/btw-command.ts';

/** A parent chat on `agent`, and the stubs `btw.svelte.ts` reaches through its imports. */
async function setup(agent = 'claude') {
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
        btwQuestionOf,
    });
    return { api, workspace, chatTurnOptions, sent, stops };
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
