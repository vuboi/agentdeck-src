import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAllowedPlan } from './plan-eligibility.ts';

test('an empty allow-list leaves plan eligibility unrestricted', () => {
    assert.equal(matchesAllowedPlan(undefined, []), true);
});

test('plan allow-list matches exact names without case sensitivity', () => {
    assert.equal(matchesAllowedPlan(' Claude Pro ', ['claude pro']), true);
    assert.equal(matchesAllowedPlan('Claude Pro Max', ['Claude Pro']), false);
});

test('an unknown plan fails closed when an allow-list is configured', () => {
    assert.equal(matchesAllowedPlan(null, ['Claude Pro']), false);
    assert.equal(matchesAllowedPlan('  ', ['Claude Pro']), false);
    assert.equal(matchesAllowedPlan('Claude Pro', ['  ']), false);
});
