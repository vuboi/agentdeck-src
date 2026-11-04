import assert from 'node:assert/strict';
import test from 'node:test';
import { vendorOf } from './vendor-rows.ts';

const provider = (id: string, baseUrl: string, nativeAuth?: string) => ({
    id,
    baseUrl,
    nativeAuth,
});

test('a Command Code API key joins the command-code row whatever its saved id', () => {
    assert.equal(
        vendorOf(
            provider(
                'custom-mvy435cj',
                'https://api.commandcode.ai/provider/v1',
            ),
        ),
        'command-code',
    );
    assert.equal(
        vendorOf(
            provider(
                'connector-commandcode',
                'https://api.commandcode.ai/provider/v1',
            ),
        ),
        'command-code',
    );
});

test('Muse Code login and Muse API key join the muse-code row', () => {
    assert.equal(
        vendorOf(provider('muse-code', 'https://api.meta.ai/v1', 'muse-code')),
        'muse-code',
    );
    assert.equal(
        vendorOf(provider('custom-abc', 'https://api.meta.ai/v1')),
        'muse-code',
    );
    assert.equal(
        vendorOf(
            provider('custom-xyz', 'https://other.example/v1', 'muse-code'),
        ),
        'muse-code',
    );
});

test('other providers stay out of the vendor rows', () => {
    assert.equal(
        vendorOf(provider('custom-a', 'https://openrouter.ai/api/v1')),
        undefined,
    );
    assert.equal(
        vendorOf(
            provider('workbuddy', 'https://www.codebuddy.cn/v2', 'workbuddy'),
        ),
        undefined,
    );
    assert.equal(
        vendorOf(
            provider('custom-c', 'https://api.commandcode.ai.evil.example/v1'),
        ),
        undefined,
    );
    assert.equal(vendorOf(provider('custom-d', 'not a url')), undefined);
});
