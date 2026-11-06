import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKBUDDY_API_ID, migrateCustomProviderId } from './custom-ids.ts';

test('the hidden WorkBuddy provider saved under the CLI id is renamed', () => {
    const saved = {
        id: 'workbuddy',
        name: 'WorkBuddy',
        nativeAuth: 'workbuddy',
        models: ['kimi-k3'],
    };
    assert.deepEqual(migrateCustomProviderId(saved), {
        ...saved,
        id: WORKBUDDY_API_ID,
    });
    assert.equal(WORKBUDDY_API_ID, 'workbuddy-api');
});

test('a provider already renamed, or another provider, is returned as it is', () => {
    const renamed = { id: WORKBUDDY_API_ID, nativeAuth: 'workbuddy' };
    assert.equal(migrateCustomProviderId(renamed), renamed);
    const mine = { id: 'workbuddy', name: 'My own endpoint' };
    assert.equal(migrateCustomProviderId(mine), mine);
    const muse = { id: 'muse-code', nativeAuth: 'muse-code' };
    assert.equal(migrateCustomProviderId(muse), muse);
});
