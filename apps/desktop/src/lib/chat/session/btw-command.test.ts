import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btwQuestionOf } from './btw-command.ts';

test('a /btw line carries its question', () => {
    assert.equal(
        btwQuestionOf('/btw what does this function do?'),
        'what does this function do?',
    );
    assert.equal(btwQuestionOf('/btw\nline two'), 'line two');
});

test('/btw alone is a command with no question, and other text is not /btw', () => {
    assert.equal(btwQuestionOf('/btw'), '');
    assert.equal(btwQuestionOf('  /btw  '), '');
    assert.equal(btwQuestionOf('/btwx hello'), null);
    assert.equal(btwQuestionOf('hello /btw there'), null);
    assert.equal(btwQuestionOf('/compact'), null);
});
