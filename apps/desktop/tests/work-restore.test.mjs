import assert from 'node:assert/strict';
import test from 'node:test';
import { historyWith, native, row } from './support/history-harness.mjs';

const chatSession = () => ({
    id: 'chat',
    source: 'claude',
    path: '/c1.jsonl',
    updatedAt: '2026-11-03T01:02:00Z',
    messageCount: 2,
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    title: 'Chat',
    projectId: 'p',
    status: 'idle',
    agentSession: 'C1',
});

/** The live reply as archived: its text and the delegate_task call that started a worker. */
const liveReply = {
    id: 'live-a1',
    role: 'assistant',
    time: '',
    at: '2026-11-03T01:00:05Z',
    agent: 'claude',
    blocks: [
        { kind: 'response', text: 'Done A' },
        { kind: 'command', command: 'delegate_task', output: '', taskId: 't1' },
    ],
};

const archivedReply = (extra = {}) => ({
    id: 'live-a1',
    sessionId: 'chat',
    role: 'assistant',
    at: '2026-11-03T01:00:05Z',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    text: 'Done A',
    tools: 1,
    tokens: null,
    context: null,
    cost: null,
    ms: null,
    snapshot: liveReply,
    savedAt: '2026-11-03T01:02:00Z',
    ...extra,
});

const hasTask = (message, taskId) =>
    message.blocks.some(
        (block) => block.kind === 'command' && block.taskId === taskId,
    );

async function openWith(files, archived) {
    const { api, workspace } = await historyWith({
        rows: [row('claude:C1', 'claude', '/c1.jsonl', { message_count: 2 })],
        files: { '/c1.jsonl': files },
        sessions: [chatSession()],
        archived,
    });
    await api.openTranscript(workspace.sessions[0]);
    await api.transcriptSettled();
    return api.chat.messages;
}

test('a reply whose work card is archived keeps the card when the file holds the same reply', async () => {
    const messages = await openWith(
        [
            native('u1', 'user', '2026-11-03T01:00:00Z', 'start'),
            native('a1', 'assistant', '2026-11-03T01:00:05Z', 'Done A'),
        ],
        [archivedReply()],
    );
    const reply = messages.find((message) => message.role === 'assistant');
    assert.ok(reply, 'the reply is shown');
    assert.ok(hasTask(reply, 't1'), 'the delegate_task card comes back');
});

test('a reply that the file holds with a follow-up in the same message keeps its work card', async () => {
    // Claude writes the follow-up of a background result into the same assistant message: its text is longer
    // than the archived reply, so the exact text match used to drop the work card.
    const messages = await openWith(
        [
            native('u1', 'user', '2026-11-03T01:00:00Z', 'start'),
            {
                id: 'a1',
                role: 'assistant',
                time: '2026-11-03T01:00:05Z',
                blocks: [
                    { kind: 'response', text: 'Done A' },
                    { kind: 'response', text: 'Follow-up B' },
                ],
            },
        ],
        [archivedReply()],
    );
    const reply = messages.find((message) => message.role === 'assistant');
    assert.ok(hasTask(reply, 't1'), 'the delegate_task card comes back');
    assert.ok(
        reply.blocks.some(
            (block) =>
                block.kind === 'response' && block.text === 'Follow-up B',
        ),
        'the follow-up text stays after the card',
    );
});
