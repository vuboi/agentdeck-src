import assert from 'node:assert/strict';
import test from 'node:test';
import {
    approvedPlanNote,
    boundPlan,
    effectivePermission,
    gated,
    type GatePlan,
} from './plan-gate.ts';

const plan = (over: Partial<GatePlan> = {}): GatePlan => ({
    id: 'docs/plans/p.md',
    status: 'draft',
    chat: 'chat-a',
    runChat: '',
    source: 'exit-plan-mode',
    gate: '',
    updated: '2026-11-05T10:00:00.000Z',
    readOnly: false,
    ...over,
});

test('a chat is bound to the plan it runs, else to a plan it saved itself', () => {
    const running = plan({ id: 'run', chat: 'other', runChat: 'chat-a' });
    const saved = plan({ id: 'saved', chat: 'chat-a', source: 'mcp' });
    assert.equal(boundPlan([saved, running], 'chat-a')?.id, 'run');
    assert.equal(boundPlan([saved], 'chat-a')?.id, 'saved');
});

test('a manual plan, a read-only plan or another chat does not bind', () => {
    assert.equal(boundPlan([plan({ source: 'manual' })], 'chat-a'), null);
    assert.equal(boundPlan([plan({ readOnly: true })], 'chat-a'), null);
    assert.equal(boundPlan([plan({ chat: 'chat-b' })], 'chat-a'), null);
    assert.equal(boundPlan([plan()], ''), null);
});

test('several bound plans: the most recently updated one wins', () => {
    const older = plan({ id: 'older', updated: '2026-11-05T09:00:00.000Z' });
    const newer = plan({ id: 'newer', updated: '2026-11-05T11:00:00.000Z' });
    assert.equal(boundPlan([older, newer], 'chat-a')?.id, 'newer');
});

test('only a main-chat draft with the gate on is held to Plan mode', () => {
    const draft = plan();
    assert.equal(gated({ enabled: true, worker: false, plan: draft }), true);
    assert.equal(gated({ enabled: false, worker: false, plan: draft }), false);
    assert.equal(gated({ enabled: true, worker: true, plan: draft }), false);
    assert.equal(gated({ enabled: true, worker: false, plan: null }), false);
    for (const status of ['approved', 'doing', 'done', 'dropped']) {
        assert.equal(
            gated({ enabled: true, worker: false, plan: plan({ status }) }),
            false,
            status,
        );
    }
    assert.equal(
        gated({ enabled: true, worker: false, plan: plan({ gate: 'off' }) }),
        false,
    );
});

test('the effective permission is Plan while gated and the chosen one otherwise', () => {
    assert.equal(effectivePermission('yolo', true), 'plan');
    assert.equal(effectivePermission('yolo', false), 'yolo');
    assert.equal(effectivePermission('auto', false), 'auto');
});

test('an approved plan gets the split note once it is approved', () => {
    assert.equal(
        approvedPlanNote({
            id: 'p1',
            title: 'Feature',
            status: 'draft',
            approvedAt: '',
        }),
        '',
    );
    const note = approvedPlanNote({
        id: 'p1',
        title: 'Feature',
        status: 'approved',
        approvedAt: '2026-11-07T10:00:00Z',
    });
    assert.match(note, /plan_read/);
    assert.match(note, /propose_session/);
    assert.match(note, /depends_on/);
});
