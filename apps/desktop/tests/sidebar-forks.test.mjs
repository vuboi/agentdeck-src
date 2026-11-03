import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { historyWith, row } from './support/history-harness.mjs';

/** A chat of its own in the list; `parentId` makes it a fork or a delegated worker of that chat. */
const chat = (id, extra = {}) => ({
    id,
    title: id,
    agent: 'claude',
    model: 'model',
    projectId: 'project',
    draft: false,
    made: true,
    updatedAt: '2026-11-01T10:00:00Z',
    ...extra,
});

/** Every session id in the tree, with the nodes that hold them. */
const nodesOf = (nodes, out = []) => {
    for (const node of nodes) {
        out.push(node);
        nodesOf(node.children ?? [], out);
    }
    return out;
};

const treeWith = async (sessions, { pinnedSessions = [] } = {}) => {
    const workspace = {
        activeId: 'none',
        sessions,
        projects: [{ id: 'project', name: 'Repo', path: 'E:/repo' }],
    };
    const api = await load('tree', {
        workspace,
        activeSession: () => undefined,
        hiddenProjects: [],
        pinned: { sessions: pinnedSessions, projects: [] },
        placementOf: () => undefined,
        isPinnedSession: (id) => pinnedSessions.includes(id),
        isEmptyDraft: () => false,
        NO_PROJECT: '',
    });
    return api.buildTree();
};

test('a delegated worker keeps its parent after a history import', async () => {
    // The worker is a chat of this app, and its transcript is in the history. The import must not drop its parent:
    // the parent map is only filled by a later save, so a fresh import saw no parent and listed the worker as a new chat.
    const { api, workspace } = await historyWith({
        rows: [row('chat', 'claude', '/p/chat'), row('w1', 'claude', '/p/w1')],
        sessions: [
            chat('chat'),
            chat('w1', { parentId: 'chat', updatedAt: '2026-11-02T10:00:00Z' }),
        ],
        files: { '/p/chat': [], '/p/w1': [] },
    });
    await api.importHistory({ refresh: true });
    const worker = workspace.sessions.find((item) => item.id === 'w1');
    assert.equal(worker?.parentId, 'chat');
});

test('a pinned chat still shows its forks under it', async () => {
    const tree = await treeWith(
        [chat('root'), chat('fork', { parentId: 'root' })],
        { pinnedSessions: ['root'] },
    );
    const ids = nodesOf(tree).map((node) => node.data?.session?.id);
    assert.ok(ids.includes('fork'), ids.join(', '));
});

test('a fork shows under its chat in the project list', async () => {
    const tree = await treeWith([
        chat('root'),
        chat('fork', { parentId: 'root' }),
    ]);
    const root = nodesOf(tree).find(
        (node) => node.data?.session?.id === 'root' && !node.data.flat,
    );
    assert.ok(root, 'root row');
    // Compared as JSON: the tree is built in the test's own realm, so its arrays fail a deepEqual prototype check.
    assert.equal(
        JSON.stringify(
            (root.children ?? []).map((node) => node.data?.session?.id),
        ),
        '["fork"]',
    );
});

test('a chat with many workers folds them behind Show more', async () => {
    const workers = Array.from({ length: 8 }, (_, index) =>
        chat(`w${index}`, {
            parentId: 'root',
            updatedAt: `2026-11-0${index + 1}T10:00:00Z`,
        }),
    );
    const tree = await treeWith([chat('root'), ...workers]);
    const root = nodesOf(tree).find(
        (node) => node.data?.session?.id === 'root' && !node.data.flat,
    );
    const more = (root.children ?? []).find(
        (node) => node.data?.kind === 'more',
    );
    assert.ok(more, 'a Show more row under the chat');
    assert.equal(
        (root.children ?? []).filter((node) => node.data?.session).length,
        5,
    );
});

test('a chat outside any project shows its forks under it in This computer', async () => {
    const tree = await treeWith([
        chat('root', { projectId: '' }),
        chat('fork', { parentId: 'root', projectId: '' }),
    ]);
    const root = nodesOf(tree).find((node) => node.id === 'computer:root');
    assert.ok(root, 'root row in This computer');
    assert.equal(
        JSON.stringify(
            (root.children ?? []).map((node) => node.data?.session?.id),
        ),
        '["fork"]',
    );
});
