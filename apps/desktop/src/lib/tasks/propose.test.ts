import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cardActions,
    checkProposal,
    parseProposal,
    proposalOfCommand,
    workerCallsOf,
} from './propose.ts';

const task = (
    title: string,
    writeScope: string[],
    dependsOn: string[] = [],
) => ({
    title,
    brief: `${title}: do the part`,
    write_scope: writeScope,
    ...(dependsOn.length ? { depends_on: dependsOn } : {}),
});

const split = (tasks: unknown[]) => ({ title: 'Export and tests', tasks });

test('disjoint write scopes run in parallel', () => {
    const parsed = parseProposal(
        split([task('pdf', ['src/export']), task('dark', ['src/theme'])]),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    const check = checkProposal(parsed.proposal);
    assert.equal(check.parallel, true);
    assert.deepEqual(
        check.tasks.map((item) => item.mode),
        ['parallel', 'parallel'],
    );
});

test('a task whose scope overlaps an earlier one runs after it', () => {
    const parsed = parseProposal(
        split([
            task('pdf', ['src/export']),
            task('pdf tests', ['src/export/pdf.test.ts']),
        ]),
    );
    assert.ok(parsed.ok);
    const check = checkProposal(parsed.proposal);
    assert.equal(check.parallel, false);
    assert.equal(check.tasks[0].mode, 'parallel');
    assert.equal(check.tasks[1].mode, 'sequential');
    assert.match(check.tasks[1].why[0], /same files as "pdf"/);
});

test('a task that depends on another runs after it', () => {
    const parsed = parseProposal(
        split([
            task('schema', ['src/db']),
            task('api', ['src/api'], ['schema']),
        ]),
    );
    assert.ok(parsed.ok);
    const check = checkProposal(parsed.proposal);
    assert.equal(check.parallel, false);
    assert.equal(check.tasks[1].mode, 'sequential');
    assert.match(check.tasks[1].why[0], /depends on "schema"/);
});

test('scopes are compared as folders: a shared prefix of a name is not an overlap', () => {
    const parsed = parseProposal(
        split([task('a', ['src/ab']), task('b', ['src\\a/'])]),
    );
    assert.ok(parsed.ok);
    assert.equal(checkProposal(parsed.proposal).parallel, true);
    const nested = parseProposal(
        split([task('a', ['./src/']), task('b', ['SRC\\Export\\x.ts'])]),
    );
    assert.ok(nested.ok);
    assert.equal(checkProposal(nested.proposal).parallel, false);
});

test('a scope of the whole repository overlaps every task', () => {
    const parsed = parseProposal(
        split([task('a', ['src/a']), task('b', ['.'])]),
    );
    assert.ok(parsed.ok);
    assert.equal(checkProposal(parsed.proposal).tasks[1].mode, 'sequential');
});

test('a dependency must name another task of the list, and cycles are refused', () => {
    const unknown = parseProposal(
        split([task('a', ['x']), task('b', ['y'], ['nope'])]),
    );
    assert.equal(unknown.ok, false);
    const self = parseProposal(
        split([task('a', ['x'], ['a']), task('b', ['y'])]),
    );
    assert.equal(self.ok, false);
    const cycle = parseProposal(
        split([task('a', ['x'], ['b']), task('b', ['y'], ['a'])]),
    );
    assert.equal(cycle.ok, false);
});

test('the shape is checked like the Rust side: count, fields, isolation', () => {
    assert.equal(parseProposal(split([task('a', ['x'])])).ok, false);
    assert.equal(
        parseProposal(split([task('a', ['x']), task('b', [])])).ok,
        false,
    );
    assert.equal(
        parseProposal({
            ...split([task('a', ['x']), task('b', ['y'])]),
            isolation: 'everywhere',
        }).ok,
        false,
    );
    const shared = parseProposal({
        ...split([task('a', ['x']), task('b', ['y'])]),
        isolation: 'shared',
    });
    assert.ok(shared.ok);
    assert.equal(shared.proposal.isolation, 'shared');
    const worktree = parseProposal(split([task('a', ['x']), task('b', ['y'])]));
    assert.ok(worktree.ok);
    assert.equal(worktree.proposal.isolation, 'worktree');
});

test('the call line of propose_session is read; a cut-off line is not a proposal', () => {
    const line = `propose_session ${JSON.stringify(split([task('a', ['x']), task('b', ['y'])]))}`;
    const read = proposalOfCommand(line);
    assert.ok(read.ok);
    assert.equal(read.proposal.tasks.length, 2);
    assert.equal(proposalOfCommand(line.slice(0, 40)).ok, false);
});

const proposalOf = (raw: unknown) => {
    const parsed = parseProposal(raw);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    return parsed.proposal;
};

test('the card buttons follow the check and the state kept in the message', () => {
    const parallel = checkProposal(
        proposalOf(split([task('a', ['x']), task('b', ['y'])])),
    );
    assert.deepEqual(cardActions(parallel, undefined), {
        visible: true,
        split: true,
        chat: true,
        dismiss: true,
    });
    const overlapping = checkProposal(
        proposalOf(split([task('a', ['x']), task('b', ['x/y'])])),
    );
    assert.equal(cardActions(overlapping, undefined).split, false);
    assert.equal(cardActions(overlapping, undefined).chat, true);
    assert.equal(cardActions(parallel, { state: 'split' }).split, false);
    assert.equal(cardActions(parallel, { state: 'chat' }).chat, false);
    assert.equal(cardActions(parallel, { state: 'dismissed' }).visible, false);
});

test('each task becomes one worker call: worktree, wait false, the parent agent, its write scope', () => {
    const parsed = parseProposal(
        split([task('pdf', ['src/export']), task('dark', ['src/theme'])]),
    );
    assert.ok(parsed.ok);
    const calls = workerCallsOf(parsed.proposal, {
        agent: 'claude',
        model: 'sonnet-4',
    });
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.isolation, 'worktree');
        assert.equal(call.wait, false);
        assert.equal(call.agent, 'claude');
        assert.equal(call.model, 'sonnet-4');
    }
    assert.match(calls[0].task, /pdf: do the part/);
    assert.match(calls[0].task, /Write only inside: src\/export/);
    assert.match(calls[1].task, /Write only inside: src\/theme/);
});
