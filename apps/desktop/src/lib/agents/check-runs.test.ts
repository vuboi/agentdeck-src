import assert from 'node:assert/strict';
import test from 'node:test';
import { joinRun } from './check-runs.ts';

test('a repeat call while a check runs joins it and starts nothing new', async () => {
    const runs = new Map<string, Promise<number>>();
    let starts = 0;
    let release!: (value: number) => void;
    const start = () => {
        starts += 1;
        return new Promise<number>((resolve) => {
            release = resolve;
        });
    };
    const first = joinRun(runs, 'detect:command-code', start);
    const second = joinRun(runs, 'detect:command-code', start);
    assert.equal(first, second);
    assert.equal(starts, 1);
    release(7);
    assert.equal(await first, 7);
    assert.equal(runs.has('detect:command-code'), false);
});

test('a different key runs its own check', async () => {
    const runs = new Map<string, Promise<string>>();
    const [a, b] = await Promise.all([
        joinRun(runs, 'detect:claude', async () => 'claude'),
        joinRun(runs, 'detect', async () => 'all'),
    ]);
    assert.deepEqual([a, b], ['claude', 'all']);
});

test('a failed check releases its key so the next call starts again', async () => {
    const runs = new Map<string, Promise<string>>();
    await assert.rejects(
        joinRun(runs, 'detect:codex', async () => {
            throw new Error('timeout');
        }),
        /timeout/,
    );
    assert.equal(runs.has('detect:codex'), false);
    assert.equal(await joinRun(runs, 'detect:codex', async () => 'ok'), 'ok');
});

test('a settled run never deletes a newer run that reused its key', async () => {
    const runs = new Map<string, Promise<string>>();
    let finishFirst!: (value: string) => void;
    const first = joinRun(
        runs,
        'detect:opencode',
        () =>
            new Promise<string>((resolve) => {
                finishFirst = resolve;
            }),
    );
    finishFirst('first');
    await first;
    // The first run is settled and released; a second run now owns the key.
    let finishSecond!: (value: string) => void;
    const second = joinRun(
        runs,
        'detect:opencode',
        () =>
            new Promise<string>((resolve) => {
                finishSecond = resolve;
            }),
    );
    await Promise.resolve();
    assert.equal(runs.get('detect:opencode') === second, true);
    finishSecond('second');
    assert.equal(await second, 'second');
});
