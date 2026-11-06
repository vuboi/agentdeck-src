import assert from 'node:assert/strict';
import test from 'node:test';
import { chatFiles } from './chat-files.ts';

const file = (nativeId: string, path = `${nativeId}.jsonl`) => ({
    source: nativeId.split(':')[0] as 'claude' | 'codex',
    path,
    nativeId,
});

test('the index lists every file of the chat: all of them, in index order', () => {
    const indexed = [file('claude:new'), file('claude:old')];
    assert.deepEqual(
        chatFiles(indexed, undefined, ['claude:old', 'claude:new']),
        indexed,
    );
});

test('a file the index has not scanned yet stays while its id is still the chat’s alias', () => {
    // The index lags: only the first transcript is listed; the second was known before the scan.
    const indexed = [file('claude:old')];
    const known = [file('claude:old'), file('claude:new')];
    const out = chatFiles(indexed, known, ['claude:old', 'claude:new']);
    assert.deepEqual(
        out.map((item) => item.nativeId),
        ['claude:old', 'claude:new'],
    );
});

test('a known file whose id is no longer an alias of the chat is dropped', () => {
    const known = [file('claude:old'), file('codex:gone')];
    const out = chatFiles([file('claude:old')], known, ['claude:old']);
    assert.deepEqual(
        out.map((item) => item.nativeId),
        ['claude:old'],
    );
});

test('no duplicate when the index and the known list both have a file', () => {
    const out = chatFiles(
        [file('claude:a', 'index-path')],
        [file('claude:a', 'known-path')],
        ['claude:a'],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].path, 'index-path');
});

test('one file only: the caller sees a single file and keeps no list', () => {
    assert.equal(
        chatFiles([file('claude:a')], undefined, ['claude:a']).length,
        1,
    );
    assert.equal(chatFiles([], undefined, []).length, 0);
});
