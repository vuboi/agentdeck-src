import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_PROMPT_SUGGESTIONS,
    addPromptSuggestion,
    mergePromptSuggestions,
} from './prompt-suggestions.ts';

test('empty and repeated suggestions are skipped, ignoring case and punctuation', () => {
    const items = addPromptSuggestion([], '  Run the tests. ');
    assert.deepEqual(addPromptSuggestion(items, 'run the tests'), items);
    assert.deepEqual(addPromptSuggestion(items, '   '), items);
});

test('at most three suggestions, the first ones given', () => {
    const merged = mergePromptSuggestions(['a', 'b'], ['c', 'd']);
    assert.deepEqual(merged, ['a', 'b', 'c']);
    assert.equal(merged.length, MAX_PROMPT_SUGGESTIONS);
});
