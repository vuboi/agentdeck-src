import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { chatFiles } from './chat-files';
import { messages as mockMessages, type Message, type Block } from '../mock';
import {
    loadHistory,
    fakeData,
    inTauri,
    type HistorySession,
    type HistorySource,
    listHistory,
    type HistoryMessage,
    clock,
    toBlocks,
    loadHistoryPage,
    renameHistory,
    deleteHistory,
} from '../../app/platform/history';
import {
    restoreCommandImages,
    stripCommandImageData,
    deleteCommandImages,
} from '../content/command-images';
import { archivedMessages } from '../content/archive';
import { samePath } from '../../files/paths';
import { repoOfWorktreeFolder } from '../../tasks/worktree';
import { CREDIT_PREFIX, baseModel } from '../../agents/credit-model';
import { getPref, setPref, setPrefs } from '../../app/platform/prefs';

import { splitAttachments, attachmentBlocks } from '../content/attachments';
import { isHandbackPrompt, stripLead } from '../runs/handback';
import { joinContinuations } from '../runs/continuations';
import {
    MODELS,
    NO_PROJECT,
    addedProjects,
    addedReady,
    draftElements,
    draftFiles,
    draftImages,
    draftMentions,
    drafts,
    isEmptyDraft,
    localMessages,
    localSessions,
    mockIds,
    newSession,
    noProjectRow,
    parents,
    placementOf,
    rememberParents,
    restored,
    sessionPlacementsReady,
    forgetSessionPlacement,
    workspace,
    type Project,
    type SessionItem,
} from './state.svelte';
import {
    liveAsks,
    liveReplies,
    messagesOf,
    replies,
    sessionLanes,
    withLive,
} from './run.svelte';
import { hidden, signature } from './sending.svelte';
import {
    lastPrompt,
    queuePaused,
    queued,
    stopTurn,
    turns,
} from './turns.svelte';
import {
    lastEventAt,
    lastEventKind,
    recoveries,
    resumes,
} from './events.svelte';
import { backlog } from './delegate-task.svelte';
import { mergeTranscripts } from './transcript-merge';
import {
    chatMetaOf,
    ledger,
    ledgerOn,
    ledgerReadOn,
    readLedgerChat,
} from '../index/ledger';
import { responseText, tailStart } from './held';

// ---------- real history (Claude Code and Codex, read-only) ----------
export const chat = $state({
    messages: mockMessages as Message[],
    loading: false,
    error: '',
    older: 0,
    loadingOlder: false,
});

/**
 * Every chat's message list, by chat id. A turn writes to the list of its own chat, whichever chat is open: the open
 * chat shows `chat.messages`, which is its entry here (see `setMessages`), so a turn in another chat cannot land in it.
 */
export const messagesById = new SvelteMap<string, Message[]>();

/**
 * The file index of the first message held for a chat: how many older messages the file has before it. Set only while
 * the held list is the chat's file (its older pages included); a list without it is read from the file when opened.
 */
const olderById = new SvelteMap<string, number>();
/** Chats by how recently their list was set, oldest first. Past `HELD_CHATS`, the oldest lists are released. */
const heldOrder = new SvelteMap<string, true>();
const HELD_CHATS = 8;

/** Sets a chat's list. The open chat shows the new list at once; any other chat keeps it for when it is opened. */
export function setMessages(id: string, list: Message[]) {
    if (workspace.activeId === id) {
        chat.messages = list;
        messagesById.set(id, chat.messages);
    } else messagesById.set(id, list);
    heldOrder.delete(id);
    heldOrder.set(id, true);
    releaseHeld();
}

/**
 * Drops the lists of the chats shown longest ago, past `HELD_CHATS`. A dropped chat is read from its file when it is
 * opened next. Kept: the open chat, a chat running a turn, and a chat without a file (its list is the only copy).
 */
function releaseHeld() {
    for (const id of heldOrder.keys()) {
        if (heldOrder.size <= HELD_CHATS) return;
        const session = workspace.sessions.find((item) => item.id === id);
        if (
            id === workspace.activeId ||
            !session?.path ||
            sessionLanes[id]?.length ||
            liveReplies[id]
        )
            continue;
        heldOrder.delete(id);
        messagesById.delete(id);
        olderById.delete(id);
    }
}

/** Reads a chat that is not open, so a turn in it is told the conversation it has. Nothing shown changes. */
export async function loadBackground(session: SessionItem) {
    const id = session.id;
    let list: Message[] = [];
    try {
        const fresh = await fetchTranscript(session);
        list = withLive(id, mergeWorkMessages(fresh.messages, []));
    } catch {
        // The chat keeps what it has: an empty list, which the turn then sends without history.
    }
    // A chat that got a list while it was read (its own turn, opened meanwhile) keeps that list.
    if (!messagesById.has(id)) messagesById.set(id, list);
}

/** Returns a complete, display-ready conversation without changing which chat is open. */
export async function conversationForExport(
    sessionId: string,
): Promise<{ title: string; messages: Message[]; sourcePath?: string }> {
    const session = workspace.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('This conversation no longer exists.');
    if (session.source && session.path) {
        const files = wholeFilesOf(session);
        let all: Message[];
        if (files) all = await readWhole(session, files);
        else {
            const raw = await loadHistory(session.source, session.path);
            const own = await restoreArchivedWork(
                session,
                await toMessages(session, raw),
            );
            all = assemble(session, own, own[0]?.at);
        }
        return {
            title: session.title,
            messages: await restoreCommandImages(session.id, all),
            sourcePath: session.path,
        };
    }
    const messages = messagesOf(sessionId);
    return {
        title: session.title,
        messages: JSON.parse(JSON.stringify(messages)) as Message[],
    };
}

export const history = $state({
    imported: fakeData,
    loading: inTauri() && !fakeData,
    /** The start-up import is running: Recents shows its loader, and the cached list waits for it. */
    scanning: inTauri() && !fakeData,
});

// Older indexes treated every cwd as a project; never paint those classifications during startup.
/** The chat history index, kept in IndexedDB (prefs.ts `index.` collection). */
const HISTORY_INDEX = 'index.history';

/** Last folder of a path, for either separator: `C:\work\demo` and `/home/me/demo` both give `demo`. */
export const folderName = (cwd: string) =>
    cwd
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? 'Unknown';

/** Provider state kept beside history files: those files do not know AgentDeck's mixed-chat or edited-session mapping. */
type SavedProviderState = Pick<
    SessionItem,
    | 'agent'
    | 'agents'
    | 'agentSession'
    | 'agentStarted'
    | 'agentEpoch'
    | 'agentModels'
    | 'agentIds'
    | 'conversationModel'
    | 'source'
    | 'firstAgent'
> & {
    /** Every provider transcript that has belonged to this AgentDeck chat, including threads replaced by a model edit. */
    providerAliases?: string[];
    /** The native files of this chat, when it has more than one: each is read and merged by time (see `readTranscript`). */
    paths?: NativeFile[];
};
/** One provider history file of a chat. `updatedAt` and `messageCount` are its index row, which decides the cache. */
export type NativeFile = {
    source: HistorySource;
    path: string;
    nativeId: string;
    updatedAt?: string;
    messageCount?: number;
};
const mixed: Record<string, SavedProviderState> = {};
let mixedHydrated = false;
const pendingMixed = new SvelteMap<string, SavedProviderState>();
const mixedReady = getPref<typeof mixed>('chat.mixed')
    .then((saved) => {
        if (saved) Object.assign(mixed, saved);
        for (const [id, state] of pendingMixed) mixed[id] = state;
        pendingMixed.clear();
        mixedHydrated = true;
    })
    .catch(() => {
        mixedHydrated = true;
    });

/** Whether `a` names the same provider files as `b` (the index values of a file are not compared). */
function sameFiles(a: NativeFile[] | undefined, b: NativeFile[]): boolean {
    return (
        !!a &&
        a.length === b.length &&
        b.every((file) =>
            a.some(
                (other) =>
                    other.source === file.source && other.path === file.path,
            ),
        )
    );
}

/** Replaces the mock workspace with what Claude Code and Codex already saved on this machine. */
export async function importHistory({ refresh = false } = {}) {
    if (fakeData) {
        history.imported = true;
        history.loading = false;
        return;
    }
    if (!inTauri()) {
        history.loading = false;
        return;
    }
    await Promise.all([
        restored,
        addedReady,
        sessionPlacementsReady,
        mixedReady,
    ]);
    // Show the last known index at once, then refresh it: indexing every file takes a moment.
    if (!refresh) history.scanning = true;
    if (!refresh)
        try {
            const cached =
                (await getPref<HistorySession[]>(HISTORY_INDEX)) ?? [];
            if (cached.length > 0) {
                // A stale cache must not replace the restored active id with its first row. That used to make the
                // subsequent full import preserve the wrong session even when it found the session the user had open.
                const activeId = workspace.activeId;
                const hasActive = cached.some((item) => item.id === activeId);
                const hasLocalActive = localSessions().some(
                    (item) => item.id === activeId,
                );
                if (!activeId || hasActive || hasLocalActive) {
                    applyHistory(cached);
                    history.imported = true;
                    // The cached list is on screen: the loader is only for a start with no list to show.
                    history.scanning = false;
                }
            }
        } catch {
            // A bad cache is simply ignored.
        }
    history.loading = true;
    try {
        const found = await listHistory();
        const keep = workspace.activeId;
        const keepSession = workspace.sessions.find((item) => item.id === keep);
        const keepIsLocal = localSessions().some((item) => item.id === keep);
        if (found.length === 0 && (!keep || keepIsLocal)) return;
        applyHistory(found);
        // `applyHistory` folds a new provider thread (for example Codex after continuing a Claude chat) back into the
        // AgentDeck session id. Check the merged list, not the raw provider ids, or that valid alias looks missing and
        // the refresh opens a brand-new draft instead of keeping the continued chat active.
        if (workspace.sessions.some((item) => item.id === keep))
            workspace.activeId = keep;
        else if (keep && keepSession) {
            // The provider can lag briefly after the first turn writes its transcript. Keep the AgentDeck-created chat
            // visible during this refresh; creating a new draft here clears the active tab and makes the UI jump away.
            if (!workspace.sessions.some((item) => item.id === keep))
                workspace.sessions = [keepSession, ...workspace.sessions];
            workspace.activeId = keep;
        } else if (keep && !keepIsLocal) newSession(NO_PROJECT);
        history.imported = true;
        // Quietly warm the transcripts of the newest chats while the app is idle.
        const warm = () =>
            workspace.sessions
                .filter((item) => item.path)
                .sort((a, b) =>
                    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
                )
                .slice(0, 4)
                .forEach((item) => void prefetchTranscript(item));
        if ('requestIdleCallback' in window)
            window.requestIdleCallback(warm, { timeout: 3000 });
        else setTimeout(warm, 800);
        try {
            // The index lives in IndexedDB (no size limit like localStorage): the next start shows it at once.
            void setPref(HISTORY_INDEX, JSON.parse(JSON.stringify(found)));
        } catch {
            // Only an optimisation.
        }
    } catch (error) {
        chat.error = String(error);
    } finally {
        history.loading = false;
        if (!refresh) history.scanning = false;
    }
}

/** The parent remembered for a sub chat, when that parent still exists (in the history, or as a chat of this app). The chat's
 * own parent counts too: a worker made just now is not in `parents` until the next save, and a read in between must keep it. */
function knownParent(id: string, ids: Set<string>): string | undefined {
    const parent =
        parents[id] ??
        workspace.sessions.find((item) => item.id === id)?.parentId;
    if (!parent || parent === id) return undefined;
    return ids.has(parent) ||
        workspace.sessions.some((item) => item.id === parent)
        ? parent
        : undefined;
}

function applyHistory(all: HistorySession[]) {
    indexedIds = new Set(all.map((item) => item.id));
    // The sub chats that exist now keep their parent through this import.
    rememberParents();
    // One entry per id (first = newest): an older cache can still hold a duplicated Codex thread,
    // and a repeated id breaks the sidebar's keyed tree.
    // A chat whose agent conversation was started by AgentDeck (a fork, or a chat that continued with another agent)
    // has a session id of its own, while its history file is named by the agent's conversation id (`codex:<id>`,
    // `claude:<id>`). That file is the same chat: it is merged into the chat, not listed again on its own.
    const aliasOf = new SvelteMap<string, string>();
    for (const [ownerId, saved] of Object.entries(mixed)) {
        for (const providerId of saved.providerAliases ?? [])
            aliasOf.set(providerId, ownerId);
        const first =
            saved.firstAgent ??
            saved.source ??
            saved.agents?.[0] ??
            saved.agent;
        if (saved.agentSession && first)
            aliasOf.set(`${first}:${saved.agentSession}`, ownerId);
        for (const [agent, ids] of Object.entries(saved.agentIds ?? {}))
            if (ids?.id) aliasOf.set(`${agent}:${ids.id}`, ownerId);
    }
    for (const item of workspace.sessions) {
        if (item.agentSession)
            aliasOf.set(
                `${item.firstAgent ?? item.source ?? item.agent}:${item.agentSession}`,
                item.id,
            );
        for (const [agent, ids] of Object.entries(item.agentIds ?? {}))
            if (ids?.id) aliasOf.set(`${agent}:${ids.id}`, item.id);
    }
    // Every native file of a chat, in index order. A chat that went on with another agent has one file per provider:
    // the first (the newest) is the chat's file, and the rest are read and merged in when the chat is opened.
    const filesOf = new SvelteMap<string, NativeFile[]>();
    for (const item of all) {
        const id = aliasOf.get(item.id) ?? item.id;
        const files = filesOf.get(id) ?? [];
        if (
            !files.some(
                (file) =>
                    file.source === item.source && file.path === item.path,
            )
        )
            files.push({
                source: item.source,
                path: item.path,
                nativeId: item.id,
                updatedAt: item.updated_at ?? undefined,
                messageCount: item.message_count,
            });
        filesOf.set(id, files);
    }
    let filesChanged = false;
    for (const [id, indexed] of filesOf) {
        const saved = mixed[id];
        // A file the index has not scanned yet (see chat-files.ts) stays in the chat's list.
        const files = chatFiles(
            indexed,
            saved?.paths,
            saved ? providerAliasesOf(saved) : [],
        );
        if (files.length > 1) {
            if (!sameFiles(saved?.paths, files)) filesChanged = true;
            mixed[id] ??= {} as SavedProviderState;
            mixed[id].paths = files;
        } else if (saved?.paths) {
            delete saved.paths;
            filesChanged = true;
        }
    }
    if (filesChanged) void mixedReady.then(() => setPref('chat.mixed', mixed));
    const seen = new SvelteSet<string>();
    const found = all
        .map((item) => {
            const id = aliasOf.get(item.id);
            if (!id || id === item.id) return item;
            return {
                ...item,
                id,
                title:
                    workspace.sessions.find((session) => session.id === id)
                        ?.title ?? item.title,
            };
        })
        .filter((item) => !seen.has(item.id) && seen.add(item.id));
    const ids = new Set(found.map((item) => item.id));
    const current = new Map(workspace.sessions.map((item) => [item.id, item]));
    const projectIds = new SvelteMap<string, string>();
    const projects: Project[] = [];
    const keepProject = (candidate: Project) => {
        const existing = candidate.path
            ? projects.find(
                  (project) =>
                      project.path && samePath(project.path, candidate.path!),
              )
            : projects.find((project) => project.id === candidate.id);
        if (existing) return existing;
        projects.push(candidate);
        return candidate;
    };
    for (const item of found) {
        // A chat created in AgentDeck can already have a matching Claude/Codex history file after its first turn. Keep
        // the project chosen in the app even when the history index has not recognised that folder as a project yet.
        const existing = current.get(item.id);
        const explicitProjectId = placementOf(item.id)?.projectId;
        const existingProject =
            explicitProjectId && explicitProjectId !== NO_PROJECT
                ? workspace.projects.find(
                      (project) => project.id === explicitProjectId,
                  )
                : existing &&
                    !existing.path &&
                    existing.projectId !== NO_PROJECT
                  ? workspace.projects.find(
                        (project) => project.id === existing.projectId,
                    )
                  : undefined;
        // A worker run in its own worktree writes its transcript under that folder: the chat belongs to the repository.
        const folder = repoOfWorktreeFolder(item.cwd);
        if (existingProject) {
            const project = keepProject(existingProject);
            projectIds.set(folder, project.id);
            continue;
        }
        if (
            !item.is_project &&
            !addedProjects.some((path) => samePath(path, folder))
        )
            continue;
        if (!projectIds.has(folder)) {
            const project = keepProject({
                id: `dir:${folder}`,
                name: folder ? folderName(folder) : 'Unknown',
                path: folder,
            });
            projectIds.set(folder, project.id);
        }
    }
    const sessions: SessionItem[] = found.map((item) => ({
        // The history file is the provider's storage, but its sidebar placement belongs to AgentDeck. A local session
        // may therefore become history-backed without changing from its selected project or from This computer.
        ...(placementOf(item.id)?.origin === 'agentdeck' ||
        current.get(item.id)?.made
            ? { made: true }
            : {}),
        // A saved chat continued with another agent: which agents it has had, and their own conversation ids.
        ...(mixed[item.id] ?? {}),
        id: item.id,
        // A chat already listed keeps the project it was placed in: its cwd is only the place for a chat seen first here.
        projectId:
            placementOf(item.id)?.projectId ??
            (current.get(item.id)?.made
                ? current.get(item.id)?.projectId
                : undefined) ??
            projectIds.get(repoOfWorktreeFolder(item.cwd)) ??
            NO_PROJECT,
        workingDirectory: item.cwd || undefined,
        // The worktree of a worker is not in any transcript: keep the one AgentDeck made, or the chat loses its Merge.
        ...(current.get(item.id)?.worktree
            ? { worktree: current.get(item.id)?.worktree }
            : {}),
        title: item.title,
        agent:
            mixed[item.id]?.agent ??
            mixed[item.id]?.agents?.at(-1) ??
            item.source,
        // A chat already listed keeps the model the user picked (Claude transcripts record none, so a re-import used to reset it).
        // Sonnet otherwise, unless the chat was changed: the first model of the list is the biggest one.
        model:
            current.get(item.id)?.model ??
            item.model ??
            (item.source === 'claude'
                ? 'claude-sonnet-5-5'
                : MODELS[item.source][0].value),
        // A local model/account transition may already have replaced this provider conversation while its new history
        // file is still being written. Keep that lifecycle state instead of reviving the old transcript's model.
        conversationModel:
            current.get(item.id)?.conversationModel ??
            mixed[item.id]?.conversationModel ??
            item.model ??
            undefined,
        status: 'idle',
        parentId:
            item.parent_id && ids.has(item.parent_id)
                ? item.parent_id
                : knownParent(item.id, ids),
        firstAgent:
            mixed[item.id]?.firstAgent ?? current.get(item.id)?.firstAgent,
        source: item.source,
        path: item.path,
        updatedAt: item.updated_at ?? undefined,
        messageCount: item.message_count,
    }));
    // Most recently used project first.
    const latest = (projectId: string) =>
        sessions
            .filter((item) => item.projectId === projectId)
            .reduce(
                (max, item) =>
                    (item.updatedAt ?? '') > max ? (item.updatedAt ?? '') : max,
                '',
            );
    projects.sort((a, b) => latest(b.id).localeCompare(latest(a.id)));

    // Sessions that only exist here (drafts, new chats) survive the import.
    const local = localSessions().filter((item) => !ids.has(item.id));
    // The open empty draft keeps its project too, so its row stays highlighted.
    const draft = workspace.sessions.find(
        (item) => item.id === workspace.activeId && isEmptyDraft(item),
    );
    if (draft) local.push(draft);
    // The open chat stays open while it exists: after F5 it is an imported session, after a send it may still be a
    // local one, and a row missing from one refresh (a file being written) must not move the chat or close its tab.
    // Only a delete changes the open chat (see `deleteSession`).
    const keepActive =
        ids.has(workspace.activeId) ||
        local.some((item) => item.id === workspace.activeId) ||
        workspace.sessions.some((item) => item.id === workspace.activeId)
            ? workspace.activeId
            : undefined;
    // Folders added by hand stay even with no chat in them yet, right after "This computer".
    const added = addedProjects
        .filter(
            (path) => !projects.some((project) => samePath(project.path, path)),
        )
        .map((path) => ({ id: `dir:${path}`, name: folderName(path), path }));
    projects.unshift(noProjectRow(), ...added);
    sessions.sort((a, b) =>
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );

    // A chat already listed keeps its object, updated in place: a turn running in it (in this chat, or on another
    // chat's import) still holds that object and its "working" state. A new object with `status: 'idle'` dropped both,
    // so the chat looked done while its agent was still answering.
    const merged = sessions.map((item) => {
        const existing = current.get(item.id);
        if (!existing) return item;
        return Object.assign(existing, item, { status: existing.status });
    });

    // A local chat keeps its project while the project still exists, even when no imported chat is in its folder yet (a chat
    // that has not written its history file, or a project that holds only local chats). Otherwise it fell to This computer.
    for (const item of local) {
        if (
            item.projectId === NO_PROJECT ||
            projects.some((project) => project.id === item.projectId)
        )
            continue;
        const kept = workspace.projects.find(
            (project) => project.id === item.projectId,
        );
        if (kept) item.projectId = keepProject(kept).id;
    }
    // Local chats saved under the old cwd-based projects survive reclassification too.
    for (const item of local) {
        if (projects.some((project) => project.id === item.projectId)) continue;
        item.workingDirectory ??= workspace.projects.find(
            (project) => project.id === item.projectId,
        )?.path;
        item.projectId = NO_PROJECT;
    }
    workspace.projects = projects;
    workspace.sessions = [
        ...merged,
        ...local.filter((item) =>
            projects.some((project) => project.id === item.projectId),
        ),
    ];
    workspace.activeId = keepActive ?? sessions[0]?.id ?? '';
}

let transcriptToken = 0;

// ---------- transcripts: memory + IndexedDB cache, so opening a chat is instant ----------
// A transcript is valid while the session's index entry (last update + message count) is unchanged.
// `start` is where the first loaded message sits in the chat's file: above 0, older messages are still on disk.
type Transcript = { stamp: string; messages: Message[]; start: number };
export const transcripts = new SvelteMap<string, Transcript>();
// The format version leads the stamp: v5 limits persisted transcript pages to 30 messages.
const stampOf = (session: SessionItem) => {
    // A chat with several files also changes when one of its other files changes in the index.
    const files = wholeFilesOf(session) ?? [];
    return `v5|${session.updatedAt ?? ''}|${session.messageCount ?? 0}${files.map((file) => `|${file.path}@${file.updatedAt ?? ''}#${file.messageCount ?? 0}`).join('')}`;
};

/** The native files of a chat with more than one: such a chat is read whole and merged (see `readWhole`). */
function wholeFilesOf(session: SessionItem): NativeFile[] | undefined {
    const files = mixed[session.id]?.paths;
    return files && files.length > 1 ? files : undefined;
}
const MAX_SAVED = 12;
/** Keep one page in the reload cache; older pages are fetched from the history cursor on demand. */
const PAGE_LIMIT = 20;
const SAVED_TAIL = PAGE_LIMIT;

function providerAliasesOf(state: SavedProviderState): string[] {
    const aliases = new SvelteSet(state.providerAliases ?? []);
    const first =
        state.firstAgent ?? state.source ?? state.agents?.[0] ?? state.agent;
    if (state.agentSession && first)
        aliases.add(`${first}:${state.agentSession}`);
    for (const [agent, ids] of Object.entries(state.agentIds ?? {}))
        if (ids?.id) aliases.add(`${agent}:${ids.id}`);
    return [...aliases];
}

/** Native ids the last history scan listed. */
let indexedIds = new Set<string>();
/** Native ids already asked for a scan in this run, so a thread the index never lists does not scan on every turn. */
const scannedFor = new SvelteSet<string>();
let scanSoon: ReturnType<typeof setTimeout> | undefined;
/**
 * A chat that already has its file took on another native session (a model or account change): the index has not
 * listed that file yet, so the chat's files would miss it until the next start. Scan once, shortly, so it joins the chat.
 */
function scanForNewAliases(state: SavedProviderState) {
    if (indexedIds.size === 0) return;
    const unseen = providerAliasesOf(state).filter(
        (alias) => !indexedIds.has(alias) && !scannedFor.has(alias),
    );
    if (unseen.length === 0) return;
    for (const alias of unseen) scannedFor.add(alias);
    clearTimeout(scanSoon);
    scanSoon = setTimeout(() => void importHistory({ refresh: true }), 1500);
}

/** Provider ids of a chat, including every thread replaced by a model/account change or edit. */
export function rememberMixed(session: SessionItem) {
    const current = $state.snapshot({
        agent: session.agent,
        agents: session.agents,
        agentSession: session.agentSession,
        agentStarted: session.agentStarted,
        agentEpoch: session.agentEpoch,
        agentModels: session.agentModels,
        agentIds: session.agentIds,
        conversationModel: session.conversationModel,
        source: session.source,
        firstAgent: session.firstAgent,
    });
    const saved: SavedProviderState = {
        ...current,
        providerAliases: providerAliasesOf({
            ...current,
            providerAliases: providerAliasesOf(mixed[session.id] ?? current),
        }),
        // The native files are read from the index, not from the session: saving the provider state keeps them.
        ...(mixed[session.id]?.paths ? { paths: mixed[session.id].paths } : {}),
    };
    mixed[session.id] = saved;
    if (!session.draft && session.path) scanForNewAliases(saved);
    if (!mixedHydrated) pendingMixed.set(session.id, saved);
    // Each native session of a chat that has run is bound in the ledger (once per session; a draft has none yet).
    if (ledgerOn() && !session.draft) {
        const cwd =
            workspace.projects.find(
                (project) => project.id === session.projectId,
            )?.path ?? null;
        for (const alias of providerAliasesOf(saved)) {
            const at = alias.indexOf(':');
            if (at > 0)
                ledger.bindNative(
                    chatMetaOf(session, cwd),
                    alias.slice(0, at),
                    alias.slice(at + 1),
                    session.agentEpoch,
                );
        }
    }
    void mixedReady.then(() => setPref('chat.mixed', mixed));
}

/**
 * Turns of another agent in a saved chat (a Claude chat continued with Codex, say). The chat's file only holds
 * its own agent's turns, so these are kept here and merged back in by time when the chat is read again.
 */
export const otherTurns: Record<string, Message[]> = {};
// Read from the chat ledger once at start-up (plan storage-sqlite P5.4). A turn's position in its list is its seq.
void (async () => {
    if (!inTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const rows = await invoke<[string, number, Message][]>(
        'chat_other_turns_all',
    );
    for (const [chatId, seq, turn] of rows)
        (otherTurns[chatId] ??= [])[seq] = turn;
})().catch(() => {});

/** Writes one of a chat's other-agent turns to the ledger, at its position in the list. */
function putOtherTurn(chatId: string, index: number) {
    const turn = otherTurns[chatId]?.[index];
    if (!turn) return;
    ledger.run(
        'chat_put_other_turn',
        {
            chatId,
            seq: index,
            blocks: stripCommandImageData([
                $state.snapshot(turn) as Message,
            ])[0],
        },
        chatId,
    );
}

/** Writes a chat's whole list of other-agent turns again, in order, after the list changed in the middle. */
export function replaceOtherTurns(chatId: string) {
    ledger.run('chat_clear_other_turns', { chatId }, chatId);
    (otherTurns[chatId] ?? []).forEach((_, index) =>
        putOtherTurn(chatId, index),
    );
}

export function keepOtherTurn(session: SessionItem, reply: Message) {
    const list = messagesOf(session.id);
    const index = list.indexOf(reply);
    const asked =
        index > 0 && list[index - 1].role === 'user' ? [list[index - 1]] : [];
    const kept = (otherTurns[session.id] ??= []);
    for (const message of [...asked, reply]) {
        if (!kept.some((item) => item.id === message.id)) {
            kept.push($state.snapshot(message) as Message);
            putOtherTurn(session.id, kept.length - 1);
        }
    }
}

/**
 * A permission card was answered on screen: the copies of its message that are read back when the chat is reopened
 * (the kept turns and the transcript cache) must say so too, or the card asks again after a switch to another chat.
 */
export function settleKeptPermission(
    sessionId: string,
    messageId: string,
    blockIndex: number,
    state: 'allowed' | 'denied' | 'expired',
) {
    const settle = (list: Message[] | undefined) => {
        const block = list?.find((message) => message.id === messageId)?.blocks[
            blockIndex
        ];
        if (block?.kind !== 'permission' || block.state === state) return false;
        block.state = state;
        return true;
    };
    settle(transcripts.get(sessionId)?.messages);
    const index =
        otherTurns[sessionId]?.findIndex(
            (message) => message.id === messageId,
        ) ?? -1;
    if (index >= 0 && settle(otherTurns[sessionId]))
        putOtherTurn(sessionId, index);
}

/**
 * The message that handed work out (a flow's steps, `@agent`) is never in the chat's file: the chat's agent only
 * speaks at the handback. Kept with the other turns, and saved again as its cards change, so the chat still shows
 * its Flow steps card once it is read back from the file.
 */
export function keepHandout(mainId: string, asked: Message) {
    const kept = (otherTurns[mainId] ??= []);
    const copy = $state.snapshot(asked) as Message;
    const index = kept.findIndex((item) => item.id === asked.id);
    if (index >= 0) kept[index] = copy;
    else kept.push(copy);
    putOtherTurn(mainId, index >= 0 ? index : kept.length - 1);
}

/** Pictures and files a saved prompt named by path (see `splitAttachments`), as blocks; the words lose those lists. */
async function userAttachments(message: HistoryMessage): Promise<Block[]> {
    const found: { images: string[]; files: string[] } = {
        images: [],
        files: [],
    };
    for (const block of message.blocks) {
        if (block.kind !== 'response' || !block.text.includes('Attached '))
            continue;
        const split = splitAttachments(block.text);
        block.text = split.text;
        found.images.push(...split.images);
        found.files.push(...split.files);
    }
    return found.images.length || found.files.length
        ? attachmentBlocks(found.images, found.files)
        : [];
}

/** A new session of the same conversation opens with a digest of what was said, then the typed text: only that text is shown. */
function stripDigest(text: string): string {
    const mark = '\n\n---\nNow the user says:\n';
    const at = text.indexOf(mark);
    return text.includes('What was said so far:') && at > 0
        ? text.slice(at + mark.length)
        : text;
}

async function toMessages(
    session: SessionItem,
    all: HistoryMessage[],
): Promise<Message[]> {
    // The prompt that handed other agents' answers back was never a message of the user's: only the reply to it is shown.
    const loaded = all.filter(
        (message) =>
            !(
                message.role === 'user' &&
                message.blocks.some(
                    (block) =>
                        block.kind === 'response' &&
                        isHandbackPrompt(block.text),
                )
            ),
    );
    const restored = await Promise.all(
        loaded.map((message) =>
            message.role === 'user'
                ? userAttachments(message)
                : Promise.resolve([] as Block[]),
        ),
    );
    return joinContinuations(
        loaded.map((message, at) => ({
            ...(message.role === 'assistant' ? { agent: session.source } : {}),
            id: message.id,
            role: message.role,
            time: clock(message.time),
            at: message.time || undefined,
            // A prompt sent with the turns this agent missed shows only what the user typed.
            blocks: [
                ...restored[at],
                ...toBlocks(message.blocks)
                    .map((block) => {
                        // The paragraph AgentDeck puts before a prompt (how to open pages, how to delegate) is not the user's text.
                        const typed =
                            message.role === 'user' && block.kind === 'response'
                                ? {
                                      ...block,
                                      text: stripDigest(stripLead(block.text)),
                                  }
                                : block;
                        return typed.kind === 'response' &&
                            message.role === 'user' &&
                            typed.text.startsWith(
                                'Earlier in this chat, other agents answered',
                            )
                            ? {
                                  ...typed,
                                  text: typed.text.slice(
                                      typed.text.indexOf(
                                          'Now the user says:\n',
                                      ) + 'Now the user says:\n'.length,
                                  ),
                              }
                            : typed;
                    })
                    .flatMap((block) =>
                        block.kind === 'response' && !block.text ? [] : [block],
                    ),
            ],
            // Tokens come from the transcript itself, so every reply shows them again when the chat is reopened.
            ...(message.usage
                ? {
                      tokens: {
                          input: message.usage.input,
                          output: message.usage.output,
                          cacheRead: message.usage.cache_read,
                          cacheWrite: message.usage.cache_write,
                      },
                      context:
                          message.usage.input +
                          message.usage.cache_read +
                          message.usage.cache_write,
                      // The transcript records the plain id: a chat run on the Console credit shows the `credit:` name it was picked by.
                      model:
                          session.model?.startsWith(CREDIT_PREFIX) &&
                          baseModel(session.model) === message.model
                              ? session.model
                              : message.model,
                  }
                : {}),
        })),
    );
}

const isWorkMessage = (message: Message) =>
    message.autoTurn ||
    message.blocks.some(
        (block) =>
            block.kind === 'delegate' ||
            (block.kind === 'command' &&
                Boolean(
                    block.taskId ||
                    block.task ||
                    block.children ||
                    block.background,
                )),
    );

// TEMP work-restore debug (remove after the check): logs what the archive overlay matched and dropped.
function mergeWorkMessages(
    messages: Message[],
    extras: Message[],
    debug?: string,
): Message[] {
    const restored = [...messages];
    const work = extras.filter(isWorkMessage);
    let matched = 0;
    let autoPushed = 0;
    const dropped: Record<string, unknown>[] = [];
    for (const extra of work) {
        const text = responseText(extra);
        const index = restored.findIndex(
            (message) =>
                message.id === extra.id ||
                (Boolean(text) &&
                    message.role === extra.role &&
                    responseText(message) === text &&
                    (!message.at ||
                        !extra.at ||
                        Math.abs(
                            Date.parse(message.at) - Date.parse(extra.at),
                        ) <
                            10 * 60_000)),
        );
        if (index >= 0) {
            restored[index] = { ...restored[index], ...extra };
            matched++;
        } else if (extra.autoTurn) {
            restored.push(extra);
            autoPushed++;
        } else {
            dropped.push({
                id: extra.id,
                at: extra.at,
                textLen: text.length,
                blocks: extra.blocks.map((block) =>
                    block.kind === 'command'
                        ? `cmd:${block.command.split(/\s+/, 1)[0]}`
                        : block.kind,
                ),
                candidates: restored
                    .filter((message) => message.role === extra.role)
                    .slice(-6)
                    .map((message) => ({
                        id: message.id,
                        at: message.at,
                        textLen: responseText(message).length,
                        sameText: responseText(message) === text,
                        minFromSnapshot:
                            message.at && extra.at
                                ? Math.round(
                                      (Date.parse(message.at) -
                                          Date.parse(extra.at)) /
                                          60_000,
                                  )
                                : null,
                    })),
            });
        }
    }
    if (debug && work.length)
        console.debug('[work-restore]', debug, {
            snapshots: extras.length,
            work: work.length,
            matched,
            autoPushed,
            dropped: dropped.length,
            droppedDetail: dropped,
        });
    return restored.sort(byInstant);
}

/**
 * Orders two messages by their instant, so `Z` and an offset (`+07:00`) compare as the times they are. A message
 * without a time sorts by its text, as it always did.
 */
function byInstant(a: Message, b: Message): number {
    const timeA = Date.parse(a.at ?? '');
    const timeB = Date.parse(b.at ?? '');
    if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB)
        return timeA - timeB;
    return (a.at ?? '').localeCompare(b.at ?? '');
}

/** Reattaches AgentDeck-only work report metadata that provider history cannot represent. */
async function restoreArchivedWork(
    session: SessionItem,
    messages: Message[],
): Promise<Message[]> {
    const records = await archivedMessages(session.id);
    // TEMP work-restore debug (remove after the check)
    console.debug('[work-restore] archive', session.id, {
        records: records.length,
        transcriptMessages: messages.length,
        transcriptAssistant: messages.filter(
            (message) => message.role === 'assistant',
        ).length,
    });
    const restored = mergeWorkMessages(
        messages,
        records.flatMap((record) => (record.snapshot ? [record.snapshot] : [])),
        session.id,
    );
    for (const record of records) {
        if (record.context == null) continue;
        const index = restored.findIndex(
            (message) =>
                message.role === 'assistant' &&
                (message.id === record.id ||
                    (responseText(message) === record.text &&
                        (!message.at ||
                            !record.at ||
                            Math.abs(
                                Date.parse(message.at) - Date.parse(record.at),
                            ) <
                                10 * 60_000))),
        );
        if (index >= 0)
            restored[index] = { ...restored[index], context: record.context };
    }
    return restored;
}

/** The file's messages minus the deleted ones, with the other agents' turns that fall in the time range `[lower, upper)`. */
function assemble(
    session: SessionItem,
    own: Message[],
    lower?: string,
    upper?: string,
): Message[] {
    const others = (otherTurns[session.id] ?? []).filter(
        (message) =>
            (!lower || (message.at ?? '') >= lower) &&
            (!upper || (message.at ?? '') < upper),
    );
    const gone = new Set(hidden[session.id] ?? []);
    const out = (message: Message) =>
        gone.has(message.id) || gone.has(signature(message));
    const shown = gone.size ? own.filter((message) => !out(message)) : own;
    if (!others.length) return shown;
    return [...shown, ...others.filter((message) => !out(message))].sort(
        (a, b) => (a.at ?? '').localeCompare(b.at ?? ''),
    );
}

/**
 * A chat with several native files: each file is read whole, and its turns are merged by time with the turns of the
 * other agents kept beside them. The chat has no older page then: every turn is in the list.
 */
async function readWhole(
    session: SessionItem,
    files: NativeFile[],
): Promise<Message[]> {
    const gone = new Set(hidden[session.id] ?? []);
    const out = (message: Message) =>
        gone.has(message.id) || gone.has(signature(message));
    const lists = await Promise.all(
        files.map(async (file) =>
            (
                await toMessages(
                    // A message's agent is the file's provider, which is not the chat's first one.
                    { ...session, source: file.source },
                    await loadHistory(file.source, file.path),
                )
            ).filter((message) => !out(message)),
        ),
    );
    const others = (otherTurns[session.id] ?? []).filter(
        (message) => !out(message),
    );
    return restoreArchivedWork(session, mergeTranscripts(lists, others));
}

async function fetchTranscript(
    session: SessionItem,
    limit = PAGE_LIMIT,
): Promise<{ messages: Message[]; start: number }> {
    const files = wholeFilesOf(session);
    if (files)
        return {
            messages: await restoreCommandImages(
                session.id,
                await readWhole(session, files),
            ),
            start: 0,
        };
    const page = await loadHistoryPage(
        session.source!,
        session.path!,
        null,
        limit,
    );
    const own = await restoreArchivedWork(
        session,
        await toMessages(session, page.messages),
    );
    const assembled = assemble(
        session,
        own,
        page.start > 0 ? own[0]?.at : undefined,
    );
    const messages = assembled.slice(-limit);
    const removedBefore =
        messages.length < assembled.length
            ? page.messages.filter(
                  (message) => message.time < (messages[0]?.at ?? ''),
              ).length
            : 0;
    return {
        messages: await restoreCommandImages(session.id, messages),
        start: page.start + removedBefore,
    };
}

/**
 * Reads the page of messages before the first one on screen and puts it in front. Returns how many it added.
 * `reach` adds that many messages to the page: a place read several pages up is reached in one read, not page by page.
 */
export async function loadOlder(
    session: SessionItem | undefined,
    reach = 0,
): Promise<number> {
    if (
        !session?.path ||
        !session.source ||
        chat.older <= 0 ||
        chat.loadingOlder
    )
        return 0;
    chat.loadingOlder = true;
    try {
        const page = await loadHistoryPage(
            session.source,
            session.path,
            chat.older,
            PAGE_LIMIT + reach,
        );
        if (workspace.activeId !== session.id) return 0;
        const own = await toMessages(session, page.messages);
        const added = await restoreCommandImages(
            session.id,
            assemble(
                session,
                own,
                page.start > 0 ? own[0]?.at : undefined,
                chat.messages[0]?.at,
            ),
        );
        // Another chat may have been opened while the page was read: it must not get this chat's older messages.
        if (workspace.activeId !== session.id) return 0;
        setMessages(session.id, [...added, ...chat.messages]);
        chat.older = page.start;
        olderById.set(session.id, page.start);
        const cached = transcripts.get(session.id);
        if (cached)
            transcripts.set(session.id, {
                ...cached,
                messages: [...added, ...cached.messages],
                start: page.start,
            });
        return added.length;
    } catch (error) {
        chat.error = String(error);
        return 0;
    } finally {
        // Held until the new rows are laid out and the view is back in place: a scroll event before that (still at the top)
        // would read the next page, and the next, until the whole chat was in.
        setTimeout(() => (chat.loadingOlder = false), 50);
    }
}

function remember(session: SessionItem, messages: Message[], start: number) {
    const entry = { stamp: stampOf(session), messages, start };
    transcripts.set(session.id, entry);
    // The most recently opened few also survive a reload (F5 shows the chat at once).
    // Cloning a long chat is slow, so it waits for an idle moment and keeps only the newest page: F5 then shows
    // the end at once, and a fresh page is read from the history file right after.
    const persist = () =>
        void getPref<string[]>('transcripts.keys').then((keys = []) => {
            const next = [
                session.id,
                ...keys.filter((key) => key !== session.id),
            ];
            const tail = {
                stamp: '',
                messages: stripCommandImageData(messages.slice(-SAVED_TAIL)),
                // A chat read whole has nothing older on disk to page to: its saved tail starts at the first message.
                start: wholeFilesOf(session)
                    ? 0
                    : start + Math.max(0, messages.length - SAVED_TAIL),
            };
            // The key list, the new tail and the removal of the chats that fell out go in one batch (one transaction).
            setPrefs([
                ...next
                    .slice(MAX_SAVED)
                    .map((old): [string, null] => [`transcript.${old}`, null]),
                ['transcripts.keys', next.slice(0, MAX_SAVED)],
                [`transcript.${session.id}`, tail],
            ]);
        });
    if (typeof requestIdleCallback === 'function')
        requestIdleCallback(persist, { timeout: 3000 });
    else setTimeout(persist, 500);
}

/** Warms the cache for a chat the user is likely to open next (row hover, most recent ones). */
const prefetching = new SvelteSet<string>();
export async function prefetchTranscript(session: SessionItem | undefined) {
    if (
        !session?.path ||
        !session.source ||
        transcripts.get(session.id)?.stamp === stampOf(session) ||
        prefetching.has(session.id)
    )
        return;
    prefetching.add(session.id);
    try {
        const fresh = await fetchTranscript(session);
        remember(session, fresh.messages, fresh.start);
    } catch {
        // Opening the chat will report the error.
    } finally {
        prefetching.delete(session.id);
    }
}

let transcriptDone: Promise<void> = Promise.resolve();
/** Settles when the open chat's transcript is complete, the fresh read included: a saved copy can be older than the chat. */
export function transcriptSettled(): Promise<void> {
    return transcriptDone;
}

/** Newest messages read when a held list is checked against its file: enough for a turn of many tool steps. */
const CATCH_UP_LIMIT = 200;

/**
 * Brings the newest messages of a held list up to its file. The rows above the first changed one keep their place,
 * so a reader scrolled up is not moved. A file that no longer overlaps the list is read again from the start.
 */
async function catchUp(session: SessionItem) {
    let read: { messages: Message[]; start: number };
    try {
        read = await fetchTranscript(session, CATCH_UP_LIMIT);
    } catch {
        // The held list stays: the next open checks again.
        return;
    }
    const { messages: fresh } = read;
    const held = messagesById.get(session.id);
    // The list was replaced or released while the file was read: the newer read decides.
    if (!held || !olderById.has(session.id)) return;
    // The held list starts inside the page read (it holds fewer messages than the page): only the file from the held
    // list's first message on is used, so reopening a chat never adds older messages to it or makes it longer.
    const from = held[0]
        ? fresh.findIndex((message) => message.id === held[0].id)
        : -1;
    if (from >= 0) {
        setMessages(
            session.id,
            withLive(session.id, mergeWorkMessages(fresh.slice(from), held)),
        );
        return;
    }
    const at = tailStart(held, fresh);
    if (at < 0) {
        olderById.delete(session.id);
        if (workspace.activeId === session.id)
            void readFromFile(session, ++transcriptToken);
        return;
    }
    // Live replies and asks are not in the file yet: withLive puts back the ones still running.
    const tail = withLive(session.id, mergeWorkMessages(fresh, held.slice(at)));
    setMessages(session.id, [...held.slice(0, at), ...tail]);
}

/** Fills the chat with the transcript of a session: from cache when it is current, from disk otherwise. */
export function openTranscript(
    session: SessionItem | undefined,
): Promise<void> {
    let finish = () => {};
    transcriptDone = new Promise<void>((resolve) => (finish = resolve));
    return readTranscript(session)
        .finally(finish)
        .then(() => shadowReadOf(session));
}

/**
 * Shadow read (dual write): once the open chat is shown whole, its turns are counted in the ledger and compared with
 * the app's. Only a mismatch is logged; nothing is shown from the ledger.
 */
function shadowReadOf(session: SessionItem | undefined) {
    if (!session || !ledgerOn()) return;
    // `older` counts turns not loaded yet: the count is only whole when none are left.
    if (session.id !== workspace.activeId || chat.older !== 0 || chat.loading)
        return;
    const list = messagesOf(session.id);
    // A reply still being written is not in the ledger yet.
    if (list.some((message) => message.live)) return;
    ledger.shadowRead(session.id, list.length);
}

async function readTranscript(session: SessionItem | undefined) {
    const token = ++transcriptToken;
    chat.error = '';
    chat.older = 0;
    if (!session) {
        chat.messages = [];
        chat.loading = false;
        return;
    }
    if (!session.path || !session.source) {
        // A read of the chat before may still be loading: its result is dropped, so it can no longer clear the flag.
        chat.loading = false;
        // A list the chat already holds (a turn ran in it while it was not open) is the one to show.
        // The ledger is read (plan storage-sqlite P5.3) when IndexedDB has no copy of the chat, or when the read flag is on
        // and the copy has turns. IndexedDB is still written either way.
        const copy = localMessages[session.id];
        const wantLedger =
            ledgerOn() &&
            !mockIds.has(session.id) &&
            (copy === undefined || (ledgerReadOn() && copy.length > 0));
        const fromLedger = wantLedger
            ? await readLedgerChat(session.id).catch(() => null)
            : null;
        const shown =
            ledgerReadOn() && fromLedger?.length
                ? fromLedger
                : (copy ??
                  fromLedger ??
                  (mockIds.has(session.id) ? mockMessages : []));
        const messages =
            messagesById.get(session.id) ??
            (await restoreCommandImages(session.id, shown));
        if (token === transcriptToken) {
            setMessages(session.id, messages);
        }
        return;
    }
    // A chat whose list is held (shown since its file was last read) opens at once, from memory: no skeleton, no wait
    // for the file. Its newest messages are checked against the file while it shows (see catchUp).
    const held = messagesById.get(session.id);
    const older = olderById.get(session.id);
    if (held && older !== undefined) {
        setMessages(session.id, held);
        chat.older = older;
        chat.loading = false;
        void catchUp(session);
        return;
    }
    return readFromFile(session, token);
}

/** Fills a chat from its file: the saved copy first when there is one, then the file's newest page. */
async function readFromFile(session: SessionItem, token: number) {
    olderById.delete(session.id);
    // Show the empty chat with its skeleton first and let it paint: reading the saved copy and mounting a long chat
    // takes a moment on the main thread, and the window must not look frozen meanwhile.
    chat.messages = [];
    chat.loading = true;
    await new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)),
    );
    if (token !== transcriptToken) return;
    // A chat read from several files is never shown from its saved tail: the tail is not the whole chat, and showing it
    // first made the view move when the whole chat replaced it.
    const whole = Boolean(wholeFilesOf(session));
    let cached = whole ? undefined : transcripts.get(session.id);
    if (!cached && !whole) {
        const saved = await getPref<Transcript>(`transcript.${session.id}`);
        if (token !== transcriptToken) return;
        if (saved?.messages) {
            // Older versions kept up to 200 messages in IndexedDB. Bound this first paint too, before the fresh page arrives.
            const removed = Math.max(0, saved.messages.length - PAGE_LIMIT);
            cached = removed
                ? {
                      ...saved,
                      messages: saved.messages.slice(-PAGE_LIMIT),
                      start: saved.start + removed,
                  }
                : saved;
            transcripts.set(session.id, cached);
        }
    }
    if (cached) {
        // Show what we have right away; a stale copy is replaced as soon as the fresh one arrives.
        setMessages(
            session.id,
            await restoreCommandImages(
                session.id,
                withLive(
                    session.id,
                    await restoreArchivedWork(session, cached.messages),
                ),
            ),
        );
        if (token !== transcriptToken) return;
        chat.older =
            cached.stamp === stampOf(session) ? (cached.start ?? 0) : 0;
        chat.loading = false;
        if (cached.stamp === stampOf(session)) {
            olderById.set(session.id, cached.start ?? 0);
            return;
        }
    } else {
        chat.loading = true;
    }
    try {
        const fresh = await fetchTranscript(session);
        if (token !== transcriptToken) return;
        // A pre-update transcript cache may still contain work cards that the provider parser cannot represent.
        const merged = mergeWorkMessages(
            fresh.messages,
            cached?.messages ?? [],
        );
        setMessages(session.id, withLive(session.id, merged));
        chat.older = fresh.start;
        olderById.set(session.id, fresh.start);
        remember(session, merged, fresh.start);
    } catch (error) {
        if (token !== transcriptToken) return;
        if (!cached) {
            setMessages(session.id, []);
        }
        chat.error = String(error);
    } finally {
        if (token === transcriptToken) chat.loading = false;
    }
}

/** The cached index mirrors the files on disk, so a rename or delete has to reach it too. */
async function patchCache(
    change: (list: HistorySession[]) => HistorySession[],
) {
    try {
        const list = (await getPref<HistorySession[]>(HISTORY_INDEX)) ?? [];
        void setPref(HISTORY_INDEX, change(list));
    } catch {
        // Only an optimisation.
    }
}

/** Renames the chat; for Claude and Codex sessions the name is written into the tool's own storage. */
export async function renameSession(id: string, title: string) {
    const session = workspace.sessions.find((item) => item.id === id);
    const next = title.trim();
    if (!session || !next) return;
    if (session.path && session.source)
        await renameHistory(session.source, session.path, next);
    session.title = next;
    patchCache((list) =>
        list.map((item) => (item.id === id ? { ...item, title: next } : item)),
    );
}

/** Deletes the chat; Claude and Codex sessions are moved to ~/.agentdeck/trash, so they vanish there too. */
/** An idle warm CLI can have touched the transcript recently without a visible turn. Release only this chat before the adapter moves its file; other chats keep running. */
export async function releaseCli(id: string) {
    if (!inTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('agent_warm_reset_session', { session: id });
    } catch {
        // The history delete below still reports a real external writer if one is present.
    }
}

/** The list and every cache forget the removed chats at once, so the sidebar changes in one pass, not row by row. */
async function forgetSessions(removed: SessionItem[], trashed = false) {
    if (!removed.length) return;
    const gone = new Set(removed.map((item) => item.id));
    // Forks of a removed chat move up to the nearest parent that stays.
    const survivingParent = (id: string | undefined): string | undefined => {
        let parent = id;
        while (parent && gone.has(parent))
            parent = workspace.sessions.find(
                (item) => item.id === parent,
            )?.parentId;
        return parent;
    };
    for (const child of workspace.sessions)
        if (!gone.has(child.id) && child.parentId && gone.has(child.parentId))
            child.parentId = survivingParent(child.parentId);
    const activeGone = gone.has(workspace.activeId);
    const activeProject = removed.find(
        (item) => item.id === workspace.activeId,
    )?.projectId;
    workspace.sessions = workspace.sessions.filter(
        (item) => !gone.has(item.id),
    );
    // The ledger drops the chat too (a trashed chat stays in the ledger, in its trash). Its native files are moved by the
    // caller, not by the ledger.
    if (!trashed) for (const id of gone) ledger.remove(id);
    for (const id of gone) {
        delete drafts[id];
        delete draftMentions[id];
        delete draftImages[id];
        delete draftFiles[id];
        delete draftElements[id];
        delete localMessages[id];
        messagesById.delete(id);
        // What the chat kept in memory for its runs, queue and recoveries: nothing reads it again, and it would only grow.
        delete queued[id];
        delete queuePaused[id];
        delete turns[id];
        delete lastPrompt[id];
        delete replies[id];
        delete liveReplies[id];
        delete liveAsks[id];
        delete sessionLanes[id];
        delete recoveries[id];
        delete resumes[id];
        delete otherTurns[id];
        delete mixed[id];
        pendingMixed.delete(id);
        delete hidden[id];
        transcripts.delete(id);
        olderById.delete(id);
        heldOrder.delete(id);
        backlog.delete(id);
        lastEventAt.delete(id);
        lastEventKind.delete(id);
        deleteCommandImages(id);
        forgetSessionPlacement(id);
    }
    void mixedReady.then(() => setPref('chat.mixed', mixed));
    patchCache((list) => list.filter((item) => !gone.has(item.id)));
    if (activeGone) {
        const next =
            workspace.sessions.find(
                (item) => item.projectId === activeProject,
            ) ?? workspace.sessions[0];
        if (next) workspace.activeId = next.id;
        else newSession(activeProject);
    }
}

/** A local chat (made in AgentDeck, no history file) with no activity for this long is deleted. */
const DELETE_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Deletes the local chats idle for 14 days: from the list, the IndexedDB copy and the ledger, for good. Imported chats
 * (with a history file) are never deleted here. Returns the ids deleted.
 */
export async function deleteIdleChats(now = Date.now()): Promise<string[]> {
    if (!inTauri() || !ledgerOn()) return [];
    const idle = workspace.sessions.filter(
        (item) =>
            !item.path &&
            !item.source &&
            !item.draft &&
            item.status === 'idle' &&
            item.id !== workspace.activeId &&
            now - Date.parse(item.updatedAt ?? '') > DELETE_IDLE_MS,
    );
    await forgetSessions(idle);
    return idle.map((item) => item.id);
}

export async function deleteSession(id: string) {
    const session = workspace.sessions.find((item) => item.id === id);
    if (!session) return;
    // A run of the chat ends with it: its CLI is stopped and the events that still arrive have nowhere to go.
    stopTurn(id);
    await releaseCli(id);
    if (session.path && session.source)
        await deleteHistory(session.source, session.path);
    await forgetSessions([session]);
}

/** Deletes many chats at once: the files move in parallel, then the list updates once. Returns the ids whose files could not be moved; those stay in the list. */
export async function deleteSessions(ids: string[]): Promise<string[]> {
    const sessions = workspace.sessions.filter((item) => ids.includes(item.id));
    for (const session of sessions) stopTurn(session.id);
    const failed = new SvelteSet<string>();
    await Promise.all(
        sessions.map(async (session) => {
            await releaseCli(session.id);
            try {
                if (session.path && session.source)
                    await deleteHistory(session.source, session.path);
            } catch {
                failed.add(session.id);
            }
        }),
    );
    await forgetSessions(sessions.filter((item) => !failed.has(item.id)));
    return [...failed];
}
