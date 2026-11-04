import assert from 'node:assert/strict';
import test from 'node:test';
import {
    appendWrite,
    checkWrite,
    keepText,
    MAX_KEPT_CHARS,
    pathKey,
    pathsWrittenBy,
    pathsWrittenInChat,
    readPathOf,
    type LedgerWrite,
    type RunRef,
} from './change-ledger.ts';

const run = (
    turn: string,
    intentAt: number,
    patch: Partial<RunRef> = {},
): RunRef => ({
    sessionId: 'chat',
    turn,
    lane: 'primary',
    intentAt,
    ...patch,
});
const ROOT = 'E:/WORK/PROJECTS/msg-new-template';
const EN = 'libs/assets/i18n/en.json';

test('W3: a write is recorded with its text and the run that made it', () => {
    const writes: LedgerWrite[] = [];
    appendWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('t1', 100),
        callId: 'c1',
        before: 'A',
        after: 'B',
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].after, 'B');
    assert.equal(writes[0].truncated, false);
});

test('W3: paths compare across slashes and case (Windows)', () => {
    assert.equal(
        pathKey('libs\\assets\\i18n\\EN.json'),
        pathKey('libs/assets/i18n/en.json'),
    );
    assert.equal(pathKey('dir/sub/'), 'dir/sub');
});

test('W3: text beyond the limit is cut and marked', () => {
    const big = 'x'.repeat(MAX_KEPT_CHARS + 5);
    const kept = keepText(big);
    assert.equal(kept.text.length, MAX_KEPT_CHARS);
    assert.equal(kept.truncated, true);
});

test('W3: the ledger keeps only its newest entries', () => {
    const writes: LedgerWrite[] = [];
    for (let i = 0; i < 5; i++)
        appendWrite(
            writes,
            {
                root: ROOT,
                path: `f${i}`,
                run: run('t', i),
                callId: `c${i}`,
                before: '',
                after: '',
            },
            3,
        );
    assert.deepEqual(
        writes.map((w) => w.path),
        ['f2', 'f3', 'f4'],
    );
});

test('W6: a later request overwritten by an older run is a conflict, kind=overwrite', () => {
    const writes: LedgerWrite[] = [];
    // side run for the newer request (intentAt 200) writes the short label
    appendWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('side', 200, { lane: 'listener' }),
        callId: 'c1',
        before: 'ABC',
        after: 'XYZ',
    });
    // primary (older request, intentAt 100) writes its own text over it
    const conflict = checkWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('main', 100),
        callId: 'c2',
        before: 'XYZ',
        after: 'ABC2',
    });
    assert.ok(conflict);
    assert.equal(conflict.kind, 'overwrite');
    assert.equal(conflict.over.run.turn, 'side');
});

test('W6: writing back the text before the newer change is kind=revert', () => {
    const writes: LedgerWrite[] = [];
    appendWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('side', 200, { lane: 'listener' }),
        callId: 'c1',
        before: 'ABC',
        after: 'XYZ',
    });
    const conflict = checkWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('main', 100),
        callId: 'c2',
        before: 'XYZ',
        after: 'ABC',
    });
    assert.equal(conflict?.kind, 'revert');
});

test('W6: no conflict for the same run, an older writer, or another file', () => {
    const writes: LedgerWrite[] = [];
    appendWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('main', 100),
        callId: 'c1',
        before: 'A',
        after: 'B',
    });
    assert.equal(
        checkWrite(writes, {
            root: ROOT,
            path: EN,
            run: run('main', 100),
            callId: 'c2',
            before: 'B',
            after: 'C',
        }),
        null,
    );
    assert.equal(
        checkWrite(writes, {
            root: ROOT,
            path: EN,
            run: run('side', 300),
            callId: 'c3',
            before: 'B',
            after: 'C',
        }),
        null,
    );
    assert.equal(
        checkWrite(writes, {
            root: ROOT,
            path: 'other.json',
            run: run('side', 50),
            callId: 'c4',
            before: '',
            after: '',
        }),
        null,
    );
});

test("W5: pathsWrittenBy lists one run's files once each", () => {
    const writes: LedgerWrite[] = [];
    appendWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('a', 1),
        callId: 'c1',
        before: '',
        after: '',
    });
    appendWrite(writes, {
        root: ROOT,
        path: EN,
        run: run('a', 1),
        callId: 'c2',
        before: '',
        after: '',
    });
    appendWrite(writes, {
        root: ROOT,
        path: 'b.ts',
        run: run('b', 2),
        callId: 'c3',
        before: '',
        after: '',
    });
    assert.deepEqual(pathsWrittenBy(writes, { sessionId: 'chat', turn: 'a' }), [
        EN,
    ]);
});

test('W3: read tools name their path in JSON or plain input', () => {
    assert.equal(readPathOf('Read', '{"file_path":"a/b.ts"}'), 'a/b.ts');
    assert.equal(readPathOf('agentdeck.view', 'a/b.ts'), 'a/b.ts');
    assert.equal(readPathOf('Bash', 'cat a.ts'), undefined);
});

test("W5 trigger 4: a chat's writes over all its turns, once per path", () => {
    const writes: LedgerWrite[] = [];
    appendWrite(writes, {
        root: ROOT,
        path: 'a.ts',
        run: run('t1', 1, { sessionId: 'worker' }),
        callId: 'c1',
        before: '',
        after: '',
    });
    appendWrite(writes, {
        root: ROOT,
        path: 'a.ts',
        run: run('t2', 2, { sessionId: 'worker' }),
        callId: 'c2',
        before: '',
        after: '',
    });
    appendWrite(writes, {
        root: ROOT,
        path: 'b.ts',
        run: run('t3', 3, { sessionId: 'other' }),
        callId: 'c3',
        before: '',
        after: '',
    });
    assert.deepEqual(pathsWrittenInChat(writes, 'worker'), ['a.ts']);
});
