import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyFailure,
    credentialScopeOf,
    nextAgent,
    planRecovery,
    waitUnlessAborted,
    type RecoveryInput,
} from './turn-failure.ts';

test('classifies the errors agents end with', () => {
    assert.equal(
        classifyFailure('Claude AI usage limit reached|1761500000'),
        'limit',
    );
    assert.equal(
        classifyFailure('You have hit your usage limit. Try again in 2h 13m.'),
        'limit',
    );
    assert.equal(
        classifyFailure('stream error: 429 Too Many Requests'),
        'limit',
    );
    assert.equal(
        classifyFailure('API Error: 529 {"type":"overloaded_error"}'),
        'transient',
    );
    assert.equal(classifyFailure('request failed: ECONNRESET'), 'transient');
    assert.equal(
        classifyFailure('Invalid API key · Please run /login'),
        'auth',
    );
    assert.equal(classifyFailure('401 Unauthorized: token expired'), 'auth');
    assert.equal(
        classifyFailure(
            'could not start codex: Check that its CLI is installed',
        ),
        'missing',
    );
    assert.equal(classifyFailure('stopped'), 'stopped');
    assert.equal(classifyFailure('agent ended without a result'), 'other');
    assert.equal(
        classifyFailure(
            "You've hit your usage limit. Upgrade to Pro or try again at 3:42 PM.",
        ),
        'limit',
    );
    assert.equal(
        classifyFailure(
            'You exceeded your current quota, please check your plan',
        ),
        'limit',
    );
    // Too much context is not a usage limit: another try (or agent) is the answer, not waiting hours.
    assert.notEqual(
        classifyFailure(
            'prompt is too long: exceeded the maximum context length',
        ),
        'limit',
    );
});

const base: RecoveryInput = {
    kind: 'transient',
    retries: 0,
    chain: ['claude', 'codex', 'opencode'],
    current: 'claude',
    tried: ['claude'],
};

test('a passing fault is retried, then the next agent carries on', () => {
    assert.deepEqual(planRecovery(base), { action: 'retry', delayMs: 3000 });
    assert.deepEqual(planRecovery({ ...base, retries: 1 }), {
        action: 'retry',
        delayMs: 12000,
    });
    assert.deepEqual(planRecovery({ ...base, retries: 2 }), {
        action: 'fallback',
        agent: 'codex',
    });
});

test('a limit never switches account: the next provider carries on', () => {
    const limit = { ...base, kind: 'limit' as const };
    assert.deepEqual(planRecovery(limit), {
        action: 'fallback',
        agent: 'codex',
    });
    assert.deepEqual(
        planRecovery({
            ...limit,
            current: 'codex',
            tried: ['claude', 'codex'],
        }),
        { action: 'fallback', agent: 'opencode' },
    );
});

test('recovery keeps each provider and model route distinct, including custom connectors', () => {
    const chain = [
        'claude|claude-sonnet-5-5',
        'custom-one|reasoner-v2',
        'custom-two|gemini-4-argon',
    ];
    const first = planRecovery({
        ...base,
        kind: 'limit',
        chain,
        current: chain[0],
        tried: [chain[0]],
    });
    assert.deepEqual(first, {
        action: 'fallback',
        agent: 'custom-one|reasoner-v2',
    });
    const second = planRecovery({
        ...base,
        kind: 'limit',
        chain,
        current: chain[1],
        tried: [chain[0], chain[1]],
    });
    assert.deepEqual(second, {
        action: 'fallback',
        agent: 'custom-two|gemini-4-argon',
    });
});

test('a user stop, or no agent left, stops', () => {
    assert.equal(planRecovery({ ...base, kind: 'stopped' }).action, 'stop');
    assert.equal(
        planRecovery({
            ...base,
            kind: 'limit',
            tried: ['claude', 'codex', 'opencode'],
        }).action,
        'stop',
    );
    assert.equal(
        planRecovery({ ...base, kind: 'auth', chain: ['claude'] }).action,
        'stop',
    );
});

test('the next agent wraps round the chain and skips the ones tried', () => {
    assert.equal(
        nextAgent(['claude', 'codex', 'opencode'], 'opencode', ['opencode']),
        'claude',
    );
    assert.equal(
        nextAgent(['claude', 'codex'], 'antigravity', ['antigravity']),
        'claude',
    );
    assert.equal(nextAgent(['claude'], 'claude', ['claude']), undefined);
});

test('a missing conversation is its own kind and is started again at once', () => {
    assert.equal(
        classifyFailure('No conversation found with session ID: 3f2a'),
        'conversation',
    );
    assert.equal(classifyFailure('rollout 019 not found'), 'conversation');
    assert.deepEqual(planRecovery({ ...base, kind: 'conversation' }), {
        action: 'retry',
        delayMs: 0,
    });
    assert.equal(
        planRecovery({ ...base, kind: 'conversation', retries: 1 }).action,
        'fallback',
    );
});

test('after a limit no route of the same credential is tried, only another provider', () => {
    const chain = [
        'claude|opus|low',
        'claude|sonnet',
        'claude|opus',
        'codex|gpt',
        'custom-one|m',
    ];
    const plan = planRecovery({
        ...base,
        kind: 'limit',
        chain,
        current: 'claude|opus',
        tried: ['claude|opus'],
    });
    assert.deepEqual(plan, { action: 'fallback', agent: 'codex|gpt' });
    assert.equal(credentialScopeOf('antigravity|x'), 'agy');
    assert.equal(credentialScopeOf('custom-one|m'), 'custom-one');
    assert.equal(
        planRecovery({
            ...base,
            kind: 'auth',
            chain: ['claude|opus', 'claude|sonnet'],
            current: 'claude|opus',
            tried: ['claude|opus'],
        }).action,
        'stop',
    );
});

test('a passing fault may still try another model of the same provider', () => {
    const plan = planRecovery({
        ...base,
        kind: 'transient',
        retries: 2,
        chain: ['claude|opus', 'claude|sonnet'],
        current: 'claude|opus',
        tried: ['claude|opus'],
    });
    assert.deepEqual(plan, { action: 'fallback', agent: 'claude|sonnet' });
});

test('a wait ends with true when time passes, and false at once when aborted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let done: boolean | undefined;
    void waitUnlessAborted(3000, controller.signal).then(
        (value) => (done = value),
    );
    t.mock.timers.tick(2999);
    await Promise.resolve();
    assert.equal(done, undefined);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(done, true);

    const stopped = new AbortController();
    let after: boolean | undefined;
    void waitUnlessAborted(12000, stopped.signal).then(
        (value) => (after = value),
    );
    stopped.abort();
    await Promise.resolve();
    assert.equal(after, false);
    t.mock.timers.reset();
});
