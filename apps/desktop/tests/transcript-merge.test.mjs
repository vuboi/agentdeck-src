import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTranscripts } from '../src/lib/chat/session/transcript-merge.ts';

/** A message as the chat holds it: `at` is the instant (any offset), the text is its only block. */
const msg = (id, role, at, text) => ({
    id,
    role,
    time: '',
    at,
    blocks: [{ kind: 'response', text }],
});
const texts = (list) => list.map((message) => message.blocks[0].text);

test('N4.3: a Claude file of 3 turns and a Codex file of 2, interleaved in time, merge to 5 in order, none twice', () => {
    const claude = [
        msg('c-u1', 'user', '2026-11-03T01:00:00Z', 'claude q1'),
        msg('c-a1', 'assistant', '2026-11-03T01:00:05Z', 'claude a1'),
        msg('c-u3', 'user', '2026-11-03T05:00:00Z', 'claude q3'),
    ];
    // 09:30 at +07:00 is 02:30 UTC: between the Claude turns.
    const codex = [
        msg('codex-0', 'user', '2026-11-03T09:30:00+07:00', 'codex q2'),
        msg('codex-1', 'assistant', '2026-11-03T04:30:00Z', 'codex a2'),
    ];
    const merged = mergeTranscripts([claude, codex]);
    assert.deepEqual(texts(merged), [
        'claude q1',
        'claude a1',
        'codex q2',
        'codex a2',
        'claude q3',
    ]);
    assert.equal(
        new Set(merged.map((message) => message.blocks[0].text)).size,
        5,
    );
});

test('N4.3: times are compared as instants, so an offset and fractional seconds order right', () => {
    const claude = [msg('c1', 'user', '2026-11-03T01:00:00Z', 'claude first')];
    // Same second as the Claude message: `.5` is later, `+07:00` 00:00 is 17:00 UTC of the day before.
    const codex = [
        msg(
            'x1',
            'assistant',
            '2026-11-03T01:00:00.500Z',
            'codex late in the second',
        ),
        msg(
            'x0',
            'user',
            '2026-11-03T07:00:00+07:00',
            'codex the day before in UTC',
        ),
    ];
    assert.deepEqual(texts(mergeTranscripts([claude, codex])), [
        'codex the day before in UTC',
        'claude first',
        'codex late in the second',
    ]);
});

test('N4.3: a copy of a turn kept in otherTurns is shown once, by id or by the same role, text and time', () => {
    const file = [
        msg('a2', 'assistant', '2026-11-03T02:30:09Z', 'codex answer'),
    ];
    const sameId = [
        msg('a2', 'assistant', '2026-11-03T02:30:09Z', 'codex answer'),
    ];
    const otherId = [
        msg('turn-2', 'assistant', '2026-11-03T02:30:20Z', 'codex answer'),
    ];
    assert.equal(mergeTranscripts([file], sameId).length, 1, 'same id');
    assert.equal(
        mergeTranscripts([file], otherId).length,
        1,
        'other id, same text, reply time later',
    );
    assert.equal(
        mergeTranscripts(
            [file],
            [
                msg(
                    'turn-3',
                    'assistant',
                    '2026-11-03T02:30:20Z',
                    'a different answer',
                ),
            ],
        ).length,
        2,
        'a different text is a different turn',
    );
});

test('N4.3: a kept turn of another time, or of another role, is not taken for a copy', () => {
    const file = [msg('a2', 'assistant', '2026-11-03T02:30:09Z', 'same words')];
    assert.equal(
        mergeTranscripts(
            [file],
            [msg('t', 'assistant', '2026-11-03T20:00:00Z', 'same words')],
        ).length,
        2,
        'a day later',
    );
    assert.equal(
        mergeTranscripts(
            [file],
            [msg('t', 'user', '2026-11-03T02:30:09Z', 'same words')],
        ).length,
        2,
        'the user',
    );
});

test('N4.3: a message with no time keeps its place after the message before it', () => {
    const claude = [
        msg('u', 'user', '2026-11-03T01:00:00Z', 'q'),
        {
            id: 'a',
            role: 'assistant',
            time: '',
            blocks: [{ kind: 'response', text: 'untimed answer' }],
        },
        msg('u3', 'user', '2026-11-03T03:00:00Z', 'later q'),
    ];
    const codex = [msg('x', 'assistant', '2026-11-03T02:00:00Z', 'codex')];
    assert.deepEqual(texts(mergeTranscripts([claude, codex])), [
        'q',
        'untimed answer',
        'codex',
        'later q',
    ]);
});

test('N4.3: one list alone comes back in its own order (a single file is not re-sorted)', () => {
    const file = [
        msg('m1', 'user', '2026-11-03T05:00:00Z', 'five'),
        msg('m2', 'user', '2026-11-03T01:00:00Z', 'one'),
    ];
    assert.deepEqual(texts(mergeTranscripts([file])), ['five', 'one']);
    assert.deepEqual(texts(mergeTranscripts([file], [])), ['five', 'one']);
});

test('N4.3: two files of one provider with the same message ids keep both (Codex ids are per file)', () => {
    const first = [
        msg('codex-0', 'user', '2026-11-03T01:00:00Z', 'thread one'),
    ];
    const second = [
        msg('codex-0', 'user', '2026-11-03T02:00:00Z', 'thread two'),
    ];
    assert.deepEqual(texts(mergeTranscripts([first, second])), [
        'thread one',
        'thread two',
    ]);
});
