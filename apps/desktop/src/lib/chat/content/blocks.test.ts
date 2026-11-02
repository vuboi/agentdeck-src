// Run with: node --test src/lib/chat/content/blocks.test.ts
// A streamed reply sends a delta every few ms. segments() used to read every block's text and rebuild every object, so the
// whole reply rendered again per delta. These tests pin what it does now: unchanged segments keep their object, a
// streaming answer is not parsed for questions, and a merged reasoning entry keeps its object while its text grows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { reuseSegments, segments, type Segment } from './blocks.ts';
import { askAsStep } from '../recovery/questions.ts';
import type { Block } from '../mock.ts';

const cmd = (id: string, command = 'Bash pnpm test'): Block => ({
    kind: 'command',
    id,
    command,
    output: '',
    status: 'ok',
});
const question =
    'Pick one.\n```agentdeck-ask\n{"questions":[{"id":"q","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]}\n```';

function counting() {
    const counter = { calls: 0 };
    const askOf = (text: string) => {
        counter.calls++;
        return askAsStep(text);
    };
    return { counter, askOf };
}

test('a delta to the streaming answer gives back the same segment objects before it', () => {
    const c1 = cmd('1');
    const c2 = cmd('2');
    const answer: Block = { kind: 'response', text: 'Hel', streaming: true };
    const blocks: Block[] = [c1, c2, answer];
    const prev = segments(blocks);
    if (answer.kind === 'response') answer.text += 'lo';
    const next = reuseSegments(prev, segments(blocks));
    assert.equal(next.length, prev.length);
    assert.equal(next[0], prev[0], 'the command group is the same object');
    assert.equal(next[1], prev[1], 'the answer segment is the same object');
});

test('a tool call that starts a new group after the answer only adds a segment at the end', () => {
    const answer: Block = { kind: 'response', text: 'Done', streaming: false };
    const blocks: Block[] = [cmd('1'), answer];
    const prev = segments(blocks);
    const next = reuseSegments(
        prev,
        segments([...blocks, cmd('2', 'Read src/a.ts')]),
    );
    assert.equal(next.length, 3);
    assert.equal(next[0], prev[0]);
    assert.equal(next[1], prev[1]);
    assert.ok(!prev.includes(next[2]));
});

test('merged reasoning keeps its object while its streaming part grows', () => {
    const first: Block = { kind: 'thinking', text: 'a', streaming: false };
    const second: Block = { kind: 'thinking', text: 'b', streaming: true };
    const blocks: Block[] = [
        first,
        second,
        { kind: 'response', text: 'x', streaming: true },
    ];
    const prev = segments(blocks);
    const before = prev[0];
    assert.equal(before.kind, 'block');
    if (second.kind === 'thinking') second.text += 'c';
    const next = reuseSegments(prev, segments(blocks));
    assert.equal(next[0], prev[0], 'the merged reasoning is the same object');
    assert.equal(
        next[0].kind === 'block' &&
            next[0].block.kind === 'thinking' &&
            next[0].block.text,
        'a\n\nbc',
        'its text is read live',
    );
});

test('a streaming answer is not parsed for questions; a finished one makes one step, once', () => {
    const { counter, askOf } = counting();
    const answer: Block = { kind: 'response', text: question, streaming: true };
    const streaming = segments([answer], askOf);
    assert.equal(counter.calls, 0);
    assert.equal(
        streaming.some((segment) => segment.kind === 'commands'),
        false,
    );

    answer.streaming = false;
    const done = segments([answer], askOf);
    assert.equal(counter.calls, 1);
    const steps = done.filter(
        (segment): segment is Extract<Segment, { kind: 'commands' }> =>
            segment.kind === 'commands',
    );
    assert.equal(steps.length, 1);
    assert.equal(steps[0].items.length, 1);

    segments([answer], askOf);
    assert.equal(
        counter.calls,
        1,
        'the parsed step is kept while the text stays the same',
    );
});

test('empty reasoning is dropped once finished, kept while it streams', () => {
    const done = segments([
        { kind: 'thinking', text: '  ', streaming: false },
        { kind: 'response', text: 'x' },
    ]);
    assert.equal(done.length, 1);
    assert.equal(done[0].kind === 'block' && done[0].block.kind, 'response');

    const streaming = segments([
        { kind: 'thinking', text: '', streaming: true },
        { kind: 'response', text: 'x' },
    ]);
    assert.equal(streaming.length, 2);
    assert.equal(
        streaming[0].kind === 'block' && streaming[0].block.kind,
        'thinking',
    );
});

test('2000 deltas into a 20 000 character answer never parse it for questions', (t) => {
    const { counter, askOf } = counting();
    const answer: Block = { kind: 'response', text: '', streaming: true };
    const blocks: Block[] = [cmd('1'), answer];
    let prev = segments(blocks, askOf);
    const started = performance.now();
    for (let i = 0; i < 2000; i++) {
        if (answer.kind === 'response') answer.text += 'x'.repeat(10);
        prev = reuseSegments(prev, segments(blocks, askOf));
    }
    t.diagnostic(
        `2000 deltas, segments + reuseSegments: ${(performance.now() - started).toFixed(1)} ms`,
    );
    assert.equal(counter.calls, 0);
});

// propose_session: a proposal is a segment of its own, drawn as a card; the steps around it are groups of their own.
const PROPOSAL = JSON.stringify({
    title: 'Export and theme',
    tasks: [
        { title: 'pdf', brief: 'do pdf', write_scope: ['src/export'] },
        { title: 'dark', brief: 'do dark', write_scope: ['src/theme'] },
    ],
});
const proposal = (id: string): Block => ({
    kind: 'command',
    id,
    command: `mcp__agentdeck__propose_session ${PROPOSAL}`,
    output: 'Proposed to the user; wait for their choice.',
    status: 'ok',
});

test('a propose_session call is a proposal segment, not a step of the group', () => {
    const parts = segments([cmd('a'), proposal('p')]);
    assert.deepEqual(
        parts.map((part) => part.kind),
        ['commands', 'proposal'],
    );
    const card = parts[1];
    assert.equal(card.kind === 'proposal' && card.item.id, 'p');
});

test('the steps before and after a proposal are groups of their own', () => {
    const parts = segments([cmd('a'), proposal('p'), cmd('b')]);
    assert.deepEqual(
        parts.map((part) => part.kind),
        ['commands', 'proposal', 'commands'],
    );
});

test('an unchanged proposal keeps its segment when a delta arrives', () => {
    const card = proposal('p');
    const first = segments([cmd('a'), card]);
    const next = reuseSegments(first, segments([cmd('a'), card, cmd('b')]));
    assert.equal(next[1], first[1]);
});
