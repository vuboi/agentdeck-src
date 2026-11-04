import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTask, type PlanState } from './delegate-plan.ts';
import type { TaskRecord } from './delegate-task.ts';

const rows = [
    {
        id: 'claude',
        label: 'Claude',
        models: [
            { value: 'sonnet-4', label: 'Sonnet 4' },
            { value: 'haiku-5', label: 'Haiku 5' },
        ],
    },
    {
        id: 'free',
        label: 'Free Tier',
        models: [{ value: 'free-1', label: 'free-1' }],
        restricted: true,
    },
];

const caller = { id: 'chat', agent: 'claude', model: 'sonnet-4' };

function record(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
    return {
        id,
        caller: 'chat',
        childId: `child-${id}`,
        state: 'done',
        dependsOn: [],
        wait: false,
        label: id,
        agent: 'claude',
        agentId: 'claude',
        model: 'sonnet-4',
        task: 'x',
        startedAt: 0,
        ...patch,
    } as TaskRecord;
}

/** A state where every check passes; each test changes one part of it. */
function state(patch: Partial<PlanState> = {}): PlanState {
    return {
        depth: 0,
        maxDepth: 4,
        tasks: {},
        sessions: [
            {
                id: 'child-old',
                parentId: 'chat',
                status: 'idle',
                agent: 'claude',
                model: 'sonnet-4',
            },
        ],
        rows: () => rows,
        routesFor: () => [],
        routedFor: () => undefined,
        isRunning: () => false,
        customModelId: (rowId, model) => `${rowId}/${model}`,
        agentKindOf: (rowId) => (rowId === 'claude' ? 'claude' : 'custom'),
        ...patch,
    };
}

const call = (args: Record<string, unknown>) => ({
    args: { task: 'write the file', agent: 'claude', ...args },
});

function refusal(
    input: { call: { args: unknown }; caller?: typeof caller },
    patch: Partial<PlanState> = {},
): string {
    const result = planTask(
        { call: input.call, caller: input.caller ?? caller },
        state(patch),
    );
    assert.equal(result.ok, false, 'the call must be refused');
    return result.ok ? '' : result.error;
}

test('N2.1: a valid call is planned with its agent and model', () => {
    const result = planTask(
        { call: call({ agent: 'claude', model: 'haiku' }), caller },
        state(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.row.id, 'claude');
    assert.equal(result.plan.agent, 'claude');
    assert.equal(result.plan.model, 'haiku-5');
    assert.equal(result.plan.reuse, undefined);
});

test('N2.1 refusal: arguments that do not parse', () => {
    assert.match(refusal({ call: { args: null } }), /./);
});

test('N2.1 refusal: the chat calling is unknown', () => {
    const result = planTask(
        { call: call({ agent: 'claude' }), caller: undefined },
        state(),
    );
    assert.equal(result.ok, false);
    if (!result.ok)
        assert.match(result.error, /could not tell which chat is calling/);
});

test('N2.1 refusal: a side chat cannot delegate', () => {
    const result = planTask(
        {
            call: call({ agent: 'claude' }),
            caller: { ...caller, side: { parentId: 'chat', question: 'q' } },
        },
        state(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /side chats cannot delegate/);
});

test('N2.1 refusal: the delegation depth is at its limit', () => {
    const error = refusal({ call: call({ agent: 'claude' }) }, { depth: 4 });
    assert.match(error, /Delegation depth is limited to 4 levels/);
});

test('N2.1 refusal: an unknown task role', () => {
    const error = refusal({ call: call({ role: 'juggling' }) });
    assert.match(error, /Unknown task role "juggling"/);
});

test('N2.1 refusal: a known role with no configured route', () => {
    const error = refusal(
        { call: call({ role: 'review' }) },
        { routesFor: () => [] },
    );
    assert.match(error, /No route is configured for task role "review"/);
});

test('N2.1 refusal: depends_on names an unknown task', () => {
    const error = refusal({ call: call({ depends_on: ['t-missing'] }) });
    assert.match(error, /depends_on=t-missing is unknown/);
});

test('N2.1 refusal: a worktree cannot be combined with continue', () => {
    const error = refusal(
        {
            call: call({
                agent: 'claude',
                isolation: 'worktree',
                continue: 'child-old',
            }),
        },
        { tasks: { t1: record('t1', { childId: 'child-old' }) } },
    );
    assert.match(error, /isolation worktree cannot be used with continue/);
});

test('N2.1 refusal: continue names no known worker', () => {
    const error = refusal({ call: call({ continue: 't-nope' }) });
    assert.match(error, /continue="t-nope" is unknown/);
});

test('N2.1 refusal: continue names a worker that is still running', () => {
    const error = refusal(
        { call: call({ continue: 't1' }) },
        {
            tasks: {
                t1: record('t1', { childId: 'child-old', state: 'running' }),
            },
            isRunning: (taskId) => taskId === 't1',
        },
    );
    assert.match(error, /worker is still running/);
});

test('N2.1 refusal: a role whose routes are all unavailable now', () => {
    const error = refusal(
        { call: call({ role: 'coding' }) },
        { routesFor: () => ['claude|sonnet-4'], routedFor: () => undefined },
    );
    assert.match(error, /None of the configured routes for task role "coding"/);
});

test('N2.1 refusal: the agent is not available', () => {
    const error = refusal({ call: call({ agent: 'no-such-agent' }) });
    assert.match(error, /No agent "no-such-agent" is available/);
});

test('N2.1 refusal: the model is not one the agent offers', () => {
    const error = refusal({
        call: call({ agent: 'claude', model: 'gpt-zzz' }),
    });
    assert.match(error, /gpt-zzz/);
    assert.doesNotMatch(error, /No agent/);
});

test('N2.1 refusal: a free-tier agent is sent private content', () => {
    const error = refusal({
        call: call({ agent: 'free', task: 'deploy with password=hunter2 now' }),
    });
    assert.match(error, /Not sent: Free Tier is a free tier/);
});

test("W1: without agent the calling chat's agent does the work", () => {
    const result = planTask(
        { call: { args: { task: 'check the page' } }, caller },
        state(),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plan.agent, 'claude');
});
