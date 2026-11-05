import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ARTIFACT_CSP, previewDocument } from './preview.ts';

test('puts trusted CSP before artifact HTML', () => {
    const html = previewDocument(
        '<!doctype html><html><head><title>x</title></head><body><script>fetch("https://example.com")</script></body></html>',
        'html',
    );
    assert.equal((html.match(/Content-Security-Policy/g) ?? []).length, 1);
    assert.ok(
        html.indexOf(`content="${ARTIFACT_CSP}"`) < html.indexOf('<script>'),
    );
    assert.match(ARTIFACT_CSP, /default-src 'none'/);
    assert.doesNotMatch(ARTIFACT_CSP, /https?:|connect-src/);
});

test('wraps SVG as a document inside the sandboxed frame', () => {
    const html = previewDocument('<circle cx="4" cy="4" r="2"/>', 'svg');
    assert.match(html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"><circle/);
    assert.match(html, /Content-Security-Policy/);
});

test('a fake head in a leading comment cannot swallow the trusted CSP', () => {
    const html = previewDocument(
        '<!-- <head> -->\n<script>fetch("https://example.com")</script>',
        'html',
    );
    const firstPolicy = html.indexOf(`content="${ARTIFACT_CSP}"`);
    assert.ok(firstPolicy >= 0);
    assert.ok(firstPolicy < html.indexOf('<!-- <head> -->'));
    assert.ok(firstPolicy < html.indexOf('<script>'));
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

test('Save as copies the selected version through the native dialog', async () => {
    const component = await readFile(
        new URL('../components/canvas/CanvasView.svelte', import.meta.url),
        'utf8',
    );
    assert.match(component, /invoke<string \| null>\('file_copy_as'/);
    assert.match(component, /joinPath\(current\.path, version\.file\)/);
    assert.doesNotMatch(component, /invoke\('file_write'/);
    assert.match(component, /else toast\.info\('Save cancelled'\)/);
});
