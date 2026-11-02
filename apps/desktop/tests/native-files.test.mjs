import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { historyWith, native, row } from './support/history-harness.mjs';

/** The chat `chat` on Claude's file `/c1.jsonl`, with the same five messages as the snapshot fixture. */
const claudeFile = [
    native('u1', 'user', '2026-11-03T01:00:00Z', 'first question'),
    native('a1', 'assistant', '2026-11-03T01:00:05Z', 'first answer'),
    native('u2', 'user', '2026-11-03T03:00:00Z', 'second question'),
    native('a2', 'assistant', '2026-11-03T03:00:09Z', 'second answer'),
    native('u3', 'user', '2026-11-03T05:00:00Z', 'third question'),
];

/** Two Codex turns kept in `otherTurns` (the turns of the other agent), as `keepOtherTurn` stores them. */
const keptCodexTurns = [
    {
        id: 'turn-ask',
        role: 'user',
        time: '',
        at: '2026-11-03T02:00:00Z',
        blocks: [{ kind: 'response', text: 'asked in codex' }],
    },
    {
        id: 'turn-reply',
        role: 'assistant',
        time: '',
        at: '2026-11-03T02:00:20Z',
        agent: 'codex',
        blocks: [{ kind: 'response', text: 'codex answer' }],
    },
];

const chatSession = (extra = {}) => ({
    id: 'chat',
    source: 'claude',
    path: '/c1.jsonl',
    updatedAt: '2026-11-03T05:00:00Z',
    messageCount: 5,
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    title: 'Chat',
    projectId: 'p',
    status: 'idle',
    agentSession: 'C1',
    ...extra,
});

test('N4: a chat with one native file reads exactly as before (snapshot)', async () => {
    const expected = JSON.parse(
        readFileSync(
            new URL(
                './fixtures/native-single-file.snapshot.json',
                import.meta.url,
            ),
            'utf8',
        ),
    );
    for (const [name, others] of [
        ['noOthers', undefined],
        ['withOthers', { chat: keptCodexTurns }],
    ]) {
        const { api, workspace } = await historyWith({
            rows: [
                row('claude:C1', 'claude', '/c1.jsonl', { message_count: 5 }),
            ],
            files: { '/c1.jsonl': claudeFile },
            sessions: [chatSession()],
            otherTurns: others,
        });
        await api.openTranscript(workspace.sessions[0]);
        const opened = JSON.parse(JSON.stringify(api.chat.messages));
        const exported = await api.conversationForExport('chat');
        assert.deepEqual(
            opened,
            expected[name].opened,
            `${name}: the chat as opened`,
        );
        assert.deepEqual(
            JSON.parse(JSON.stringify(exported.messages)),
            expected[name].exported,
            `${name}: the export`,
        );
    }
});

test('N4.1: a chat keeps the native files it was read from when its provider state is saved again', async () => {
    const paths = [
        { source: 'claude', path: '/c1.jsonl', nativeId: 'claude:C1' },
        { source: 'codex', path: '/t2.jsonl', nativeId: 'codex:T2' },
    ];
    const { api, workspace, prefs } = await historyWith({
        mixed: {
            chat: {
                agent: 'codex',
                agents: ['claude', 'codex'],
                source: 'claude',
                firstAgent: 'claude',
                agentSession: 'C1',
                agentIds: { codex: { id: 'T2' } },
                providerAliases: ['claude:C1', 'codex:T2'],
                paths,
            },
        },
        sessions: [
            chatSession({
                agent: 'codex',
                agents: ['claude', 'codex'],
                agentIds: { codex: { id: 'T2' } },
            }),
        ],
    });
    api.rememberMixed(workspace.sessions[0]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(prefs['chat.mixed'].chat.paths, paths);
});
