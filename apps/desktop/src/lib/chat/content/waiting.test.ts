// Run with: node --test src/lib/chat/content/waiting.test.ts
// While a reply waits for a background task of the provider (a sub agent still running), the live line says so, instead
// of "Thinking". These tests pin the wording and the cases where the line stays as it was.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    backgroundTaskName,
    openBackgroundTasks,
    waitingLabel,
} from './blocks.ts';
import type { Block } from '../mock.ts';

const done: Block = { kind: 'response', text: 'Checking.', streaming: false };
const streaming: Block = { kind: 'response', text: 'Chec', streaming: true };
const thinking: Block = { kind: 'thinking', text: 'hm', streaming: true };
const running: Block = {
    kind: 'command',
    id: 'c1',
    command: 'Bash sleep 60',
    output: '',
    status: 'running',
};
const open = [{ name: 'codex:codex-rescue' }];

test('one open background task: the label names it', () => {
    assert.equal(
        waitingLabel([done], open),
        'Waiting for 1 background task · codex:codex-rescue',
    );
});

test('no block yet, one open background task: the label still shows', () => {
    assert.equal(
        waitingLabel([], open),
        'Waiting for 1 background task · codex:codex-rescue',
    );
});

test('two open background tasks: plural, no names', () => {
    assert.equal(
        waitingLabel(
            [done],
            [{ name: 'explore' }, { name: 'codex:codex-rescue' }],
        ),
        'Waiting for 2 background tasks',
    );
});

test('the answer is still streaming text: no waiting label', () => {
    assert.equal(waitingLabel([streaming], open), null);
});

test('reasoning is still streaming: no waiting label', () => {
    assert.equal(waitingLabel([thinking], open), null);
});

test('a foreground command is running: no waiting label', () => {
    assert.equal(waitingLabel([done, running], open), null);
});

test('no open background task: no waiting label', () => {
    assert.equal(waitingLabel([done], []), null);
    assert.equal(waitingLabel([], []), null);
});

test('backgroundTaskName: subagent_type first, then description, then the tool name', () => {
    assert.equal(
        backgroundTaskName({
            name: 'Agent',
            input: '{"description":"Look","subagent_type":"codex:codex-rescue"}',
        }),
        'codex:codex-rescue',
    );
    assert.equal(
        backgroundTaskName({ name: 'Agent', input: '{"description":"Look"}' }),
        'Look',
    );
    assert.equal(
        backgroundTaskName({ name: 'Bash', input: 'not json' }),
        'Bash',
    );
});

const activityItem = (
    over: Partial<{
        sessionId: string;
        background: boolean;
        status: string;
        name: string;
        input: string;
    }>,
) => ({
    sessionId: 'chat-1',
    background: true,
    status: 'running',
    name: 'Agent',
    input: '{"subagent_type":"codex:codex-rescue"}',
    ...over,
});

test('openBackgroundTasks: only running background tasks of this chat', () => {
    const items = [
        activityItem({}),
        activityItem({ status: 'background' }),
        activityItem({ status: 'ok' }),
        activityItem({ background: false }),
        activityItem({ sessionId: 'chat-2' }),
    ];
    assert.deepEqual(openBackgroundTasks(items, 'chat-1'), [
        { name: 'codex:codex-rescue' },
        { name: 'codex:codex-rescue' },
    ]);
    assert.deepEqual(openBackgroundTasks([], 'chat-1'), []);
});

test('a finished background task no longer holds the reply: no waiting label', () => {
    const items = [activityItem({ status: 'ok' })];
    assert.equal(
        waitingLabel([done], openBackgroundTasks(items, 'chat-1')),
        null,
    );
});

test('the reply waits for a background task of its chat: the label names it', () => {
    const items = [activityItem({})];
    assert.equal(
        waitingLabel([done], openBackgroundTasks(items, 'chat-1')),
        'Waiting for 1 background task · codex:codex-rescue',
    );
});
