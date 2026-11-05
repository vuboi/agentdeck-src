import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ARTIFACT_CSP, previewDocument } from './preview.ts';

test('inserts network-denying CSP before artifact HTML', () => {
    const html = previewDocument(
        '<!doctype html><html><head><title>x</title></head><body><script>fetch("https://example.com")</script></body></html>',
        'html',
    );
    assert.ok(
        html.indexOf(`content="${ARTIFACT_CSP}"`) < html.indexOf('<script>'),
    );
    assert.match(ARTIFACT_CSP, /default-src 'none'/);
    assert.doesNotMatch(ARTIFACT_CSP, /https?:|connect-src/);
});

test('wraps SVG as a document and keeps the raw SVG inside the frame', () => {
    const html = previewDocument('<circle cx="4" cy="4" r="2"/>', 'svg');
    assert.match(html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"><circle/);
    assert.match(html, /Content-Security-Policy/);
});

test('Canvas iframe has only script permission and no unsafe sandbox flags', async () => {
    const component = await readFile(
        new URL('../components/canvas/CanvasView.svelte', import.meta.url),
        'utf8',
    );
    assert.match(component, /sandbox="allow-scripts"/);
    assert.doesNotMatch(
        component,
        /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/,
    );
});
