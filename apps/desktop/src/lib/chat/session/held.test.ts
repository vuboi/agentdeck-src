import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../mock';
import { sameMessage, tailStart } from './held.ts';

const reply = (id: string, text: string, at?: string) =>
    ({
        id,
        role: 'assistant',
        at,
        blocks: [{ kind: 'response', text }],
    }) as unknown as Message;

test('the tail starts at the held copy of the first message the file holds', () => {
    const held = [reply('a', 'one'), reply('b', 'two'), reply('c', 'three')];
    assert.equal(tailStart(held, [reply('b', 'two'), reply('c', 'three')]), 1);
});

test('a live copy with another id is found by its words, nearest the end', () => {
    const held = [reply('x', 'same'), reply('live-1', 'same')];
    assert.equal(tailStart(held, [reply('file-9', 'same')]), 1);
});

test('no overlap with the file means the held list is not its tail', () => {
    const held = [reply('a', 'one')];
    assert.equal(tailStart(held, [reply('z', 'other')]), -1);
    assert.equal(tailStart(held, []), -1);
});

test('two messages with the same words far apart in time are not the same message', () => {
    const early = reply('e', 'ok', '2026-01-01T00:00:00Z');
    const late = reply('l', 'ok', '2026-01-02T00:00:00Z');
    assert.equal(sameMessage(early, late), false);
    assert.equal(
        sameMessage(early, reply('f', 'ok', '2026-01-01T00:02:00Z')),
        true,
    );
});
