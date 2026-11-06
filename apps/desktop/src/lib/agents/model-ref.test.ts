import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatModelRef, parseModelRef } from './model-ref.ts';

test('the canonical route form reads and writes the same text', () => {
    assert.deepEqual(parseModelRef('codex|gpt-5.5'), {
        provider: 'codex',
        model: 'gpt-5.5',
    });
    assert.deepEqual(parseModelRef('claude|claude-opus-5-5|high'), {
        provider: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
    });
    assert.equal(
        formatModelRef({ provider: 'codex', model: 'gpt-5.5' }),
        'codex|gpt-5.5',
    );
    assert.equal(
        formatModelRef({ provider: 'claude', model: 'opus', effort: 'max' }),
        'claude|opus|max',
    );
});

test('a Console credit model keeps its prefix inside the model part', () => {
    assert.deepEqual(parseModelRef('claude|credit:claude-opus-5-5|low'), {
        provider: 'claude',
        model: 'credit:claude-opus-5-5',
        effort: 'low',
    });
});

test('a model id with slashes and colons is not split', () => {
    assert.deepEqual(parseModelRef('opencode|opencode/nemotron-3-ultra-free'), {
        provider: 'opencode',
        model: 'opencode/nemotron-3-ultra-free',
    });
});

test('the older custom chat form, provider::model, still reads', () => {
    assert.deepEqual(parseModelRef('deepseek::deepseek-v4.1-flash'), {
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
    });
    assert.deepEqual(parseModelRef('my::provider::model'), {
        provider: 'my',
        model: 'provider::model',
    });
    assert.equal(parseModelRef('::model'), null);
    assert.equal(parseModelRef('provider::'), null);
});

test('a bare model name names no provider and is not guessed', () => {
    assert.equal(parseModelRef('deepseek/deepseek-v4.1-flash'), null);
    assert.equal(parseModelRef('gpt-5.5'), null);
});

test('empty or half-written text names nothing', () => {
    assert.equal(parseModelRef(null), null);
    assert.equal(parseModelRef(undefined), null);
    assert.equal(parseModelRef('   '), null);
    assert.equal(parseModelRef('codex|'), null);
    assert.equal(parseModelRef('|gpt-5.5'), null);
});

test('format then parse gives back the same ref', () => {
    for (const ref of [
        { provider: 'copilot', model: 'gpt-5' },
        { provider: 'workbuddy-api', model: 'kimi-k3', effort: 'medium' },
    ]) {
        assert.deepEqual(parseModelRef(formatModelRef(ref)), ref);
    }
});
