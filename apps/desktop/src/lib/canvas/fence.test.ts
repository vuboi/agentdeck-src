import assert from 'node:assert/strict';
import test from 'node:test';
import {
    artifactFenceSourceKey,
    artifactFences,
    isArtifactCommand,
    withoutArtifactFences,
} from './fence.ts';

test('parses complete supported artifact fences and preserves content', () => {
    const source =
        'Before\n```agentdeck-artifact title="Landing" kind="html"\n<h1>Hello</h1>\n```\nAfter';
    const fences = artifactFences(source);
    assert.equal(fences.length, 1);
    assert.deepEqual(
        {
            title: fences[0].title,
            kind: fences[0].kind,
            content: fences[0].content,
        },
        {
            title: 'Landing',
            kind: 'html',
            content: '<h1>Hello</h1>',
        },
    );
    assert.equal(withoutArtifactFences(source, fences), 'Before\n\nAfter');
});

test('ignores malformed, unsupported, and incomplete fences', () => {
    const source = [
        '```agentdeck-artifact title="No kind"',
        'x',
        '```',
        '```agentdeck-artifact title="Bad" kind="jsx"',
        '<App/>',
        '```',
        '```agentdeck-artifact title="Incomplete" kind="html"',
        '<b>x</b>',
    ].join('\n');
    assert.deepEqual(artifactFences(source), []);
});

test('recognizes only built-in artifact MCP commands for chat cards', () => {
    assert.equal(isArtifactCommand('artifact_create {"title":"x"}'), true);
    assert.equal(
        isArtifactCommand('mcp__agentdeck__artifact_update {"id":"a"}'),
        true,
    );
    assert.equal(isArtifactCommand('agentdeck.artifact_create {}'), true);
    assert.equal(isArtifactCommand('mcp__other__artifact_create {}'), false);
});

test('artifact fence identity survives block re-creation and separates reply fences', () => {
    const first = artifactFenceSourceKey('chat-a', 'message-7', 2, 18);
    const afterReload = artifactFenceSourceKey('chat-a', 'message-7', 2, 18);
    assert.equal(first, afterReload);
    assert.notEqual(
        first,
        artifactFenceSourceKey('chat-a', 'message-7', 3, 18),
    );
    assert.notEqual(
        first,
        artifactFenceSourceKey('chat-a', 'message-7', 2, 19),
    );
    assert.notEqual(
        first,
        artifactFenceSourceKey('chat-b', 'message-7', 2, 18),
    );
});
