import assert from 'node:assert/strict';
import test from 'node:test';
import {
    loadChatFromLedger,
    messageFromLedger,
    type LedgerRow,
} from './ledger-read.ts';

const row = (seq: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({
    seq,
    clientId: null,
    role: 'assistant',
    agent: 'claude',
    model: 'm1',
    time: '10:00',
    blocks: [{ kind: 'response', text: `t${seq}` }],
    ...extra,
});

test('a bare block list gets its id from the screen id, its time and model from the row', () => {
    const message = messageFromLedger(row(3, { clientId: 'screen-3' }));
    assert.equal(message.id, 'screen-3');
    assert.equal(message.time, '10:00');
    assert.equal(message.model, 'm1');
    assert.equal(message.agent, 'claude');
    assert.deepEqual(message.blocks, [{ kind: 'response', text: 't3' }]);
});

test('a bare block list without a screen id gets a stable ledger id', () => {
    assert.equal(messageFromLedger(row(7)).id, 'ledger-7');
});

test('a whole stored message keeps its fields, its own id wins', () => {
    const stored = {
        id: 'own-1',
        role: 'assistant',
        time: '09:00',
        at: '2026-11-03T01:00:00Z',
        ms: 1200,
        cost: 0.01,
        blocks: [{ kind: 'response', text: 'hi' }],
    };
    const message = messageFromLedger(
        row(4, { clientId: 'screen-4', blocks: stored }),
    );
    assert.equal(message.id, 'own-1');
    assert.equal(message.ms, 1200);
    assert.equal(message.cost, 0.01);
    assert.equal(message.at, '2026-11-03T01:00:00Z');
    assert.equal(message.time, '09:00');
});

test('a whole stored message without an id falls back to the screen id', () => {
    const message = messageFromLedger(
        row(5, { clientId: 'screen-5', blocks: { blocks: [] } }),
    );
    assert.equal(message.id, 'screen-5');
    assert.deepEqual(message.blocks, []);
});

/** A fake `chat_open` over `rows` (ascending seq), paged like the Rust side. */
function fakeLedger(rows: LedgerRow[]) {
    const calls: unknown[] = [];
    const invoke = async (
        _command: string,
        args: { beforeSeq: number | null; limit: number },
    ) => {
        calls.push(args);
        const below = rows.filter(
            (r) => args.beforeSeq === null || r.seq < args.beforeSeq,
        );
        const page = below.slice(-args.limit);
        return {
            chat: {},
            bindings: [],
            messages: page,
            hasMore: below.length > page.length,
        };
    };
    return { calls, invoke };
}

test('a long chat is read page by page and comes back oldest first', async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
        row(i + 1, { clientId: `m${i + 1}` }),
    );
    const { calls, invoke } = fakeLedger(rows);
    const messages = await loadChatFromLedger(invoke, 'chat-1');
    assert.equal(messages?.length, 120);
    assert.equal(messages?.[0].id, 'm1');
    assert.equal(messages?.[119].id, 'm120');
    assert.equal(calls.length, 3);
});

test('a chat the ledger does not have is null', async () => {
    const invoke = async () => null;
    assert.equal(await loadChatFromLedger(invoke, 'nope'), null);
});

test('a chat gone while older pages were read keeps the pages it already had', async () => {
    let call = 0;
    const invoke = async () => {
        call += 1;
        if (call === 1)
            return {
                chat: {},
                bindings: [],
                messages: [row(60, { clientId: 'a' })],
                hasMore: true,
            };
        return null;
    };
    const messages = await loadChatFromLedger(invoke, 'chat-1');
    assert.deepEqual(
        messages?.map((m) => m.id),
        ['a'],
    );
});
