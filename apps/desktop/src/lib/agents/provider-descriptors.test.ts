import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BUILT_IN_IDS,
    PROVIDERS,
    cliOf,
    credentialScopeOf,
    fallbackAgents,
    isBuiltInAgent,
    liveModel,
    prewarmAgents,
} from './provider-descriptors.ts';

test('every built-in id has exactly one descriptor, in the same order', () => {
    assert.deepEqual(
        PROVIDERS.map((item) => item.id),
        [...BUILT_IN_IDS],
    );
    assert.equal(new Set(BUILT_IN_IDS).size, BUILT_IN_IDS.length);
});

test('the CLI binary of each provider is the one the app always used', () => {
    assert.deepEqual(
        Object.fromEntries(PROVIDERS.map((item) => [item.id, item.binary])),
        {
            claude: 'claude',
            codex: 'codex',
            antigravity: 'agy',
            opencode: 'opencode',
            workbuddy: 'codebuddy',
            copilot: 'gh',
            'command-code': 'command-code',
        },
    );
    assert.equal(cliOf('custom'), undefined);
    assert.equal(cliOf('workbuddy-api'), undefined);
});

test('the prewarm list and the fallback chain match the app before this registry', () => {
    assert.deepEqual(
        [...prewarmAgents()],
        ['claude', 'codex', 'antigravity', 'workbuddy', 'copilot'],
    );
    assert.deepEqual([...fallbackAgents()], [...BUILT_IN_IDS]);
});

test('only Claude changes model in a kept process', () => {
    assert.equal(liveModel('claude'), true);
    for (const id of BUILT_IN_IDS.filter((item) => item !== 'claude'))
        assert.equal(liveModel(id), false);
    assert.equal(liveModel('custom'), false);
});

test('Antigravity runs its accounts under agy; the others under their own id', () => {
    assert.equal(credentialScopeOf('antigravity'), 'agy');
    assert.equal(credentialScopeOf('codex'), 'codex');
    assert.equal(credentialScopeOf('deepseek'), 'deepseek');
});

test('isBuiltInAgent tells a built-in id from a custom provider id', () => {
    assert.equal(isBuiltInAgent('workbuddy'), true);
    assert.equal(isBuiltInAgent('workbuddy-api'), false);
    assert.equal(isBuiltInAgent('custom'), false);
    assert.equal(isBuiltInAgent(undefined), false);
});
