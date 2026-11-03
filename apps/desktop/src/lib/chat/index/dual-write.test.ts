import assert from 'node:assert/strict';
import test from 'node:test';
import { createDualWriter, type ChatMeta } from './dual-write.ts';

/** What a command was called with: only the fields these tests read. */
type Args = {
    chat?: ChatMeta;
    chatId?: string;
    messages?: {
        role: string;
        bindingId: string | null;
        native: unknown;
        blocks: { text: string }[];
    }[];
    binding?: { id: string; provider: string; nativeId: string; state: string };
    id?: string;
    beforeSeq?: number | null;
    limit?: number;
};
type Call = { command: string; args: Args };

/** A fake clock: `advance` runs the timers that are due, in order. */
function clock() {
    let now = 0;
    const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
    return {
        setTimer(run: () => void, ms: number) {
            const timer = { at: now + ms, run, cancelled: false };
            timers.push(timer);
            return timer;
        },
        clearTimer(handle: { cancelled: boolean }) {
            handle.cancelled = true;
        },
        advance(ms: number) {
            now += ms;
            for (const timer of timers.filter(
                (t) => !t.cancelled && t.at <= now,
            )) {
                timer.cancelled = true;
                timer.run();
            }
        },
    };
}

/** An `invoke` that records each call; `answer` decides what a command returns (or throws). */
function fakeInvoke(answer: (call: Call) => unknown = () => undefined) {
    const calls: Call[] = [];
    const invoke = async (command: string, args: Args = {}) => {
        const call = { command, args };
        calls.push(call);
        return answer(call);
    };
    return { calls, invoke };
}

const chat: ChatMeta = {
    id: 'chat-1',
    title: 'First chat',
    projectId: null,
    cwd: null,
    activeAgent: 'claude',
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-03T00:00:00Z',
};

const turn = (
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
) => ({
    id,
    role: id.startsWith('u') ? ('user' as const) : ('assistant' as const),
    time: '',
    at: '2026-11-03T01:00:00Z',
    agent: 'claude',
    blocks: [{ kind: 'response' as const, text }],
    ...extra,
});

const names = (calls: Call[]) => calls.map((call) => call.command);
const texts = (call: Call) =>
    (call.args.messages ?? []).map((m) => m.blocks[0].text);

function setup(enabled: boolean, answer?: (call: Call) => unknown) {
    const timers = clock();
    const { calls, invoke } = fakeInvoke(answer);
    const errors: { command: string; error: unknown }[] = [];
    const mismatches: { chatId: string; detail: string }[] = [];
    const writer = createDualWriter({
        invoke,
        enabled: () => enabled,
        onError: (command: string, error: unknown) =>
            errors.push({ command, error }),
        onMismatch: (chatId: string, detail: string) =>
            mismatches.push({ chatId, detail }),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        debounceMs: 500,
    });
    return { writer, timers, calls, errors, mismatches };
}

test('N5.1 flag off: no command is sent, whatever the chat does', async () => {
    const { writer, timers, calls } = setup(false);
    writer.bindNative(chat, 'claude', 'uuid-1', 0);
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    writer.remove(chat.id);
    timers.advance(5000);
    await writer.idle();
    assert.deepEqual(calls, []);
});

test('N5.1 flag on: save, bind, append, delete go out in that order', async () => {
    const { writer, calls } = setup(true);
    writer.bindNative(chat, 'claude', 'uuid-1', 0);
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    writer.remove(chat.id);
    await writer.idle();
    assert.deepEqual(names(calls), [
        'chat_save',
        'chat_bind',
        'chat_append',
        'chat_delete',
    ]);
    assert.deepEqual(calls[0].args, { chat });
    assert.equal(calls[1].args.chatId, 'chat-1');
    assert.equal(calls[1].args.binding?.provider, 'claude');
    assert.equal(calls[1].args.binding?.nativeId, 'uuid-1');
    assert.equal(calls[1].args.binding?.state, 'live');
    assert.deepEqual(
        (calls[2].args.messages ?? []).map((m) => m.role),
        ['user', 'assistant'],
    );
    assert.deepEqual(calls[3].args, { chatId: 'chat-1' });
});

test('N5.1 debounce: three finished turns within 500 ms become one chat_append, in order', async () => {
    const { writer, timers, calls } = setup(true);
    writer.recordTurn(chat, [turn('u1', 'q1'), turn('a1', 'a1')], 'done');
    timers.advance(200);
    writer.recordTurn(chat, [turn('u2', 'q2'), turn('a2', 'a2')], 'done');
    timers.advance(200);
    writer.recordTurn(chat, [turn('u3', 'q3'), turn('a3', 'a3')], 'done');
    timers.advance(499);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save']);
    timers.advance(1);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save', 'chat_append']);
    assert.deepEqual(texts(calls[1]), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
});

test('N5.1 only a finished turn is written: an error, or a reply still streaming, writes nothing', async () => {
    const { writer, timers, calls } = setup(true);
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'error');
    writer.recordTurn(
        chat,
        [turn('u2', 'q'), turn('a2', 'partial', { live: true })],
        'done',
    );
    timers.advance(5000);
    await writer.idle();
    assert.deepEqual(calls, []);
    // Once the reply has finished, the same turn is written.
    writer.recordTurn(chat, [turn('u2', 'q'), turn('a2', 'full')], 'done');
    timers.advance(500);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save', 'chat_append']);
    assert.deepEqual(texts(calls[1]), ['q', 'full']);
});

test('N5.1 a turn already sent is not sent again; the chat is saved once', async () => {
    const { writer, timers, calls } = setup(true);
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    timers.advance(500);
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    writer.recordTurn(chat, [turn('u2', 'q2'), turn('a2', 'a2')], 'done');
    timers.advance(500);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save', 'chat_append', 'chat_append']);
    assert.deepEqual(texts(calls[1]), ['q', 'a']);
    assert.deepEqual(texts(calls[2]), ['q2', 'a2']);
});

test('N5.1 a turn sent after a bind carries the binding id of its provider', async () => {
    const { writer, timers, calls } = setup(true);
    writer.bindNative(chat, 'claude', 'uuid-1', 0);
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    timers.advance(500);
    await writer.idle();
    const bound = calls.find((call) => call.command === 'chat_bind');
    const append = calls.find((call) => call.command === 'chat_append');
    assert.ok(bound && append);
    assert.equal(append.args.messages?.[1].bindingId, bound.args.binding?.id);
    assert.equal(append.args.messages?.[0].native, null);
});

test('N5.1 the same native session is bound once', async () => {
    const { writer, calls } = setup(true);
    writer.bindNative(chat, 'claude', 'uuid-1', 0);
    writer.bindNative(chat, 'claude', 'uuid-1', 0);
    writer.bindNative(chat, 'codex', 'thread-9', 0);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save', 'chat_bind', 'chat_bind']);
});

test('N5.1 a failed command is reported and the queue goes on', async () => {
    const { writer, timers, calls, errors } = setup(true, (call) => {
        if (call.command === 'chat_append')
            throw new Error('database is locked');
        return undefined;
    });
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    timers.advance(500);
    writer.remove(chat.id);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save', 'chat_append', 'chat_delete']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].command, 'chat_append');
});

/** A `chat_open` page of the ledger holding turns with these seqs. */
const page = (seqs: number[], hasMore: boolean) => ({
    chat,
    bindings: [],
    messages: seqs.map((seq) => ({
        seq,
        role: 'user',
        agent: null,
        model: null,
        bindingId: null,
        time: '',
        native: null,
        blocks: [],
    })),
    hasMore,
});

test('N5.2 flag off: a shadow read sends nothing and logs nothing', async () => {
    const { writer, calls, mismatches } = setup(false);
    writer.shadowRead('chat-1', 3);
    await writer.idle();
    assert.deepEqual(calls, []);
    assert.deepEqual(mismatches, []);
});

test('N5.2 a shadow read comes after the turns still waiting in their debounce window', async () => {
    const { writer, calls, mismatches } = setup(true, (call) =>
        call.command === 'chat_open' ? page([1, 2], false) : undefined,
    );
    writer.recordTurn(chat, [turn('u1', 'q'), turn('a1', 'a')], 'done');
    writer.shadowRead('chat-1', 2);
    await writer.idle();
    assert.deepEqual(names(calls), ['chat_save', 'chat_append', 'chat_open']);
    assert.deepEqual(mismatches, []);
});

test('N5.2 the ledger count is read page by page, from the newest page back', async () => {
    const { writer, calls, mismatches } = setup(true, (call) => {
        if (call.command !== 'chat_open') return undefined;
        return call.args.beforeSeq == null
            ? page([3, 4], true)
            : page([1, 2], false);
    });
    writer.shadowRead('chat-1', 4);
    await writer.idle();
    assert.deepEqual(
        calls.map((call) => call.args.beforeSeq ?? null),
        [null, 3],
    );
    assert.deepEqual(mismatches, []);
});

test('N5.2 counts that differ are logged as a chat index mismatch', async () => {
    const { writer, mismatches, errors } = setup(true, (call) =>
        call.command === 'chat_open' ? page([1, 2], false) : undefined,
    );
    writer.shadowRead('chat-1', 3);
    await writer.idle();
    assert.deepEqual(mismatches, [
        { chatId: 'chat-1', detail: 'local 3, ledger 2' },
    ]);
    assert.deepEqual(errors, []);
});

test('N5.2 equal counts log nothing', async () => {
    const { writer, mismatches } = setup(true, (call) =>
        call.command === 'chat_open' ? page([1, 2], false) : undefined,
    );
    writer.shadowRead('chat-1', 2);
    await writer.idle();
    assert.deepEqual(mismatches, []);
});

test('N5.2 a chat the ledger does not have is a mismatch only when the app has turns for it', async () => {
    const { writer, mismatches } = setup(true, (call) =>
        call.command === 'chat_open' ? null : undefined,
    );
    writer.shadowRead('chat-1', 2);
    writer.shadowRead('chat-2', 0);
    await writer.idle();
    assert.deepEqual(mismatches, [
        { chatId: 'chat-1', detail: 'chat missing in ledger, local 2' },
    ]);
});

test('N5.2 a failed read is a command error, not a mismatch', async () => {
    const { writer, mismatches, errors } = setup(true, (call) => {
        if (call.command === 'chat_open') throw new Error('database is locked');
        return undefined;
    });
    writer.shadowRead('chat-1', 2);
    await writer.idle();
    assert.deepEqual(mismatches, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].command, 'chat_open');
});
