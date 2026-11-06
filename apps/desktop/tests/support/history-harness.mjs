import { load } from './load-session.mjs';
import { mergeTranscripts } from '../../src/lib/chat/session/transcript-merge.ts';
import { responseText } from '../../src/lib/chat/session/held.ts';

/** Lets the promise chains of the module under test (prefs read at load time, saves) run before an assertion. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Same identity as `signature` in sending.svelte.ts: the role and the response text. */
export const signatureOf = (message) =>
    `${message.role}|${message.blocks
        .map((block) => (block.kind === 'response' ? block.text.trim() : ''))
        .join('')
        .slice(0, 300)}`;

/** One row of `listHistory` (a provider file). */
export const row = (id, source, path, extra = {}) => ({
    id,
    source,
    title: 'Chat',
    model: null,
    cwd: '/work/app',
    is_project: true,
    started_at: null,
    updated_at: '2026-11-03T00:00:00Z',
    message_count: 0,
    path,
    parent_id: null,
    fork_seq: null,
    ...extra,
});

/** A provider message as `loadHistory` returns it: one response block. */
export const native = (id, role, time, text) => ({
    id,
    role,
    time,
    blocks: [{ kind: 'response', text }],
});

const clone = (value) => structuredClone(value);

/**
 * `history.svelte.ts` on fake native files. `files[path]` is the message list of that file, `rows` the history index,
 * `prefs` the saved values (read at load time and written by the module). Every write lands in `prefs`.
 */
export async function historyWith({
    mixed,
    rows = [],
    files = {},
    sessions = [],
    otherTurns,
    activeId = 'chat',
    prefs = {},
    ledger,
    ledgerOn = Boolean(ledger),
    messages = [],
    archived = [],
} = {}) {
    if (mixed) prefs['chat.mixed'] = mixed;
    if (otherTurns) prefs['chat.otherTurns'] = otherTurns;
    const workspace = { activeId, sessions, projects: [] };
    const reads = [];
    const stub = {
        messages: [],
        fakeData: false,
        inTauri: () => true,
        listHistory: async () => clone(rows),
        loadHistory: async (_source, path) => {
            reads.push(path);
            return clone(files[path] ?? []);
        },
        loadHistoryPage: async (_source, path, before, limit) => {
            const all = files[path] ?? [];
            const end = before ?? all.length;
            const start = Math.max(0, end - limit);
            return {
                total: all.length,
                start,
                messages: clone(all.slice(start, end)),
            };
        },
        renameHistory: async () => {},
        deleteHistory: async () => {},
        clock: () => '',
        toBlocks: (blocks) =>
            blocks.map((block) => ({ kind: 'response', text: block.text })),
        getPref: async (key) => (key in prefs ? clone(prefs[key]) : undefined),
        setPref: async (key, value) => {
            prefs[key] = clone(value);
        },
        setPrefs: async (entries) => {
            for (const [key, value] of entries)
                prefs[key] = value === null ? undefined : clone(value);
        },
        restoreCommandImages: async (_id, list) => list,
        stripCommandImageData: (list) => list,
        deleteCommandImages() {},
        archivedMessages: async () => clone(archived),
        deleteArchivedMessages: async () => {},
        splitAttachments: () => ({ text: '', images: [], files: [] }),
        attachmentBlocks: () => [],
        isHandbackPrompt: () => false,
        stripLead: (text) => text,
        joinContinuations: (list) => list,
        samePath: (a, b) => a === b,
        repoOfWorktreeFolder: (folder) => folder,
        CREDIT_PREFIX: 'credit:',
        baseModel: (model) => model,
        NO_PROJECT: 'none',
        MODELS: {
            claude: [{ value: 'claude-sonnet-5-5' }],
            codex: [{ value: 'gpt-5' }],
        },
        addedProjects: [],
        addedReady: Promise.resolve(),
        restored: Promise.resolve(),
        sessionPlacementsReady: Promise.resolve(),
        btwIgnoredReady: Promise.resolve(),
        draftElements: {},
        draftFiles: {},
        draftImages: {},
        draftMentions: {},
        drafts: {},
        localMessages: {},
        mockIds: new Set(),
        isEmptyDraft: () => false,
        localSessions: () => [],
        newSession() {},
        noProjectRow: () => ({ id: 'none', name: 'No project', path: '' }),
        parents: {},
        placementOf: () => undefined,
        rememberParents() {},
        forgetSessionPlacement() {},
        // The chat ledger (dual write): off unless a test passes a recorder for it.
        ledgerOn: () => ledgerOn,
        ledger: ledger ?? {
            recordTurn() {},
            bindNative() {},
            remove() {},
            shadowRead() {},
        },
        chatMetaOf: (session, cwd) => ({ id: session.id, cwd }),
        workspace,
        liveAsks: {},
        liveReplies: {},
        messagesOf: () => messages,
        replies: {},
        sessionLanes: {},
        withLive: (_id, list) => list,
        hidden: {},
        signature: signatureOf,
        dropSide() {},
        isBtwTranscript: () => false,
        lastPrompt: {},
        queuePaused: {},
        queued: {},
        stopTurn() {},
        turns: {},
        lastEventAt: new Map(),
        lastEventKind: new Map(),
        recoveries: {},
        resumes: {},
        backlog: new Map(),
        mergeTranscripts,
        responseText,
    };
    const globals = {
        $state: Object.assign((value) => value, {
            snapshot: (value) => clone(value),
        }),
        window: {},
        requestAnimationFrame: (callback) => callback(),
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    };
    const api = await load('history', stub, globals);
    await tick();
    return { api, workspace, prefs, reads };
}
