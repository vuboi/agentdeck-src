// Run with: node --test tests/derived-writes.test.mjs
// A function that writes reactive state, called while a row renders, throws state_unsafe_mutation and the chat row
// shows "This message could not be drawn" (v0.1.64: groupState in CommandGroup). The source must stay free of it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/check-derived-writes.mjs', import.meta.url);
const run = (dir) =>
    spawnSync(
        process.execPath,
        [script.pathname.replace(/^\/(\w:)/, '$1'), dir, '--strict'],
        {
            encoding: 'utf8',
        },
    );

test('no state writer is called inside $derived or a template in src', () => {
    const src = new URL('../src', import.meta.url).pathname.replace(
        /^\/(\w:)/,
        '$1',
    );
    const result = run(src);
    assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('the check finds a writer in $derived and in a template, and passes the read-only twins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'derived-writes-'));
    try {
        writeFileSync(
            join(dir, 'Bad.svelte'),
            '<script>\n  const view = $derived(editGroup(key));\n</script>\n<p>{messagesOf(id).length}</p>\n',
        );
        const bad = run(dir);
        assert.equal(bad.status, 1);
        assert.match(
            bad.stderr,
            /editGroup\( inside \$derived \(use groupView\)/,
        );
        assert.match(
            bad.stderr,
            /messagesOf\( in template \(use messagesView\)/,
        );

        rmSync(join(dir, 'Bad.svelte'));
        writeFileSync(
            join(dir, 'Good.svelte'),
            '<script>\n  const view = $derived(groupView(key));\n  function open() { editGroup(key).open = true; }\n</script>\n<p>{messagesView(id).length}</p>\n',
        );
        assert.equal(run(dir).status, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('R6.4: a wrapper that calls messagesOf is flagged in a template and in $derived too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'derived-writes-'));
    try {
        writeFileSync(
            join(dir, 'Wrapper.svelte'),
            '<script>\n  const view = $derived(handoffFor(id, text));\n</script>\n<p>{continueCurrentRun(id)}</p>\n',
        );
        const result = run(dir);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /handoffFor\( inside \$derived/);
        assert.match(result.stderr, /continueCurrentRun\( in template/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
