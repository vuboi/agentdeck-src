import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveBinding,
    syncedThrough,
    type Bound,
    type ChatBindings,
    type LedgerTurn,
} from './binding.ts';

const bound = (over: Partial<Bound> = {}): Bound => ({
    id: 'native-1',
    started: true,
    model: 'm1',
    epoch: 0,
    syncedSeq: 0,
    ...over,
});

const user: LedgerTurn = {};
const claude: LedgerTurn = { agent: 'claude' };
const codex: LedgerTurn = { agent: 'codex' };

/** Claude answered turns 1-2; then the user asked turn 3 (seq 3, not in the ledger yet). */
const claudeChat = (over: Partial<ChatBindings> = {}): ChatBindings => ({
    bindings: { claude: bound({ syncedSeq: 2 }) },
    ledger: [user, claude],
    ...over,
});

test("same provider and model resumes and tells only the other providers' unseen turns", () => {
    const chat: ChatBindings = {
        bindings: { claude: bound({ syncedSeq: 2 }) },
        ledger: [user, claude, user, codex, codex, user],
    };
    const r = resolveBinding(chat, { agent: 'claude', model: 'm1', epoch: 0 });
    assert.equal(r.resume, true);
    assert.deepEqual(r.catchUp, [3, 4, 5, 6]);
    assert.deepEqual(r.closed, []);
    assert.equal(r.reason, undefined);
    assert.equal(r.binding.id, 'native-1');
});

test('same provider with a model change that does not keep the conversation starts anew and digests all', () => {
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm2',
        epoch: 0,
    });
    assert.equal(r.resume, false);
    assert.deepEqual(r.catchUp, [1, 2]);
    assert.deepEqual(r.closed, ['claude']);
    assert.equal(r.reason, 'model');
    assert.equal(r.binding.started, false);
    assert.equal(r.binding.model, 'm2');
    assert.equal(r.binding.syncedSeq, 0);
});

test('a live model change (Claude set_model) keeps the conversation and records the new model', () => {
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm2',
        epoch: 0,
        liveModel: true,
    });
    assert.equal(r.resume, true);
    assert.deepEqual(r.closed, []);
    assert.equal(r.binding.id, 'native-1');
    assert.equal(r.binding.model, 'm2');
});

test('an account change starts a new conversation with the account reason', () => {
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm1',
        epoch: 1,
    });
    assert.equal(r.resume, false);
    assert.equal(r.reason, 'account');
    assert.deepEqual(r.closed, ['claude']);
    assert.deepEqual(r.catchUp, [1, 2]);
    assert.equal(r.binding.epoch, 1);
});

test('an account change wins over a model change in the same turn', () => {
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm2',
        epoch: 1,
    });
    assert.equal(r.reason, 'account');
});

test('a provider new to the chat starts a conversation and gets the whole ledger', () => {
    const chat: ChatBindings = {
        bindings: { claude: bound({ syncedSeq: 2 }) },
        ledger: [user, claude, user, claude],
    };
    const r = resolveBinding(chat, { agent: 'codex', model: 'gpt', epoch: 0 });
    assert.equal(r.resume, false);
    assert.deepEqual(r.catchUp, [1, 2, 3, 4]);
    assert.deepEqual(r.closed, []);
    assert.equal(r.reason, undefined);
    assert.equal(r.binding.id, '');
});

test('a provider new to an empty chat has nothing to tell', () => {
    const r = resolveBinding(
        { bindings: {}, ledger: [] },
        { agent: 'claude', epoch: 0, mint: () => 'uuid' },
    );
    assert.equal(r.resume, false);
    assert.deepEqual(r.catchUp, []);
    assert.equal(r.binding.id, 'uuid');
});

test('coming back to a provider resumes it and tells only what it missed since its last turn', () => {
    // Claude (1,2) -> Codex answers (3,4) -> user (5) -> Claude again.
    const chat: ChatBindings = {
        bindings: {
            claude: bound({ syncedSeq: 2 }),
            codex: bound({ id: 'thread', syncedSeq: 4 }),
        },
        ledger: [user, claude, user, codex, codex, user],
    };
    const r = resolveBinding(chat, { agent: 'claude', model: 'm1', epoch: 0 });
    assert.equal(r.resume, true);
    assert.deepEqual(r.catchUp, [3, 4, 5, 6]);
});

test('Claude -> Codex -> Claude -> Copilot: each provider gets only what it has not seen', () => {
    // Turns: 1 user, 2 Claude, 3 user, 4 Codex, 5 user, 6 Claude (second Claude turn, after Codex).
    let ledger: LedgerTurn[] = [user, claude, user, codex, user, claude];
    const chat: ChatBindings = {
        bindings: {
            claude: bound({ syncedSeq: 2 }),
            codex: bound({ id: 'thread', syncedSeq: 4 }),
        },
        ledger,
    };
    // Back to Claude: it saw turns up to 2, so it is told the user and Codex turns after that (turn 6 is its own).
    const back = resolveBinding(chat, {
        agent: 'claude',
        model: 'm1',
        epoch: 0,
    });
    assert.deepEqual(back.catchUp, [3, 4, 5]);
    assert.equal(back.resume, true);

    // After Claude's reply (seq 8 in the ledger), Claude has seen everything.
    ledger = [...ledger, user, claude];
    const synced = syncedThrough(back.binding, 8);
    assert.equal(synced.syncedSeq, 8);

    // Copilot is new: it gets the whole ledger, its first turn has no own conversation yet.
    const copilotTurn = resolveBinding(
        {
            bindings: {
                claude: synced,
                codex: bound({ id: 'thread', syncedSeq: 4 }),
            },
            ledger,
        },
        { agent: 'copilot', model: 'gpt-5', epoch: 0 },
    );
    assert.equal(copilotTurn.resume, false);
    assert.deepEqual(copilotTurn.catchUp, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(copilotTurn.closed, []);
});

test('a conversation that never started is not resumed and digests the whole ledger', () => {
    const chat: ChatBindings = {
        bindings: { codex: bound({ id: '', started: false, syncedSeq: 0 }) },
        ledger: [user, codex],
    };
    const r = resolveBinding(chat, { agent: 'codex', model: 'm1', epoch: 0 });
    assert.equal(r.resume, false);
    assert.deepEqual(r.catchUp, [1, 2]);
});

test('a binding with a started flag but no id is not resumed', () => {
    const chat: ChatBindings = {
        bindings: { codex: bound({ id: '', started: true }) },
        ledger: [user],
    };
    const r = resolveBinding(chat, { agent: 'codex', model: 'm1', epoch: 0 });
    assert.equal(r.resume, false);
});

test('an edited message closes every conversation and digests the ledger that is left', () => {
    const chat: ChatBindings = {
        bindings: {
            claude: bound({ syncedSeq: 2 }),
            codex: bound({ id: 'thread', syncedSeq: 4 }),
        },
        ledger: [user, claude, user, codex],
    };
    const r = resolveBinding(chat, {
        agent: 'claude',
        model: 'm1',
        epoch: 0,
        edited: true,
        mint: () => 'fresh',
    });
    assert.equal(r.resume, false);
    assert.equal(r.reason, 'edit');
    assert.deepEqual(r.closed.sort(), ['claude', 'codex']);
    assert.deepEqual(r.catchUp, [1, 2, 3, 4]);
    assert.equal(r.binding.id, 'fresh');
});

test('an edit wins over a model change', () => {
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm2',
        epoch: 0,
        edited: true,
    });
    assert.equal(r.reason, 'edit');
});

test('a listener lane gets its own conversation: never resumed, never stored, nothing digested here', () => {
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm1',
        epoch: 0,
        listener: true,
        mint: () => 'lane',
    });
    assert.equal(r.resume, false);
    assert.deepEqual(r.catchUp, []);
    assert.deepEqual(r.closed, []);
    assert.equal(r.binding.id, 'lane');
});

test('syncedThrough moves the seen position forward and never backwards', () => {
    const b = bound({ syncedSeq: 5 });
    assert.equal(syncedThrough(b, 9).syncedSeq, 9);
    assert.equal(syncedThrough(b, 3).syncedSeq, 5);
    assert.equal(b.syncedSeq, 5);
});

test('mint is told why the conversation starts anew, so the id can follow the reason', () => {
    const asked: (string | undefined)[] = [];
    const mint = (reason?: 'account' | 'model' | 'edit') => {
        asked.push(reason);
        return `id-${reason ?? 'new'}`;
    };
    resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm1',
        epoch: 1,
        mint,
    });
    resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm2',
        epoch: 0,
        mint,
    });
    resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm1',
        epoch: 0,
        edited: true,
        mint,
    });
    resolveBinding(
        { bindings: {}, ledger: [] },
        { agent: 'codex', epoch: 0, mint },
    );
    assert.deepEqual(asked, ['account', 'model', 'edit', undefined]);
    const r = resolveBinding(claudeChat(), {
        agent: 'claude',
        model: 'm2',
        epoch: 0,
        mint,
    });
    assert.equal(r.binding.id, 'id-model');
});
