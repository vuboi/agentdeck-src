import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ts = createRequire(import.meta.url)('typescript');

// Executes the actual event module and planOf parser. Only host I/O and unrelated session dependencies are stubbed.
// Run: node --experimental-vm-modules --test apps/desktop/src/lib/chat/session/plan-save.test.mjs
async function harness() {
    const calls = [];
    const errors = [];
    const session = { id: 'chat-a', agent: 'claude', projectId: 'project-a' };
    const project = { id: 'project-a', path: 'C:/fixture/project' };
    const context = vm.createContext({
        $state: (value) => value,
        $effect: Object.assign(() => {}, { root: () => {} }),
        console,
        Date,
        Map,
        Set,
        WeakMap,
        WeakSet,
        setTimeout,
        clearTimeout,
    });
    const modules = new Map();
    const stubs = {
        'svelte/reactivity': {
            SvelteMap: Map,
            SvelteSet: Set,
            SvelteDate: Date,
        },
        '../../app/platform/history': {
            inTauri: () => true,
            isPreviewCopy: () => false,
        },
        '../../app/platform/prefs': { getPref: async () => undefined },
        '../../app/platform/error-log.svelte': {
            logError: (...args) => errors.push(args),
        },
        './state.svelte': {
            projectOf: () => project,
            workspace: { sessions: [session], projects: [project] },
        },
        '../agent': { listenAgentEvents: () => {} },
        '../runs/change-ledger.svelte': { onUserFileSave: () => {} },
        '@tauri-apps/api/core': {
            invoke: async (command, args) => {
                calls.push({ command, ...args });
                return {
                    id: 'docs/plans/fixture.md',
                    path: `${args.root}/docs/plans/fixture.md`,
                };
            },
        },
    };
    async function source(file, expose = '') {
        const text = await readFile(new URL(file, import.meta.url), 'utf8');
        const code = ts.transpileModule(text + expose, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
            },
        }).outputText;
        const mod = new vm.SourceTextModule(code, {
            context,
            importModuleDynamically: async (name) => {
                const imported = await synthetic(name, ['invoke']);
                if (imported.status === 'unlinked')
                    await imported.link(() => {});
                if (imported.status === 'linked') await imported.evaluate();
                return imported;
            },
        });
        await mod.link(async (name) => {
            if (name === '../content/blocks')
                return source('../content/blocks.ts');
            // Stub all unrelated imports by their declared names. An accidental call fails instead of touching I/O.
            const declarations = [
                ...code.matchAll(/import \{([^}]+)\} from ['"]([^'"]+)['"]/g),
            ].filter((match) => match[2] === name);
            const names = declarations.flatMap((match) =>
                match[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]),
            );
            return synthetic(name, names);
        });
        return mod;
    }
    async function synthetic(name, names) {
        const key = `${name}:${names.join(',')}`;
        if (modules.has(key)) return modules.get(key);
        const values = stubs[name] ?? {};
        const mod = new vm.SyntheticModule(
            [...new Set(names)],
            function () {
                for (const key of new Set(names))
                    this.setExport(
                        key,
                        values[key] ??
                            (() => {
                                throw new Error(
                                    `Unexpected dependency: ${name}.${key}`,
                                );
                            }),
                    );
            },
            { context },
        );
        modules.set(key, mod);
        return mod;
    }
    const mod = await source(
        './events.svelte.ts',
        '\nexport { autoSavePlan as testAutoSavePlan };',
    );
    await mod.evaluate();
    const save = async (reply, event, permission, turn, start) => {
        mod.namespace.testAutoSavePlan(
            session,
            reply,
            event,
            permission,
            turn,
            start,
        );
        await new Promise((resolve) => setImmediate(resolve));
    };
    return { calls, errors, session, save };
}

test('Claude saves complete ExitPlanMode input once and attaches the saved path', async () => {
    const { calls, errors, save } = await harness();
    const reply = {
        agent: 'claude',
        blocks: [{ kind: 'command', id: 'call-a' }],
    };
    await save(reply, {
        kind: 'tool_call',
        name: 'ExitPlanMode',
        id: 'call-a',
        input: '{"plan":',
    });
    assert.equal(calls.length, 0);
    const event = {
        kind: 'tool_call',
        name: 'ExitPlanMode',
        id: 'call-a',
        input: JSON.stringify({ plan: '# Goal\n\n- [ ] work' }),
    };
    await save(reply, event);
    await save(reply, event);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, 'Goal');
    assert.equal(calls[0].source, 'exit-plan-mode');
    assert.equal(calls[0].chat, 'chat-a');
    assert.equal(reply.blocks[0].savedPlan.id, 'docs/plans/fixture.md');
    assert.deepEqual(errors, []);
});

test('Codex uses captured turn permission and final checklist once on success', async () => {
    const { calls, errors, session, save } = await harness();
    session.agent = 'claude'; // Current chat pick does not replace the actual turn agent.
    const reply = {
        agent: 'codex',
        blocks: [
            { kind: 'response', text: 'Preamble' },
            {
                kind: 'command',
                command: 'update_plan  [{"content":"old","status":"pending"}]',
            },
            { kind: 'response', text: '# Final plan\nRead and implement.' },
            {
                kind: 'command',
                command:
                    'update_plan  [{"content":"read","status":"completed"},{"content":"implement","status":"in_progress"}]',
            },
        ],
    };
    await save(reply, { kind: 'done', text: '' }, 'ask');
    assert.equal(calls.length, 0);
    await save(reply, { kind: 'error', message: 'failed' }, 'plan');
    assert.equal(calls.length, 0);
    await save(reply, { kind: 'done', text: '' }, 'plan');
    await save(reply, { kind: 'done', text: '' }, 'plan');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, 'codex');
    assert.equal(calls[0].source, 'codex-plan-mode');
    assert.equal(
        calls[0].body,
        '# Final plan\nRead and implement.\n\n## Steps\n- [x] read\n- [ ] implement',
    );
    assert.deepEqual(errors, []);
});

test('Codex uses explicit final answer and clips a headingless first sentence to 60 characters', async () => {
    const { calls, save } = await harness();
    const text = 'A'.repeat(70) + '. Second sentence.';
    await save(
        {
            agent: 'codex',
            blocks: [{ kind: 'response', text: 'Earlier reply' }],
        },
        { kind: 'done', text },
        'plan',
    );
    assert.equal(calls[0].body, text);
    assert.equal(calls[0].title, 'A'.repeat(60));
});

test('a continued reply saves each turn and does not append a previous turn checklist', async () => {
    const { calls, save } = await harness();
    const reply = {
        id: 'reply-a',
        agent: 'codex',
        blocks: [
            { kind: 'response', text: '# First plan' },
            {
                kind: 'command',
                command: 'update_plan  [{"content":"old","status":"pending"}]',
            },
        ],
    };
    await save(
        reply,
        { kind: 'done', text: '# First plan' },
        'plan',
        'turn-a',
        0,
    );
    reply.blocks.push({ kind: 'response', text: '# Revised plan' });
    await save(
        reply,
        { kind: 'done', text: '# Revised plan' },
        'plan',
        'turn-b',
        2,
    );
    await save(
        reply,
        { kind: 'done', text: '# Revised plan' },
        'plan',
        'turn-b',
        2,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body, '# Revised plan');
});
