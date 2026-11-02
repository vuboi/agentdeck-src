import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const src = (path) =>
    readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

// The three panels below opened the project folder for a chat in a worktree; they now open the chat's folder.
test('R5.6: terminal, browser and command panels use the chat folder (sessionCwd)', async () => {
    const terminal = await src('lib/components/terminal/Terminal.svelte');
    assert.match(terminal, /sessionCwd\(session\)/);
    assert.doesNotMatch(terminal, /projectOf\(session\)\?\.path/);

    const browser = await src('lib/components/browser/BrowserView.svelte');
    assert.match(browser, /sessionCwd\(session\)/);
    assert.doesNotMatch(browser, /projectOf\(session\)\?\.path/);

    const commands = await src('lib/components/chat/CommandGroup.svelte');
    assert.match(
        commands,
        /sessionCwd\(activeSession\(\)\)|sessionCwd\(session\)/,
    );
});

// The worktree of a worker row is looked up once per row (an @const), not once per use in the markup.
test('R5.9: DelegateList looks up a row worktree once', async () => {
    const list = await src('lib/components/tasks/DelegateList.svelte');
    const lookups = list.match(/worktreeOf\(block\.childId\)/g) ?? [];
    assert.equal(lookups.length, 1);
    assert.match(list, /\{@const wt = worktreeOf\(block\.childId\)\}/);
});
