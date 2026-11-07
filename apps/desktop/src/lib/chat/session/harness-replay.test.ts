import assert from 'node:assert/strict';
import test from 'node:test';
import { replayIds } from './harness-replay.ts';

test('missing replay ID arrays normalize to empty arrays', () => {
    assert.deepEqual(replayIds(undefined), []);
});

test('malformed replay ID values normalize to empty arrays', () => {
    assert.deepEqual(replayIds(null), []);
    assert.deepEqual(replayIds({}), []);
});

test('valid replay IDs are copied and non-string values are discarded', () => {
    const ids = ['child-1', 7, 'child-2'];
    const normalized = replayIds(ids);

    assert.deepEqual(normalized, ['child-1', 'child-2']);
    assert.notEqual(normalized, ids);
});
