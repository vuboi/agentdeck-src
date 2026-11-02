// Run with: node --test tests/swap-line.test.mjs
// The title of a command group must be ONE SwapLine. When it sat in an {#if runningStep} branch, the step ending
// destroyed the SwapLine for a few ms and the next step's SwapLine started with shown='', so the text appeared at once
// (no slide) and the width jumped. The source is checked here because the component is not rendered in node.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (path) =>
    readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/);
const lines = read('../src/lib/components/chat/CommandGroup.svelte');
const source = lines.join('\n');
const swap = read('../src/lib/components/ui/SwapLine.svelte').join('\n');

test('the group title uses one SwapLine that is not inside a runningStep branch', () => {
    assert.doesNotMatch(source, /\{#if runningStep\}/);
    assert.doesNotMatch(source, /\{:else if working\}\s*\n\s*<ZShimmerText/);
    const titleLine = source.match(
        /<SwapLine\s+text=\{runningStep \? runningLine : summarize\(items\)\}\s+shimmer=\{Boolean\(runningStep\) \|\| working\}\s+class="font-medium"\s*\/>/,
    );
    assert.ok(titleLine, 'title SwapLine with the combined text and shimmer');
    // The live header keeps its own SwapLine; the title must be the only one with the combined text.
    assert.equal(source.match(/text=\{runningStep \? runningLine/g)?.length, 1);
});

test('SwapLine keys the swap on the shown line only, so a shimmer change does not replay the slide', () => {
    assert.match(swap, /\{#key shown\}/);
    assert.doesNotMatch(swap, /\{#key `\$\{shown\}\|/);
    assert.match(swap, /A shimmer change alone/);
});
