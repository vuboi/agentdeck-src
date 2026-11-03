// Run with: node --experimental-strip-types --test src/lib/chat/session/send-while-waiting.test.ts
// The rule for sending while a Claude chat waits for its own background work (plan_wait_send, W3).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canSendWhileWaiting,
    hasOpenBackgroundWork,
    type WaitState,
} from './send-while-waiting.ts';

const waiting: WaitState = {
    agent: 'claude',
    whileRunning: 'queue',
    foregroundTurn: false,
    streamingText: false,
    backgroundWorkOpen: true,
    needsUserInput: false,
};

test('a Claude chat that only waits for its background work takes the message', () => {
    assert.equal(canSendWhileWaiting(waiting), true);
});

test('other agents keep the queue', () => {
    for (const agent of [
        'codex',
        'copilot',
        'antigravity',
        'opencode',
        'custom',
        undefined,
    ])
        assert.equal(
            canSendWhileWaiting({ ...waiting, agent }),
            false,
            String(agent),
        );
});

test('nothing is sent around the queue without background work of its own', () => {
    assert.equal(
        canSendWhileWaiting({ ...waiting, backgroundWorkOpen: false }),
        false,
    );
});

test('a foreground answer in progress keeps the queue', () => {
    assert.equal(
        canSendWhileWaiting({ ...waiting, foregroundTurn: true }),
        false,
    );
});

test('text being written keeps the queue', () => {
    assert.equal(
        canSendWhileWaiting({ ...waiting, streamingText: true }),
        false,
    );
});

test('a pending question or permission keeps the queue', () => {
    assert.equal(
        canSendWhileWaiting({ ...waiting, needsUserInput: true }),
        false,
    );
});

test('Ctrl/Cmd+Enter and Alt+Enter keep their own rules', () => {
    assert.equal(
        canSendWhileWaiting({ ...waiting, whileRunning: 'interrupt' }),
        false,
    );
    assert.equal(
        canSendWhileWaiting({ ...waiting, whileRunning: 'next' }),
        false,
    );
});

test('open background work of this chat only, and a stopped task is not waited for', () => {
    const items = [
        { sessionId: 'a', background: true, status: 'background' },
        { sessionId: 'b', background: true, status: 'background' },
        { sessionId: 'a', background: true, status: 'stopped' },
        { sessionId: 'a', background: true, status: 'ok', endedAt: 5 },
        { sessionId: 'a', background: false, status: 'running' },
    ];
    assert.equal(hasOpenBackgroundWork(items, 'a'), true);
    assert.equal(hasOpenBackgroundWork(items, 'c'), false);
    assert.equal(
        hasOpenBackgroundWork(
            items.filter(
                (item) =>
                    item.sessionId === 'a' && item.status !== 'background',
            ),
            'a',
        ),
        false,
    );
});
