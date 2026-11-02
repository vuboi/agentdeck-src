import assert from 'node:assert/strict';
import test from 'node:test';
import { isMarkdownText } from './composer-helpers.ts';

test('real Markdown becomes a .md attachment', () => {
    assert.equal(isMarkdownText('# Title\n\nSome **bold** text'), true);
    assert.equal(isMarkdownText('```ts\nconst a = 1;\n```'), true);
});

test('HTML and source code stay plain text even with Markdown-like marks', () => {
    assert.equal(
        isMarkdownText(
            '<!doctype html>\n<html><body><ul>\n- a\n</ul></body></html>',
        ),
        false,
    );
    assert.equal(
        isMarkdownText('const total = a ** 2 * b ** 3;\n- nothing'),
        false,
    );
    assert.equal(isMarkdownText('import { x } from "y";\n`z`'), false);
});

test('plain prose is not Markdown', () => {
    assert.equal(
        isMarkdownText('Please check the build log and tell me why it failed.'),
        false,
    );
});
