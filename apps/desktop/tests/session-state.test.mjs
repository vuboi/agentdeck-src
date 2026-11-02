import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';
import { worktreeSlug } from '../src/lib/tasks/worktree.ts';

/** A /btw side question's chat: a session of its own, opened from `chat`, never listed or saved. */
const sideChat = (id) => ({
    id,
    title: 'side',
    agent: 'claude',
    model: 'model',
    projectId: 'project',
    draft: false,
    side: { parentId: 'chat', question: 'why?' },
});

/** The state module reads prefs and the model catalog when it loads; these stubs only let it load. */
const prefs = { getPref: async () => null, setPref() {} };

test('worktreeSlug: accents, d with a stroke and punctuation become one dashed ASCII word', async () => {
    assert.equal(worktreeSlug('Fix export PDF'), 'fix-export-pdf');
    assert.equal(worktreeSlug('Sửa lỗi xuất PDF'), 'sua-loi-xuat-pdf');
    assert.equal(worktreeSlug('Đổi tên đề mục'), 'doi-ten-de-muc');
    assert.equal(worktreeSlug('  (fix) bug!!  '), 'fix-bug');
});

test('worktreeSlug: at most 20 characters, and no dash at either end', async () => {
    // The 20th character is a dash: it is cut, so the slug does not end with one.
    assert.equal(worktreeSlug('aaaaaaaaaaaaaaaaaaa bbbb'), 'a'.repeat(19));
    const long = worktreeSlug(
        'Tối ưu hiệu năng toàn bộ trang tổng quan của dự án',
    );
    assert.ok(long.length <= 20, long);
    assert.match(long, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('worktreeSlug: text with no letters or digits falls back to "task"', async () => {
    assert.equal(worktreeSlug('!!! ---'), 'task');
    assert.equal(worktreeSlug(''), 'task');
});

test('sessionCwd: a chat in a worktree works in the worktree; otherwise in its project, then its own folder', async () => {
    const api = await load('state', {
        ...prefs,
        BUILT_IN_AGENTS: [],
        modelCatalog: () => [],
        inTauri: () => false,
    });
    api.workspace.projects = [{ id: 'project', name: 'Repo', path: 'E:/repo' }];
    const worktree = 'E:/repo/.agentdeck/worktrees/w';
    assert.equal(
        api.sessionCwd({
            id: 'w',
            projectId: 'project',
            worktree: { path: worktree },
        }),
        worktree,
    );
    assert.equal(api.sessionCwd({ id: 'p', projectId: 'project' }), 'E:/repo');
    assert.equal(
        api.sessionCwd({
            id: 'o',
            projectId: 'missing',
            workingDirectory: 'E:/elsewhere',
        }),
        'E:/elsewhere',
    );
    assert.equal(api.sessionCwd({ id: 'n', projectId: 'missing' }), null);
});

test('a side chat is not a local chat, so it is neither listed nor saved with them', async () => {
    const api = await load('state', {
        ...prefs,
        BUILT_IN_AGENTS: [],
        modelCatalog: () => [],
        inTauri: () => false,
    });
    const chat = {
        id: 'chat',
        title: 'Main',
        agent: 'claude',
        model: 'model',
        projectId: 'project',
        draft: false,
    };
    api.workspace.sessions = [chat, sideChat('side')];
    api.localMessages.chat = [{ id: 'm1', role: 'user', blocks: [] }];
    api.localMessages.side = [{ id: 'm2', role: 'user', blocks: [] }];
    assert.deepEqual(
        api.localSessions().map((item) => item.id),
        ['chat'],
    );
});

test('a side chat is not in the sidebar tree', async () => {
    const chat = {
        id: 'chat',
        title: 'Main',
        agent: 'claude',
        model: 'model',
        projectId: 'project',
        draft: false,
        made: true,
        updatedAt: '2026-11-01T10:00:00Z',
    };
    // The side chat is the newest session: it would sort first if it were listed.
    const side = {
        ...sideChat('side'),
        made: true,
        updatedAt: '2026-11-02T10:00:00Z',
    };
    const workspace = {
        activeId: 'chat',
        sessions: [chat, side],
        projects: [{ id: 'project', name: 'Repo', path: 'E:/repo' }],
    };
    const api = await load('tree', {
        workspace,
        activeSession: () => chat,
        hiddenProjects: [],
        pinned: { sessions: [], projects: [] },
        placementOf: () => undefined,
        isPinnedSession: () => false,
        isEmptyDraft: () => false,
        NO_PROJECT: '',
    });
    const shown = [];
    const walk = (nodes) => {
        for (const node of nodes) {
            if (node.data?.session) shown.push(node.data.session.id);
            walk(node.children ?? []);
        }
    };
    walk(api.buildTree());
    assert.ok(shown.includes('chat'), shown.join(', '));
    assert.ok(!shown.includes('side'), shown.join(', '));
});
