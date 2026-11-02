import assert from 'node:assert/strict';
import test from 'node:test';
import {
    pageAddress,
    samePreviewAddress,
    serverOf,
} from './preview-address.ts';

test('one server is one tab, whatever the route or the local host name', () => {
    assert.equal(
        serverOf('http://localhost:4301/settings'),
        serverOf('http://127.0.0.1:4301/'),
    );
    assert.notEqual(
        serverOf('http://localhost:4301/'),
        serverOf('http://localhost:4302/'),
    );
});

test('a template or a sentence is not a page address', () => {
    assert.equal(pageAddress('http://localhost:{port}/'), undefined);
    assert.equal(pageAddress('http://localhost:{{port}}/'), undefined);
    assert.equal(pageAddress('http://localhost:{{port]'), undefined);
    assert.equal(pageAddress('ftp://localhost:4301/'), undefined);
    assert.equal(
        pageAddress('http://localhost:4301/voc.'),
        'http://localhost:4301/voc',
    );
    assert.equal(pageAddress('http://localhost:4301'), 'http://localhost:4301');
});

test('reuses a Preview tab across local host aliases and root slash variants', () => {
    assert.equal(
        samePreviewAddress('http://localhost:4301', 'http://127.0.0.1:4301/'),
        true,
    );
    assert.equal(
        samePreviewAddress('http://0.0.0.0:4301/', 'http://[::1]:4301'),
        true,
    );
});

test('keeps different local servers and routes distinct', () => {
    assert.equal(
        samePreviewAddress('http://localhost:4301/', 'http://localhost:4302/'),
        false,
    );
    assert.equal(
        samePreviewAddress(
            'http://localhost:4301/',
            'http://localhost:4301/settings',
        ),
        false,
    );
});
