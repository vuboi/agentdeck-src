// Run with: node --test src/lib/chat/content/subagent-provider.test.ts
// A sub agent that a plugin runs (`codex:codex-rescue`, started by Claude) shows the logo of the provider that does the
// work, not the host's. These tests pin which subagent types name a provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { providerOfSubagent, subagentTypeOf } from './subagent-provider.ts';

test('a plugin sub agent names its provider by the namespace before the colon', () => {
    assert.equal(providerOfSubagent('codex:codex-rescue'), 'codex');
    assert.equal(providerOfSubagent('antigravity:review'), 'antigravity');
});

test('a plain sub agent type is not a provider', () => {
    assert.equal(providerOfSubagent('explore'), null);
    assert.equal(providerOfSubagent('general-purpose'), null);
});

test('a namespace that no registered provider has is not a provider', () => {
    // The provider's id is `antigravity`; `gemini` is only its icon, so it does not match.
    assert.equal(providerOfSubagent('gemini:x'), null);
    assert.equal(providerOfSubagent('nope:x'), null);
});

test('a missing or empty sub agent type is not a provider', () => {
    assert.equal(providerOfSubagent(undefined), null);
    assert.equal(providerOfSubagent(''), null);
});

test('subagentTypeOf reads subagent_type from the tool input', () => {
    assert.equal(
        subagentTypeOf(
            '{"description":"Look","subagent_type":"codex:codex-rescue"}',
        ),
        'codex:codex-rescue',
    );
    assert.equal(subagentTypeOf('{"description":"Look"}'), undefined);
    assert.equal(subagentTypeOf('not json'), undefined);
    assert.equal(subagentTypeOf(''), undefined);
});
