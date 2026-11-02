import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialScope } from './credential-scope.ts';

test('antigravity uses the agy scope for lane, epoch and busy key', () => {
    assert.equal(credentialScope('antigravity', 'gemini-4-argon'), 'agy');
    assert.equal(credentialScope('agy'), 'agy');
});

test('custom providers each get their own scope', () => {
    assert.equal(credentialScope('custom', 'prov-a::model-x'), 'custom:prov-a');
    assert.equal(credentialScope('custom', 'prov-b::model-x'), 'custom:prov-b');
    assert.notEqual(
        credentialScope('custom', 'a::m'),
        credentialScope('custom', 'b::m'),
    );
});

test('custom model without a provider id falls back to custom', () => {
    assert.equal(credentialScope('custom', 'plain-model'), 'custom');
    assert.equal(credentialScope('custom', null), 'custom');
    assert.equal(credentialScope('custom'), 'custom');
});

test('other agents keep their own id, whatever the model', () => {
    assert.equal(credentialScope('claude', 'claude-opus-5-5'), 'claude');
    assert.equal(credentialScope('codex', 'a::b'), 'codex');
    assert.equal(credentialScope('copilot'), 'copilot');
    assert.equal(credentialScope(undefined), '');
});
