// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- node runs this file, not the Svelte checker
// @ts-nocheck: run by node (type stripping), not by the Svelte type checker.
// Run with: node --experimental-strip-types --test tests/auto-review.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTO_REVIEW_MIN_FILES,
    AUTO_REVIEW_ROUNDS,
    changedPaths,
    reviewBrief,
    shouldAutoReview,
} from '../src/lib/tasks/auto-review.ts';

const write = (path, children) => ({
    kind: 'command',
    command: 'Edit',
    output: '',
    status: 'ok',
    change: path
        ? { path, added: 1, removed: 0, before: '', after: '' }
        : undefined,
    children,
});

test('changedPaths: each written file once, sub-agent writes included', () => {
    const blocks = [
        { kind: 'response', text: 'done' },
        write('src/a.ts'),
        write('src/a.ts'),
        write(undefined, [write('src/b.ts')]),
    ];
    assert.deepEqual(changedPaths(blocks), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(changedPaths([{ kind: 'response', text: 'hi' }]), []);
});

const base = {
    enabled: true,
    orchestrate: true,
    worker: false,
    hasRoute: true,
    paths: ['a.ts', 'b.ts'],
    rounds: 0,
};

test('shouldAutoReview: a main chat turn that changed enough files', () => {
    assert.equal(AUTO_REVIEW_MIN_FILES, 2);
    assert.equal(shouldAutoReview(base), true);
    assert.equal(
        shouldAutoReview({ ...base, rounds: AUTO_REVIEW_ROUNDS - 1 }),
        true,
    );
});

test('shouldAutoReview: switches, workers, routes, size and the round cap', () => {
    assert.equal(shouldAutoReview({ ...base, enabled: false }), false);
    assert.equal(shouldAutoReview({ ...base, orchestrate: false }), false);
    assert.equal(shouldAutoReview({ ...base, worker: true }), false);
    assert.equal(shouldAutoReview({ ...base, hasRoute: false }), false);
    assert.equal(shouldAutoReview({ ...base, paths: ['a.ts'] }), false);
    assert.equal(
        shouldAutoReview({ ...base, rounds: AUTO_REVIEW_ROUNDS }),
        false,
    );
});

test('reviewBrief: request, files, read-only and a verdict', () => {
    const brief = reviewBrief('fix the login bug', ['src/a.ts', 'src/b.ts'], 1);
    assert.match(brief, /round 1 of 2/);
    assert.match(brief, /fix the login bug/);
    assert.match(brief, /- src\/a\.ts\n- src\/b\.ts/);
    assert.match(brief, /Do not edit any file/);
    assert.match(brief, /VERDICT: FAIL/);
    const many = reviewBrief(
        'x',
        Array.from({ length: 45 }, (_, i) => `f${i}.ts`),
        2,
    );
    assert.match(many, /and 5 more/);
});
