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

test('N4.2: a chat whose history has two native files lists both, and the newest one stays its file', async () => {
    const mixed = {
        chat: {
            agent: 'codex',
            agents: ['claude', 'codex'],
            source: 'claude',
            firstAgent: 'claude',
            agentSession: 'C1',
            agentIds: { codex: { id: 'T2' } },
            providerAliases: ['claude:C1', 'codex:T2'],
        },
    };
    const rows = [
        row('codex:T2', 'codex', '/t2.jsonl', {
            updated_at: '2026-11-03T03:00:00Z',
            message_count: 2,
        }),
        row('claude:C1', 'claude', '/c1.jsonl', {
            updated_at: '2026-11-03T01:00:00Z',
            message_count: 3,
        }),
    ];
    const { api, workspace, prefs } = await historyWith({ mixed, rows });
    await api.importHistory({ refresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workspace.sessions.length, 1, 'both files are one chat');
    assert.equal(workspace.sessions[0].id, 'chat');
    assert.equal(
        workspace.sessions[0].path,
        '/t2.jsonl',
        'the newest file is the chat file, as before',
    );
    const files = prefs['chat.mixed'].chat.paths.map((file) => [
        file.source,
        file.path,
        file.messageCount,
    ]);
    assert.deepEqual(files.sort(), [
        ['claude', '/c1.jsonl', 3],
        ['codex', '/t2.jsonl', 2],
    ]);
});

test('N4.2: a chat with one native file gets no paths entry', async () => {
    const rows = [
        row('claude:C1', 'claude', '/c1.jsonl', { message_count: 3 }),
    ];
    const { api, prefs } = await historyWith({
        rows,
        sessions: [chatSession()],
    });
    await api.importHistory({ refresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prefs['chat.mixed']?.chat?.paths, undefined);
});

/** The texts of a list the module built in its own realm: `Array.from` makes the array in this one, so it compares equal. */
const textsOf = (list) => Array.from(list, (message) => message.blocks[0].text);

/** A chat that went Claude -> Codex: its Claude file and its Codex file, interleaved in time. */
const twoFiles = {
    '/c1.jsonl': [
        native('c-u1', 'user', '2026-11-03T01:00:00Z', 'claude q1'),
        native('c-a1', 'assistant', '2026-11-03T01:00:05Z', 'claude a1'),
        native('c-u3', 'user', '2026-11-03T05:00:00Z', 'claude q3'),
    ],
    '/t2.jsonl': [
        native('codex-0', 'user', '2026-11-03T09:30:00+07:00', 'codex q2'),
        native('codex-1', 'assistant', '2026-11-03T09:30:09+07:00', 'codex a2'),
    ],
};
const twoFilePaths = [
    {
        source: 'claude',
        path: '/c1.jsonl',
        nativeId: 'claude:C1',
        messageCount: 3,
    },
    {
        source: 'codex',
        path: '/t2.jsonl',
        nativeId: 'codex:T2',
        messageCount: 2,
    },
];
const twoFileRows = () => [
    row('codex:T2', 'codex', '/t2.jsonl', {
        updated_at: '2026-11-03T02:30:09Z',
        message_count: 2,
    }),
    row('claude:C1', 'claude', '/c1.jsonl', {
        updated_at: '2026-11-03T05:00:00Z',
        message_count: 3,
    }),
];
const twoFileChat = (sessionExtra = {}, rows = twoFileRows()) =>
    historyWith({
        mixed: {
            chat: {
                agent: 'codex',
                source: 'codex',
                firstAgent: 'claude',
                agentSession: 'C1',
                agentIds: { codex: { id: 'T2' } },
                providerAliases: ['claude:C1', 'codex:T2'],
                paths: twoFilePaths,
            },
        },
        rows,
        files: twoFiles,
        sessions: [
            chatSession({
                source: 'codex',
                path: '/t2.jsonl',
                updatedAt: '2026-11-03T02:30:09Z',
                messageCount: 2,
                ...sessionExtra,
            }),
        ],
    });

test('N4.3: a chat with two native files shows the turns of both, in time order, none twice', async () => {
    const { api, workspace } = await twoFileChat();
    await api.openTranscript(workspace.sessions[0]);
    assert.deepEqual(textsOf(api.chat.messages), [
        'claude q1',
        'claude a1',
        'codex q2',
        'codex a2',
        'claude q3',
    ]);
});

test('N4.3: a kept turn that is also in a file is shown once; one that is in no file is still shown', async () => {
    const copy = {
        id: 'turn-9',
        role: 'assistant',
        time: '',
        at: '2026-11-03T02:30:20Z',
        blocks: [{ kind: 'response', text: 'codex a2' }],
    };
    const late = {
        id: 'turn-10',
        role: 'assistant',
        time: '',
        at: '2026-11-03T06:00:00Z',
        blocks: [{ kind: 'response', text: 'late reply' }],
    };
    const { api, workspace } = await twoFileChat();
    api.otherTurns.chat = [copy, late];
    await api.openTranscript(workspace.sessions[0]);
    assert.deepEqual(textsOf(api.chat.messages), [
        'claude q1',
        'claude a1',
        'codex q2',
        'codex a2',
        'claude q3',
        'late reply',
    ]);
});

test('N4.3: the files are read again only when one of them changed in the index', async () => {
    const rows = twoFileRows();
    const { api, workspace, reads } = await twoFileChat({}, rows);
    await api.openTranscript(workspace.sessions[0]);
    assert.equal(reads.length, 2, 'both files are read once');
    await api.openTranscript(workspace.sessions[0]);
    assert.equal(reads.length, 2, 'the second open is served from the cache');
    // The Claude file grows; the next index refresh says so, and the chat is read again.
    rows[1].message_count = 4;
    await api.importHistory({ refresh: true });
    await api.openTranscript(workspace.sessions[0]);
    assert.equal(reads.length, 4, 'both files are read again');
});
