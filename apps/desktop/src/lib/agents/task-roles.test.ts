import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    canonicalRole,
    firstAvailableRoute,
    migrateOff,
    migrateRoutes,
    ROLE_STATUS,
    roleOfCall,
    routesOf,
    taskRoleHint,
    TASK_ROLES,
    type RoleState,
} from './task-roles.ts';

const label = (route: string) => `label of ${route}`;
const state = (
    routes: RoleState['routes'],
    on = true,
    off: string[] = [],
): RoleState => ({ routes, on, off });

test('there are ten roles, each with a label, an icon and a hint', () => {
    assert.equal(TASK_ROLES.length, 10);
    for (const role of TASK_ROLES)
        assert.ok(role.label && role.icon && role.hint, role.id);
});

test('a role offers its routes in order, without empty rows', () => {
    assert.deepEqual(
        routesOf(
            state({
                read: [
                    'codex|gpt-5.6-terra',
                    '',
                    'claude|credit:claude-haiku-5-5',
                ],
            }),
            'read',
        ),
        ['codex|gpt-5.6-terra', 'claude|credit:claude-haiku-5-5'],
    );
    assert.deepEqual(routesOf(state({ research: [''] }), 'research'), []);
    assert.deepEqual(
        routesOf(
            state({ research: ['source:claude', 'claude|x'] }),
            'research',
        ),
        ['claude|x'],
    );
    assert.deepEqual(routesOf(state({}), 'research'), []);
});

test('routing uses the exact configured provider and model, skips unavailable routes, and preserves Claude credit ids', () => {
    const agents = [
        {
            id: 'claude',
            models: [
                { value: 'claude-sonnet-5-5' },
                { value: 'credit:claude-haiku-5-5' },
            ],
        },
        { id: 'openrouter-free', models: [{ value: 'google/gemini-4-argon' }] },
        { id: 'antigravity', models: [{ value: 'gemini-4-argon' }] },
        { id: 'custom:team', models: [{ value: 'reasoner-v2' }] },
    ];
    assert.deepEqual(
        firstAvailableRoute(
            ['claude|credit:claude-haiku-5-5', 'antigravity|gemini-4-argon'],
            agents,
        ),
        { agent: 'claude', model: 'credit:claude-haiku-5-5' },
    );
    assert.deepEqual(
        firstAvailableRoute(
            ['missing|gemini-4-argon', 'antigravity|gemini-4-argon'],
            agents,
        ),
        { agent: 'antigravity', model: 'gemini-4-argon' },
    );
    assert.deepEqual(
        firstAvailableRoute(
            ['antigravity|gemini-4-argon', 'custom:team|reasoner-v2'],
            agents,
            (agent) => agent !== 'antigravity',
        ),
        { agent: 'custom:team', model: 'reasoner-v2' },
    );
    assert.equal(
        firstAvailableRoute(['antigravity|google/gemini-4-argon'], agents),
        undefined,
    );
});

test('the master flag off stops every role, and keeps the picks', () => {
    const picks = { research: ['codex|gpt-5.6-terra'], read: ['claude|x'] };
    assert.deepEqual(routesOf(state(picks, false), 'research'), []);
    assert.deepEqual(routesOf(state(picks, false), 'read'), []);
    assert.deepEqual(picks.research, ['codex|gpt-5.6-terra']);
    assert.equal(taskRoleHint(state(picks, false), label), '');
});

test('a role switched off offers nothing, and keeps its picks for when it is switched on again', () => {
    const picks = { research: ['codex|gpt-5.6-terra'] };
    assert.deepEqual(
        routesOf(state(picks, true, ['research']), 'research'),
        [],
    );
    assert.deepEqual(picks.research, ['codex|gpt-5.6-terra']);
    assert.deepEqual(routesOf(state(picks, true, []), 'research'), [
        'codex|gpt-5.6-terra',
    ]);
});

test('the hint names each routed role with its id, in priority order', () => {
    const hint = taskRoleHint(
        state({
            read: ['claude|credit:claude-haiku-5-5'],
            research: ['codex|gpt-5.6-terra', 'claude|claude-haiku-5-5'],
            review: [],
        }),
        label,
    );
    assert.equal(
        hint,
        'Task routing set by the user for this work, in order of preference:\n- read: delegate_task with role "read" (AgentDeck sends it to the first available of: label of claude|credit:claude-haiku-5-5)\n- research: delegate_task with role "research" (AgentDeck sends it to the first available of: label of codex|gpt-5.6-terra; then label of claude|claude-haiku-5-5)',
    );
});

test('no offered route gives an empty hint', () => {
    assert.equal(
        taskRoleHint(state({ read: [''], research: [''] }), label),
        '',
    );
});

test('an id from before the grouping is read as its new role', () => {
    assert.equal(canonicalRole('image'), 'read');
    assert.equal(canonicalRole('files'), 'read');
    assert.equal(canonicalRole('documents'), 'read');
    assert.equal(canonicalRole('web'), 'research');
    assert.equal(canonicalRole('security'), 'security');
    assert.equal(canonicalRole('coding'), 'coding');
    assert.equal(canonicalRole('refactor'), 'refactor');
    assert.equal(canonicalRole('summary'), 'text');
    assert.equal(canonicalRole('research'), 'research');
    assert.equal(canonicalRole('nope'), undefined);
});

test('saved routes under old ids move into the new roles, in order, without duplicates', () => {
    assert.deepEqual(
        migrateRoutes({ image: ['a|1'], files: ['b|2', 'a|1'], web: ['c|3'] }),
        { read: ['a|1', 'b|2'], research: ['c|3'] },
    );
});

test('a new role is off after migration only when every old role with picks is off', () => {
    const saved = { image: ['a|1'], files: ['b|2'] };
    assert.deepEqual(migrateOff(['image'], saved), []);
    assert.deepEqual(migrateOff(['image', 'files'], saved), ['read']);
    assert.deepEqual(migrateOff([], { web: [] }), []);
});

test('a delegate_task command names its role, and a call without one names none', () => {
    assert.equal(
        roleOfCall(
            'mcp__agentdeck__delegate_task  {"role":"research","task":"find it"}',
        ),
        'research',
    );
    assert.equal(
        roleOfCall(
            'mcp__agentdeck__delegate_task  {"role":"web","task":"find it"}',
        ),
        'research',
    );
    assert.equal(
        roleOfCall('agentdeck.delegate_task {"agent":"codex","task":"x"}'),
        undefined,
    );
    assert.equal(
        roleOfCall('agentdeck.delegate_task {"role":"nope"}'),
        undefined,
    );
    assert.equal(roleOfCall('delegate_task'), undefined);
});

test('every role has a running and a done text', () => {
    for (const role of TASK_ROLES)
        assert.ok(
            ROLE_STATUS[role.id].running && ROLE_STATUS[role.id].done,
            role.id,
        );
});
