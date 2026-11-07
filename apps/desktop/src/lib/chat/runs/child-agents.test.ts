import assert from 'node:assert/strict';
import test from 'node:test';
import { callChildBlocks, toChildAgent } from './child-agents.ts';
import type { ChatWork } from './chat-work.ts';

const base: ChatWork = {
    id: 'native:1',
    sessionId: 'parent',
    title: 'Review',
    state: 'running',
    kind: 'agent',
    startedAt: 1,
    detail: '',
};

test('a native sub agent maps to its tool call in the parent chat', () => {
    const agent = toChildAgent({
        ...base,
        callId: 'c1',
        sourceMessageId: 'm1',
        agent: 'claude',
    });
    assert.deepEqual(agent?.source, {
        type: 'call',
        messageId: 'm1',
        callId: 'c1',
    });
    assert.equal(agent?.parentId, 'parent');
    assert.equal(agent?.agent, 'claude');
});

test('a delegate child maps to its own chat, even when a call is also known', () => {
    const agent = toChildAgent({
        ...base,
        id: 'delegate:t1',
        childId: 'child9',
        callId: 'c1',
        sourceMessageId: 'm1',
    });
    assert.deepEqual(agent?.source, { type: 'session', sessionId: 'child9' });
});

test('work with no transcript to show is dropped', () => {
    assert.equal(toChildAgent({ ...base, callId: 'c1' }), null);
    assert.equal(toChildAgent({ ...base, sourceMessageId: 'm1' }), null);
});

test('a command stays out of the sub-agent views', () => {
    assert.equal(
        toChildAgent({
            ...base,
            kind: 'command',
            callId: 'c1',
            sourceMessageId: 'm1',
        }),
        null,
    );
});

test('state and stop flag carry over', () => {
    const agent = toChildAgent({
        ...base,
        state: 'done',
        canStop: false,
        endedAt: 9,
        childId: 'x',
    });
    assert.equal(agent?.state, 'done');
    assert.equal(agent?.canStop, false);
    assert.equal(agent?.endedAt, 9);
});

test('a call child transcript is the children of the matching tool call', () => {
    const messages = [
        {
            id: 'm1',
            blocks: [
                {
                    kind: 'command',
                    id: 'c0',
                    command: 'ls',
                    output: '',
                    status: 'ok',
                },
                {
                    kind: 'command',
                    id: 'c1',
                    command: 'agent',
                    output: '',
                    status: 'running',
                    children: [{ kind: 'response', text: 'step' }],
                },
            ],
        },
    ] as never[];
    assert.deepEqual(callChildBlocks(messages, 'm1', 'c1'), [
        { kind: 'response', text: 'step' },
    ]);
    assert.deepEqual(callChildBlocks(messages, 'm1', 'missing'), []);
    // The work row carries the id of the request the call answers, not of the reply that holds it.
    assert.deepEqual(callChildBlocks(messages, 'user-ask', 'c1'), [
        { kind: 'response', text: 'step' },
    ]);
});
