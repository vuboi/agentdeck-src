import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './support/load-session.mjs';

/** The real state module, with its collaborators stubbed. `dropped` records every side chat the move closes. */
async function stateWithSides() {
    const dropped = [];
    const api = await load('state', {
        BUILT_IN_AGENTS: [],
        agentDisplayName: () => '',
        modelCatalog: () => [],
        fakeData: false,
        inTauri: () => false,
        isPreviewCopy: () => false,
        getPref: async () => undefined,
        listPrefs: async () => ({}),
        setPref() {},
        setPrefs() {},
        listen: async () => () => {},
        dropSide: (parentId) => {
            dropped.push(parentId);
        },
    });
    return { api, dropped };
}

const draft = (id, projectId) => ({
    id,
    projectId,
    title: 'New session',
    agent: 'claude',
    model: 'model',
    status: 'idle',
    draft: true,
});

test("N2.5: moving a chat drops the empty draft it replaces, and closes that draft's /btw side chat", async () => {
    const { api, dropped } = await stateWithSides();
    api.workspace.sessions = [draft('a', 'p1'), draft('b', 'p2')];
    api.moveDraftToProject('b', 'p1');
    assert.deepEqual(
        api.workspace.sessions.map((item) => item.id),
        ['b'],
        'the empty draft of the project is dropped',
    );
    assert.deepEqual(dropped, ['a'], 'its side chat is closed with it');
});

test('N2.5: a draft that holds text is kept, and its side chat is left alone', async () => {
    const { api, dropped } = await stateWithSides();
    api.workspace.sessions = [draft('a', 'p1'), draft('b', 'p2')];
    api.drafts.a = 'half-written question';
    api.moveDraftToProject('b', 'p1');
    assert.deepEqual(api.workspace.sessions.map((item) => item.id).sort(), [
        'a',
        'b',
    ]);
    assert.deepEqual(dropped, []);
});
