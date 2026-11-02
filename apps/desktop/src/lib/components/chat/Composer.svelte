<script lang="ts">
    import RunActionButton from './RunActionButton.svelte';
    import ProjectBar from '../layout/ProjectBar.svelte';
    import { onMount, untrack } from 'svelte';
    import { askBtw } from '../../chat/session/btw.svelte';
    import { btwQuestionOf } from '../../chat/session/btw-command';
    import { getPref, setPref } from '../../app/platform/prefs';
    import {
        ZButton,
        ZIcon,
        ZPopover,
        ZProgress,
        ZSlider,
        zTooltip,
    } from '@shival99/z-ui-svelte';
    import PickerPopover, { type PickerItem } from '../ui/PickerPopover.svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
    import { loadSlash, slash, type SlashItem } from '../../chat/slash.svelte';
    import { prepare, search } from '../../app/ui/palette';
    import ElementCard from '../browser/ElementCard.svelte';
    import { TRIGGER_ON } from '../../app/ui/popover';
    import {
        agyBlocks,
        agyModes,
        loadAgyModes,
    } from '../../agents/agy-modes.svelte';
    import { accountEpoch } from '../../chat/runs/account-epoch.svelte';
    import {
        AGENTS,
        draftElements,
        draftImages,
        draftFiles,
        draftMentions,
        drafts,
        replies,
        isRunning,
        messagesView,
        needsUserInput,
        lastChat,
        queued,
        queuePaused,
        type Queued,
        sendMessage,
        prewarmChat,
        stopTurnForResume,
        resumeStoppedTurn,
        manuallyStopped,
        turnOptions,
        chatTurnOptions,
        pendingSwitch,
        applyPendingSwitch,
        workspace,
        type Agent,
        type Effort,
        type Attachment,
        type FileAttachment,
        type Mention,
        type Permission,
    } from '../../chat/sessions.svelte';
    import TextEditContextMenu from '../ui/TextEditContextMenu.svelte';
    import {
        clipFromContents,
        clipFromPaste,
        imageMime,
        isImageName,
    } from '../../chat/content/attachments';
    import {
        createTextHistory,
        type TextHistory,
    } from '../../app/text/text-history';
    import {
        fileSize,
        keepPicture,
        saveFileAttachment,
    } from '../../chat/agent';
    import { inTauri } from '../../app/platform/history';
    import { toast } from '../../app/platform/toast';
    import ModelPicker from './ModelPicker.svelte';
    import ComposerQueue from './ComposerQueue.svelte';
    import {
        loadImagePrompts,
        type ImagePrompt,
    } from '../../files/image-prompt-library.svelte';
    import BackgroundTasks from './BackgroundTasks.svelte';
    import { chatWork } from '../../chat/session/work.svelte';
    import { hasTurnWork } from '../../chat/session/turns.svelte';
    import ComposerChips from './ComposerChips.svelte';
    import {
        editorText,
        editorSelection,
        setEditorSelection,
        replaceEditorRange,
        renderEditor,
        scrollCaretIntoView,
    } from './composer-editor';
    import ComposerQuota from './ComposerQuota.svelte';
    import {
        DOC_MAX,
        LONG_PASTE_CHARS,
        MAX_IMAGES,
        isMarkdownText,
        readBase64,
        toAttachment,
    } from './composer-helpers';
    import {
        buildMentionGroups,
        buildSlashGroups,
        flatten,
    } from './composer-pickers';
    import { voiceOf } from '../../chat/voice.svelte';
    import { shortCount } from '../../chat/runs/usage';
    import {
        CONTEXT_LIMITS,
        contextLimitOf,
        setSessionContextLimit,
    } from '../../chat/session/state.svelte';

    // What is typed belongs to the open session: switch away and back and it is still there.
    const sessionId = $derived(workspace.activeId);
    const voice = $derived(voiceOf(sessionId));
    const draft = $derived(drafts[sessionId] ?? '');
    const mentions = $derived(draftMentions[sessionId] ?? []);
    // Ctrl+Z / Ctrl+Y go through a history of our own (per chat): the draft is written from code (a send, a clear, another
    // chat's draft), which drops the textarea's own undo history. A sent message can be brought back with Ctrl+Z too.
    const histories: Record<string, TextHistory> = {};
    const historyOf = (id: string) =>
        (histories[id] ??= createTextHistory(drafts[id] ?? ''));
    const setDraftFor = (id: string, value: string, { sent = false } = {}) => {
        historyOf(id).note(value, { boundary: sent });
        drafts[id] = value;
        // Typing a message starts the agent's CLI, so it is up by the time the message is sent.
        if (!sent && value.trim()) prewarmChat(id);
    };
    const setDraft = (value: string, options: { sent?: boolean } = {}) =>
        setDraftFor(sessionId, value, options);
    const setMentions = (value: Mention[]) => {
        draftMentions[sessionId] = value;
    };
    const images = $derived(draftImages[sessionId] ?? []);
    const attached = $derived(draftFiles[sessionId] ?? []);
    const setFiles = (value: FileAttachment[]) => {
        draftFiles[sessionId] = value;
    };
    const elements = $derived(draftElements[sessionId] ?? []);
    // Only this message's reply counts: a background task that keeps listening does not keep the box spinning.
    const running = $derived(
        isRunning(sessionId) || Boolean(replies[sessionId]),
    );
    const backgroundWork = $derived(chatWork(sessionId));
    const mac =
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    const waiting = $derived(queued[sessionId] ?? []);
    const waitingForUser = $derived(needsUserInput(sessionId));
    const contextReply = $derived(
        [...messagesView(sessionId)]
            .reverse()
            .find(
                (message) =>
                    message.role === 'assistant' &&
                    message.agent === agent &&
                    message.context != null,
            ) ?? undefined,
    );
    const contextTokens = $derived(contextReply?.context ?? 0);
    const contextLimit = $derived(
        contextLimitOf(
            workspace.sessions.find((session) => session.id === sessionId),
        ),
    );
    const contextLimitIndex = $derived(CONTEXT_LIMITS.indexOf(contextLimit));
    const contextPercent = $derived(
        contextTokens > 0
            ? Math.min(100, Math.round((contextTokens / contextLimit) * 100))
            : 0,
    );
    let contextOpen = $state(false);
    let contextAnchor: HTMLElement | null = $state(null);
    let promptHistoryOpen = $state(false);
    let promptHistoryAnchor: HTMLElement | null = $state(null);
    let promptHistory = $state<ImagePrompt[]>([]);
    let promptHistoryVersion = $state(0);
    const promptHistoryItems = $derived<PickerItem<ImagePrompt>[]>(
        promptHistory.map((item) => ({
            id: item.id,
            label: item.prompt,
            hint: `Prompt · ${new Date(item.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`,
            icon: 'lucideHistory',
            selected: item.prompt === draft,
            data: item,
        })),
    );
    async function refreshPromptHistory() {
        promptHistory = await loadImagePrompts();
    }
    $effect(() => {
        void promptHistoryVersion;
        if (promptHistoryOpen) void refreshPromptHistory();
    });
    function choosePromptHistory(item: PickerItem<ImagePrompt>) {
        setDraft(item.data.prompt);
        promptHistoryOpen = false;
        requestAnimationFrame(() => {
            area?.focus();
            if (area) setEditorSelection(area, item.data.prompt.length);
            resize();
        });
    }
    const contextTone = $derived(
        contextPercent >= 90
            ? 'text-destructive'
            : contextPercent >= 75
              ? 'text-warning'
              : 'text-primary',
    );
    // A queued message not sent yet goes back into the field to be changed; sending it again queues it as before. What
    // was in the field takes its place in the queue, so nothing typed is lost.
    function editQueued(item: Queued) {
        const list = [...waiting];
        const at = list.indexOf(item);
        if (at === -1) return;
        if (hasInput)
            list[at] = {
                text: draft,
                images: [...images],
                elements: [...elements],
                mentions: [...mentions],
                files: [...attached],
            };
        else list.splice(at, 1);
        if (list.length) queued[sessionId] = list;
        else delete queued[sessionId];
        setDraft(item.text);
        setImages(item.images);
        setFiles(item.files ?? []);
        draftElements[sessionId] = item.elements;
        setMentions(item.mentions ?? []);
        requestAnimationFrame(() => {
            area?.focus();
            if (area) setEditorSelection(area, item.text.length);
            resize();
        });
    }
    const hasInput = $derived(
        draft.trim().length > 0 ||
            images.length > 0 ||
            elements.length > 0 ||
            attached.length > 0,
    );
    const action = $derived(
        running && !hasInput
            ? 'stop'
            : manuallyStopped[sessionId] && !hasInput
              ? 'resume'
              : 'send',
    );
    const willQueue = $derived(
        !waitingForUser && (hasTurnWork(sessionId) || waiting.length > 0),
    );
    // The foreground reply owns the Stop ring. Background activity has its own indicator above the composer.
    const spinning = $derived(action === 'stop' && !waitingForUser);
    let detail = $state<string | null>(null);
    // The card stays mounted after it closes, so its exit animation can play: it keeps the last element shown.
    let lastDetail = $state<string | null>(null);
    $effect(() => {
        if (detail) lastDetail = detail;
    });
    let chipAnchors = $state<Record<string, HTMLElement | null>>({});
    const setImages = (value: Attachment[]) => {
        draftImages[sessionId] = value;
    };
    let fileInput: HTMLInputElement | undefined = $state();
    let dragging = $state(false);
    let area: HTMLDivElement | undefined = $state();
    let restoreOnWindowFocus = false;
    onMount(() => {
        const rememberComposerFocus = () => {
            restoreOnWindowFocus = document.activeElement === area;
        };
        const restoreComposerFocus = () => {
            if (!restoreOnWindowFocus) return;
            restoreOnWindowFocus = false;
            requestAnimationFrame(() => {
                if (
                    !area?.isConnected ||
                    document.activeElement === area ||
                    document.querySelector('[role="dialog"]')
                )
                    return;
                area.focus({ preventScroll: true });
            });
        };
        window.addEventListener('blur', rememberComposerFocus);
        window.addEventListener('focus', restoreComposerFocus);
        return () => {
            window.removeEventListener('blur', rememberComposerFocus);
            window.removeEventListener('focus', restoreComposerFocus);
        };
    });
    let textEditMenu = $state<
        { openAt: (event: MouseEvent, target: HTMLElement) => void } | undefined
    >();
    const caret = () =>
        area
            ? editorSelection(area)
            : { start: draft.length, end: draft.length };
    $effect(() => {
        void sessionId;
        void draft;
        void mentions;
        if (area) renderEditor(area, draft, mentions);
    });
    // `@` or `/` at the start of a word opens a picker over the message box; what follows it (up to the caret) is the
    // search. The text stays in the box while the picker is open, as in Claude; picking replaces it.
    type Trigger = { char: '@' | '/'; at: number; query: string };
    let trigger = $state<Trigger | null>(null);
    // Escape puts a picker away until the text before the caret changes again.
    let dismissed: string | null = null;
    let picker = $state<{ key: (event: KeyboardEvent) => boolean }>();
    const paletteOpen = $derived(trigger?.char === '@');
    const slashOpen = $derived(trigger?.char === '/');
    const slashQuery = $derived(slashOpen ? (trigger?.query ?? '') : '');
    const mentionQuery = $derived(paletteOpen ? (trigger?.query ?? '') : '');
    /** Reads the word under the caret: a picker is open while it starts with `@` or `/`. */
    function detectTrigger() {
        if (!area) return;
        const position = caret();
        const before = draft.slice(0, position.start);
        if (position.end !== position.start || before === dismissed)
            return void (trigger = null);
        dismissed = null;
        const category = /(^|\s)\/([cmpw])(?:\s+([^\n]*))?$/i.exec(before);
        const found = category ?? /(^|\s)([@/])([^\s@/]*)$/.exec(before);
        trigger = found
            ? {
                  char: category ? '/' : (found[2] as '@' | '/'),
                  at: category
                      ? position.start -
                        (category[3]?.length ?? 0) -
                        category[2].length -
                        (category[0].match(/\s+/)?.[0].length ?? 0) -
                        1
                      : position.start - found[3].length - 1,
                  query: category
                      ? `${category[2]} ${category[3] ?? ''}`.trimEnd()
                      : found[3],
              }
            : null;
    }
    /** Takes the typed `@query` or `/query` out of the box and puts `insert` in its place. */
    function replaceTrigger(insert: string) {
        if (!trigger) return;
        const selection = caret();
        const start = trigger.at;
        setDraft(
            `${draft.slice(0, start)}${insert}${draft.slice(selection.end)}`,
        );
        trigger = null;
        queueMicrotask(() => {
            area?.focus();
            if (area) setEditorSelection(area, start + insert.length);
            resize();
        });
    }
    let innerW = $state(
        typeof window === 'undefined' ? 1280 : window.innerWidth,
    );

    // Agent + model of this message. They follow the active session and can be overridden with @AI.
    let agent = $state<Agent>('claude');
    let model = $state('claude-sonnet-5-5');
    let effort = $state<Effort>('medium');
    let fast = $state(true);
    let permission = $state<Permission>('auto');

    // The chat whose picker the fields above show. It changes only once that chat's picker is applied (`applyPickerFor`):
    // until then the fields still hold the previous chat's values, which must not reach the new chat (B8).
    let pickerOf = $state('');

    $effect(() => {
        if (pickerOf !== sessionId) return;
        turnOptions.permission = permission;
        turnOptions.effort = effort;
        chatTurnOptions[sessionId] = { permission, effort };
    });

    // Antigravity's modes depend on the account. Find out which ones this account has, and never leave the chat on one
    // it lacks (agy would ignore it and ask for every command): fall back to asking, the one setting that always exists.
    $effect(() => {
        if (agent === 'antigravity') {
            const switched = (accountEpoch.agy ?? 0) > 0;
            void loadAgyModes(switched);
        }
    });
    $effect(() => {
        if (agent === 'antigravity' && agyModes.loaded && agyBlocks(permission))
            permission = 'ask';
    });

    // The picker belongs to each session: agent, model, effort, speed and approval mode are remembered per
    // session in IndexedDB, so a reload brings back what that chat was using.
    type Picker = {
        agent: Agent;
        model: string;
        effort: Effort;
        fast: boolean;
        permission: Permission;
    };
    let pickers: Record<string, Picker> = {};
    let pickersLoaded = false;

    function applyPickerFor(sessionId: string) {
        pickerOf = sessionId;
        const saved = pickers[sessionId];
        if (saved) {
            // The chat's own agent and model win: a pick that applied when its turn ended (D3) may not be saved yet.
            const current = workspace.sessions.find(
                (item) => item.id === sessionId,
            );
            const waiting = pendingSwitch[sessionId];
            agent = waiting?.agent ?? current?.agent ?? saved.agent;
            model = waiting?.model ?? current?.model ?? saved.model;
            effort = saved.effort;
            fast = saved.fast;
            permission = saved.permission;
            return;
        }
        // A chat with nothing saved starts with fast mode on, and with the defaults: the picker of the chat before
        // is not carried over (B8).
        fast = true;
        permission = 'auto';
        effort = 'medium';
        const session = workspace.sessions.find(
            (item) => item.id === sessionId,
        );
        if (session) {
            agent = session.agent;
            model = session.model;
            // A new chat also takes the effort of the last chat that was written in.
            if (
                session.draft &&
                lastChat.agent &&
                lastChat.agent === session.agent &&
                lastChat.model === session.model
            )
                effort = lastChat.effort;
        }
    }

    getPref<Record<string, Picker>>('composer.pickers').then((saved) => {
        pickers = saved ?? {};
        // Every chat's permission and effort, not only the one on screen: a turn that runs in the background (a queued
        // message, a recovery, a worker) reads its own chat's settings (D7).
        for (const [id, picked] of Object.entries(pickers))
            chatTurnOptions[id] ??= {
                permission: picked.permission,
                effort: picked.effort,
            };
        pickersLoaded = true;
        if (workspace.activeId)
            untrack(() => applyPickerFor(workspace.activeId));
    });

    // Switching session: show that session's picker.
    $effect(() => {
        const id = workspace.activeId;
        if (id) untrack(() => applyPickerFor(id));
    });

    // A chat moved to another agent by itself (its agent failed and the next one of the chain took over): its picker
    // follows, so the next message goes to the agent now in charge.
    $effect(() => {
        const moved = (event: Event) => {
            const {
                sessionId: id,
                agent: next,
                model: nextModel,
                effort: nextEffort,
            } = (
                event as CustomEvent<{
                    sessionId: string;
                    agent: Agent;
                    model: string;
                    effort?: string;
                }>
            ).detail;
            // The fallback's effort comes with its model: it is applied to the picker and saved with the chat (D8).
            const level = nextEffort as Effort | undefined;
            // Saved only once the pickers have loaded: an earlier save would overwrite every chat's picker.
            if (pickersLoaded) {
                const saved = pickers[id];
                pickers[id] = {
                    ...(saved ?? {
                        agent: next,
                        model: nextModel,
                        effort: level ?? 'medium',
                        fast: true,
                        permission: chatTurnOptions[id]?.permission ?? 'auto',
                    }),
                    agent: next,
                    model: nextModel,
                    ...(level ? { effort: level } : {}),
                };
                setPref('composer.pickers', pickers);
            }
            if (id === workspace.activeId) {
                agent = next;
                model = nextModel;
                if (level) effort = level;
            }
        };
        window.addEventListener('agentdeck:agent-moved', moved);
        return () => window.removeEventListener('agentdeck:agent-moved', moved);
    });

    // Any change of the picker: remember it for this session and make it the session's model.
    $effect(() => {
        const current: Picker = { agent, model, effort, fast, permission };
        const id = workspace.activeId;
        // Only the picker's own chat is saved: on a switch the fields still hold the previous chat (B8).
        if (!pickersLoaded || !id || pickerOf !== id) return;
        untrack(() => {
            const session = workspace.sessions.find((item) => item.id === id);
            // A chat whose turn runs keeps the route of that turn: a new agent or model waits for the turn to end (D3).
            // The picker keeps the pick and shows that it applies after this turn (see ModelPicker).
            const waits =
                Boolean(session) &&
                isRunning(id) &&
                (session?.agent !== current.agent ||
                    session?.model !== current.model);
            if (waits && session) {
                pendingSwitch[id] = {
                    agent: current.agent,
                    model: current.model,
                };
                pickers[id] = {
                    ...current,
                    agent: session.agent,
                    model: session.model,
                };
                setPref('composer.pickers', pickers);
                return;
            }
            pickers[id] = current;
            setPref('composer.pickers', pickers);
            // No turn runs: the pick is the chat's route now. applyPendingSwitch makes that change (R3.3).
            pendingSwitch[id] = { agent: current.agent, model: current.model };
            applyPendingSwitch(id);
        });
    });

    // ---------- slash commands ----------
    // The agent's own commands and skills, plus AgentDeck's: read for the agent and project of this chat.
    const projectPath = $derived(
        workspace.projects.find(
            (item) =>
                item.id ===
                workspace.sessions.find((entry) => entry.id === sessionId)
                    ?.projectId,
        )?.path ?? null,
    );
    $effect(() => {
        void loadSlash(agent, projectPath);
    });
    const agentLabel = $derived(
        AGENTS.find((entry) => entry.value === agent)?.label ?? agent,
    );
    const slashGroups = $derived(buildSlashGroups(slash.items, agentLabel));

    const slashPrepared = $derived(
        slashOpen
            ? prepare(slashGroups, (item) =>
                  String(item.data?.name ?? item.label),
              )
            : [],
    );
    // AgentDeck's own commands lead, so the first row selected is one of them.
    const slashShown = $derived(
        slashOpen ? search(slashPrepared, slashQuery, 40, 'AgentDeck') : [],
    );

    const slashItems = $derived(
        flatten(slashShown, (item, group) => ({
            id: item.id,
            label: `/${item.data?.name ?? ''}`,
            icon: item.icon,
            description: item.data?.description || undefined,
            group,
            data: item.data as SlashItem,
        })),
    );

    /** Puts `/name ` in place of the typed `/query`, so the arguments can be typed right after it. */
    function pickSlash(item: PickerItem<SlashItem>) {
        replaceTrigger(`/${item.data.name} `);
    }

    // ---------- mentions ----------
    const categoryMode = $derived(
        slashOpen && /^[cmpw](?:\s|$)/i.test(slashQuery)
            ? ({ c: 'session', p: 'project', m: 'ai', w: 'workflow' } as const)[
                  slashQuery[0].toLowerCase() as 'c' | 'p' | 'm' | 'w'
              ]
            : undefined,
    );
    const mentionPaletteOpen = $derived(paletteOpen || Boolean(categoryMode));
    const mentionSearch = $derived(
        categoryMode ? slashQuery.slice(1).trim() : mentionQuery,
    );
    const groups = $derived(buildMentionGroups(categoryMode));

    const mentionPrepared = $derived(mentionPaletteOpen ? prepare(groups) : []);
    const mentionShown = $derived(
        mentionPaletteOpen ? search(mentionPrepared, mentionSearch) : [],
    );

    const mentionItems = $derived(
        flatten(mentionShown, (item, group) => ({
            id: item.id,
            label: item.label,
            hint: item.keywords?.[0] || undefined,
            icon: item.icon,
            agent:
                item.data?.kind === 'ai'
                    ? (String(item.data.id).split('/')[0] as Agent)
                    : undefined,
            group,
            data: item.data as Mention,
        })),
    );

    function pickMention(item: PickerItem<Mention>) {
        const picked = item.data;
        // Mentions stay inline; resolved provider/model metadata is injected for the main model at send time.
        replaceTrigger(
            picked.kind === 'workflow'
                ? `/w ${picked.label} `
                : `@${picked.label} `,
        );
        if (picked.kind === 'workflow')
            setMentions([
                ...mentions.filter((entry) => entry.kind !== 'workflow'),
                picked,
            ]);
        else if (
            !mentions.some(
                (entry) => entry.kind === picked.kind && entry.id === picked.id,
            )
        )
            setMentions([...mentions, picked]);
    }
    function resize() {
        if (!area) return;
        area.style.height = 'auto';
        area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
    }

    // The textarea height follows the text of whichever session is open.
    $effect(() => {
        void sessionId;
        void draft;
        untrack(() => queueMicrotask(resize));
    });

    // ---------- images: paste, drop or pick ----------

    /** Markdown and very long clipboard text become attachments, matching the regular paste handler. */
    function routePastedText(text: string, id = sessionId): boolean {
        if (isMarkdownText(text)) {
            attachMarkdown(text, id);
            return true;
        }
        if (text.length > LONG_PASTE_CHARS) {
            void addDocuments(
                [new File([text], 'Pasted text.txt', { type: 'text/plain' })],
                id,
            );
            return true;
        }
        return false;
    }

    function onTextAreaContextMenu(event: MouseEvent) {
        if (area) textEditMenu?.openAt(event, area);
    }

    /** Markdown paste travels as an attachment, leaving the composer free for a question. */
    function attachMarkdown(text: string, id: string) {
        void addDocuments(
            [new File([text], 'Pasted Markdown.md', { type: 'text/markdown' })],
            id,
        );
    }

    async function addFiles(files: File[]) {
        const isPicture = (file: File) =>
            /^image\/(png|jpeg|gif|webp)$/.test(file.type);
        const id = sessionId;
        const pictures = files.filter(isPicture);
        const documents = files.filter((file) => !isPicture(file));
        const room = MAX_IMAGES - images.length;
        const added = (
            await Promise.all(
                pictures
                    .slice(0, Math.max(0, room))
                    .map((file) => toAttachment(file).catch(() => null)),
            )
        ).filter((item): item is Attachment => item !== null);
        if (added.length)
            draftImages[id] = [
                ...(draftImages[id] ?? []),
                ...(await Promise.all(added.map(keepPicture))),
            ];
        if (documents.length) await addDocuments(documents, id);
    }

    /** Documents picked or dropped as File objects: written to disk (the agent is given the path). */
    async function addDocuments(documents: File[], id: string) {
        if (!inTauri()) {
            toast.error('Attaching documents needs the desktop app');
            return;
        }
        const added: FileAttachment[] = [];
        for (const file of documents) {
            if (file.size > DOC_MAX) {
                toast.error(`${file.name} is larger than 25 MB`);
                continue;
            }
            try {
                const path = await saveFileAttachment(
                    file.name || 'file',
                    await readBase64(file),
                );
                added.push({
                    id: crypto.randomUUID(),
                    name: file.name || 'file',
                    path,
                    size: file.size,
                });
            } catch {
                toast.error(`Could not attach ${file.name}`);
            }
        }
        if (added.length)
            draftFiles[id] = [...(draftFiles[id] ?? []), ...added];
    }

    /** Files dropped on the window arrive as paths (Tauri's drop event): used where they are, pictures are read for a thumbnail. */
    async function addPaths(paths: string[]) {
        const id = sessionId;
        const docs: FileAttachment[] = [];
        const pics: Attachment[] = [];
        const { invoke } = await import('@tauri-apps/api/core');
        for (const path of paths) {
            const name = path.split('/').pop() ?? path;
            try {
                if (
                    isImageName(name) &&
                    images.length + pics.length < MAX_IMAGES
                ) {
                    const base64 = await invoke<string>('file_read_bytes', {
                        root: path.replace(/[/][^/]*$/, ''),
                        path,
                    });
                    const bytes = Uint8Array.from(atob(base64), (char) =>
                        char.charCodeAt(0),
                    );
                    const picture = await toAttachment(
                        new File([bytes], name, { type: imageMime(name) }),
                    );
                    if (picture) pics.push(picture);
                    continue;
                }
                const size = await fileSize(path);
                if (size === null) continue; // a folder
                if (size > DOC_MAX) {
                    toast.error(`${name} is larger than 25 MB`);
                    continue;
                }
                docs.push({ id: crypto.randomUUID(), name, path, size });
            } catch {
                toast.error(`Could not attach ${name}`);
            }
        }
        if (pics.length)
            draftImages[id] = [
                ...(draftImages[id] ?? []),
                ...(await Promise.all(pics.map(keepPicture))),
            ];
        if (docs.length) draftFiles[id] = [...(draftFiles[id] ?? []), ...docs];
    }

    // Tauri swallows the browser's own file drop, so the window's drop event is used: a drop over the conversation area
    // attaches the files.
    let formEl: HTMLFormElement | undefined = $state();
    $effect(() => {
        if (!inTauri()) return;
        let off: (() => void) | undefined;
        let gone = false;
        void import('@tauri-apps/api/webview').then(
            async ({ getCurrentWebview }) => {
                const stop = await getCurrentWebview().onDragDropEvent(
                    (event) => {
                        const area = formEl
                            ?.closest('main')
                            ?.getBoundingClientRect();
                        const payload = event.payload;
                        if (payload.type === 'leave') {
                            dragging = false;
                            return;
                        }
                        const ratio = window.devicePixelRatio || 1;
                        const inside =
                            !!area &&
                            payload.position.x / ratio >= area.left &&
                            payload.position.x / ratio <= area.right &&
                            payload.position.y / ratio >= area.top &&
                            payload.position.y / ratio <= area.bottom;
                        if (payload.type === 'drop') {
                            dragging = false;
                            if (inside && payload.paths.length)
                                void addPaths(payload.paths);
                        } else dragging = inside;
                    },
                );
                if (gone) stop();
                else off = stop;
            },
        );
        return () => {
            gone = true;
            off?.();
        };
    });

    /** Restores every part carried by Copy all through the same attachment queues used by keyboard paste. */
    function restoreClip(clip: NonNullable<ReturnType<typeof clipFromPaste>>) {
        if (isMarkdownText(clip.text)) attachMarkdown(clip.text, sessionId);
        else {
            const range = caret();
            setDraft(
                `${draft.slice(0, range.start)}${clip.text}${draft.slice(range.end)}`,
            );
        }
        if (clip.images.length)
            setImages([
                ...images,
                ...clip.images.map((item) => ({
                    ...item,
                    id: crypto.randomUUID(),
                })),
            ]);
        if (clip.elements.length)
            draftElements[sessionId] = [
                ...elements,
                ...clip.elements.map((item) => ({
                    ...item,
                    id: crypto.randomUUID(),
                })),
            ];
        if (clip.files.length)
            setFiles([
                ...attached,
                ...clip.files.map((item) => ({
                    ...item,
                    id: crypto.randomUUID(),
                })),
            ]);
    }

    async function onMenuPaste(payload: {
        html: string;
        text: string;
        files: File[];
    }): Promise<boolean> {
        const clip = clipFromContents(payload.html, payload.text);
        if (clip) {
            restoreClip(clip);
            return true;
        }
        if (payload.files.length) {
            await addFiles(payload.files);
            return true;
        }
        return false;
    }

    function onPaste(event: ClipboardEvent) {
        // Pasting what "Copy all" copied from a message brings back its text, pictures, notes and files.
        const clip = clipFromPaste(event.clipboardData);
        if (clip) {
            event.preventDefault();
            restoreClip(clip);
            return;
        }
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (routePastedText(text)) event.preventDefault();
            else {
                event.preventDefault();
                const range = caret();
                if (!area) return;
                replaceEditorRange(area, range.start, range.end, text);
                setDraft(editorText(area));
                resize();
            }
            return;
        }
        event.preventDefault();
        void addFiles(files);
    }

    function onDrop(event: DragEvent) {
        dragging = false;
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return;
        event.preventDefault();
        void addFiles(files);
    }

    const voiceRanges: Record<string, ReturnType<typeof caret>> = {};
    const voiceTooltip = $derived(
        voice.phase === 'recording'
            ? 'Stop dictation'
            : voice.phase === 'transcribing'
              ? voice.modelProgress > 0
                  ? `Downloading speech model ${Math.round(voice.modelProgress * 100)}%`
                  : 'Transcribing locally…'
              : 'Voice input',
    );

    function insertTranscript(
        value: string,
        selection: { start: number; end: number },
        text: string,
    ) {
        const start = Math.min(selection.start, value.length);
        const end = Math.min(Math.max(start, selection.end), value.length);
        const before = start > 0 && !/\s/.test(value[start - 1]) ? ' ' : '';
        const after = end < value.length && !/\s/.test(value[end]) ? ' ' : '';
        const insert = `${before}${text}${after}`;
        return {
            value: `${value.slice(0, start)}${insert}${value.slice(end)}`,
            caret: start + insert.length,
        };
    }

    async function toggleVoice() {
        const originId = sessionId;
        const capture = voiceOf(originId);
        if (capture.phase === 'transcribing') return;
        try {
            if (capture.phase === 'recording') {
                const source = drafts[originId] ?? '';
                const selection = voiceRanges[originId] ?? {
                    start: source.length,
                    end: source.length,
                };
                const text = await capture.stop();
                if (!text) {
                    if (text === '') toast.info('No speech was recognized');
                    return;
                }
                const result = insertTranscript(
                    drafts[originId] ?? '',
                    selection,
                    text,
                );
                setDraftFor(originId, result.value);
                if (sessionId === originId) {
                    requestAnimationFrame(() => {
                        if (sessionId !== originId || !area) return;
                        setEditorSelection(area, result.caret);
                        area.focus();
                        resize();
                    });
                }
            } else if (capture.phase === 'idle') {
                voiceRanges[originId] = caret();
                await capture.start();
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            if (capture.phase !== 'recording') delete voiceRanges[originId];
        }
    }

    function submit(whileRunning: 'queue' | 'next' | 'interrupt' = 'queue') {
        if (!hasInput) return;
        // `/btw` asks a side question in its own chat: this chat's run and queue are not touched.
        const question = btwQuestionOf(draft);
        if (question !== null) {
            if (question) {
                const asked = askBtw(sessionId, question);
                if (!asked.ok) toast.error(asked.error);
            }
            setDraft('', { sent: true });
            setMentions([]);
            setImages([]);
            setFiles([]);
            return;
        }
        delete manuallyStopped[sessionId];
        sendMessage(draft, images, elements, mentions, whileRunning, attached);
        draftElements[sessionId] = [];
        detail = null;
        setDraft('', { sent: true });
        setMentions([]);
        setImages([]);
        setFiles([]);
    }

    function onKeydown(event: KeyboardEvent) {
        // An open picker takes the arrows, Enter, Tab and Escape.
        if (trigger && picker?.key(event)) {
            if (event.key === 'Escape')
                dismissed = draft.slice(0, caret().start);
            return;
        }
        if (
            historyOf(sessionId).key(event, (text) => {
                drafts[sessionId] = text;
                requestAnimationFrame(() => {
                    if (area) setEditorSelection(area, text.length);
                    resize();
                });
            })
        ) {
            return;
        } else if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            if (area) {
                const range = editorSelection(area);
                replaceEditorRange(area, range.start, range.end, '\n');
                setDraft(editorText(area));
                resize();
                scrollCaretIntoView(area);
            }
        } else if (event.key === 'Enter') {
            event.preventDefault();
            // Enter queues normally; Alt+Enter queues next; Ctrl/Cmd+Enter requests priority without cancelling older work.
            submit(
                event.altKey
                    ? 'next'
                    : event.ctrlKey || event.metaKey
                      ? 'interrupt'
                      : 'queue',
            );
        }
    }
</script>

<svelte:window bind:innerWidth={innerW} />
{#if backgroundWork.length > 0 && (waiting.length > 0 || queuePaused[sessionId])}
    <!-- Work and queue share one tray, so its sides run down to the composer like the queue's do. -->
    <div
        class="mx-2 -mb-4 overflow-hidden rounded-t-2xl border border-b-0 border-border bg-card pb-4 shadow-md"
    >
        <BackgroundTasks items={backgroundWork} {sessionId} embedded />
        <ComposerQueue
            {sessionId}
            {waiting}
            {waitingForUser}
            onedit={editQueued}
            embedded
        />
    </div>
{:else}
    {#if backgroundWork.length > 0}
        <BackgroundTasks items={backgroundWork} {sessionId} layer />
    {/if}
    {#if waiting.length > 0 || queuePaused[sessionId]}
        <ComposerQueue
            {sessionId}
            {waiting}
            {waitingForUser}
            onedit={editQueued}
        />
    {/if}
{/if}
<form
    bind:this={formEl}
    class="relative z-10 min-w-0 rounded-2xl border bg-card p-2 shadow-lg transition-shadow {dragging
        ? 'border-primary ring-2 ring-primary/40'
        : 'border-input'}"
    onsubmit={(event) => {
        event.preventDefault();
        submit();
    }}
    ondragover={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault();
            dragging = true;
        }
    }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
>
    {#if elements.length > 0}
        <!-- Elements picked in the browser travel with the message; click one to see what is included. -->
        <div class="mb-2 flex flex-wrap gap-1.5" aria-label="Picked elements">
            {#each elements as item (item.id)}
                <div
                    class="group/chip relative"
                    bind:this={chipAnchors[item.id]}
                >
                    <button
                        type="button"
                        class="flex h-8 max-w-60 cursor-pointer items-center gap-1.5 rounded-md border px-2 font-mono text-[0.6875rem] outline-none {detail ===
                        item.id
                            ? `${TRIGGER_ON} border-primary/60 ring-1 ring-primary/60`
                            : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}"
                        aria-label="Details of {item.selector}"
                        aria-expanded={detail === item.id}
                        onclick={() =>
                            (detail = detail === item.id ? null : item.id)}
                    >
                        <ZIcon
                            zType={'lucideMousePointerClick' as ZIconName}
                            class="size-3.5 shrink-0 text-primary"
                        />
                        {#if item.picture}<img
                                src={item.picture}
                                alt=""
                                class="size-5 shrink-0 rounded-sm border border-border object-cover"
                            />{/if}
                        <span class="truncate"
                            >&lt;{item.tag} /&gt; {item.text}</span
                        >
                    </button>
                    <button
                        type="button"
                        class="absolute -top-3 -right-2.5 flex size-5.5 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-popover-foreground shadow-md opacity-0 transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100"
                        aria-label="Remove element"
                        onclick={() =>
                            (draftElements[sessionId] = elements.filter(
                                (entry) => entry !== item,
                            ))}
                    >
                        <ZIcon
                            zType="lucideX"
                            zSize="12"
                            class="block size-[12px]! shrink-0"
                        />
                    </button>
                </div>
            {/each}
        </div>
        {#each elements.filter((item) => item.id === lastDetail) as item (item.id)}
            <ZPopover
                anchor={chipAnchors[item.id]}
                open={detail === item.id}
                zTrigger="manual"
                zPosition="top-left"
                zOffset={8}
                zWidth={360}
                onClose={() => (detail = null)}
            >
                <ElementCard
                    tag={item.tag}
                    text={item.text}
                    selector={item.selector}
                    url={item.url}
                    note={item.note}
                    box={item.box}
                    style={item.style}
                    picture={item.picture}
                />
            </ZPopover>
        {/each}
    {/if}
    <ComposerChips {images} {attached} {setImages} {setFiles} />

    <div class="relative min-w-0">
        <div
            bind:this={area}
            contenteditable="true"
            role="textbox"
            tabindex="0"
            aria-multiline="true"
            data-composer-editor
            oninput={() => {
                if (!area) return;
                setDraft(editorText(area));
                resize();
                detectTrigger();
            }}
            onscroll={resize}
            onkeyup={(event) =>
                (event.key === 'ArrowLeft' ||
                    event.key === 'ArrowRight' ||
                    event.key === 'Home' ||
                    event.key === 'End') &&
                detectTrigger()}
            onclick={detectTrigger}
            onblur={() => (trigger = null)}
            onkeydown={onKeydown}
            onpaste={onPaste}
            oncontextmenu={onTextAreaContextMenu}
            aria-label="Message"
            data-placeholder={waitingForUser
                ? 'Answer the pending request…'
                : willQueue
                  ? `Enter queues · Alt+Enter queues next · ${mac ? '⌘' : 'Ctrl'}+Enter sends now`
                  : 'Do anything…'}
            class="composer-editor relative max-h-45 min-h-[50px] w-[calc(100%+0.5rem)] overflow-x-hidden break-words border-0 bg-transparent pt-0 pr-3 pb-1 pl-0.5 text-sm leading-normal text-foreground caret-foreground selection:bg-primary/25 outline-none"
        ></div>
    </div>
    <TextEditContextMenu
        bind:this={textEditMenu}
        onPasteText={routePastedText}
        onPasteClipboard={onMenuPaste}
    />

    <div class="flex min-w-0 items-center justify-between gap-2">
        <div class="flex min-w-0 flex-1 items-center gap-1">
            <ZButton
                zWave={false}
                zType="ghost"
                zSize="sm"
                class="size-7! !bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary"
                aria-label="Attach files"
                title="Attach files (or paste / drop)"
                onclick={() => fileInput?.click()}
            >
                <ZIcon zType="lucidePaperclip" class="size-3.5" />
            </ZButton>
            <ZButton
                bind:ref={promptHistoryAnchor}
                zWave={false}
                zType="ghost"
                zSize="sm"
                class="size-7! !bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary {promptHistoryOpen
                    ? `${TRIGGER_ON} !bg-primary/15 !text-primary`
                    : ''}"
                aria-label="Show prompt history"
                title={promptHistory.length
                    ? `Prompt history (${promptHistory.length})`
                    : 'Prompt history'}
                aria-haspopup="listbox"
                aria-expanded={promptHistoryOpen}
                onclick={() => {
                    promptHistoryVersion++;
                    promptHistoryOpen = !promptHistoryOpen;
                }}
            >
                <ZIcon zType="lucideHistory" class="size-3.5" />
                {#if promptHistory.length > 0}
                    <span
                        class="pointer-events-none absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-[8px] leading-3.5 text-primary-foreground"
                        >{promptHistory.length > 99
                            ? '99+'
                            : promptHistory.length}</span
                    >
                {/if}
            </ZButton>
            <input
                bind:this={fileInput}
                type="file"
                multiple
                hidden
                onchange={(event) => {
                    void addFiles([...(event.currentTarget.files ?? [])]);
                    event.currentTarget.value = '';
                }}
            />
            <ModelPicker
                bind:agent
                bind:model
                bind:effort
                bind:fast
                bind:permission
            />
            <PickerPopover
                anchor={promptHistoryAnchor}
                bind:open={promptHistoryOpen}
                items={promptHistoryItems}
                search
                local
                fitContent
                headings={false}
                size="sm"
                width={360}
                label="Prompt history"
                placeholder="Search prompt history…"
                empty="No saved prompts"
                onpick={choosePromptHistory}
            />
        </div>
        <!-- Composer and workers share a control whose icons never enter the flex layout. -->
        {#if contextTokens > 0}
            <ZButton
                bind:ref={contextAnchor}
                zWave={false}
                type="button"
                zType="ghost"
                zSize="sm"
                class="relative size-7! shrink-0 rounded-full p-0! {contextOpen
                    ? 'bg-primary/15! text-primary!'
                    : `${contextTone} hover:bg-accent/50`}"
                aria-label="Show context usage"
                aria-expanded={contextOpen}
                onclick={() => (contextOpen = !contextOpen)}
            >
                <svg
                    class="size-3.5 shrink-0 -rotate-90"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                >
                    <circle
                        cx="10"
                        cy="10"
                        r="7.5"
                        stroke="currentColor"
                        stroke-opacity="0.18"
                        stroke-width="2"
                    />
                    <circle
                        cx="10"
                        cy="10"
                        r="7.5"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-dasharray="50.27"
                        stroke-dashoffset={50.27 -
                            (50.27 * contextPercent) / 100}
                    />
                </svg>
            </ZButton>
            <ZPopover
                anchor={contextAnchor}
                bind:open={contextOpen}
                zTrigger="manual"
                zPosition="top-right"
                zOffset={8}
                zWidth={220}
            >
                <div class="flex flex-col gap-2 p-3">
                    <div class="flex items-center justify-between gap-4">
                        <span class="text-xs font-medium text-foreground"
                            >Context usage</span
                        >
                        <span
                            class="text-[0.6875rem] tabular-nums text-muted-foreground"
                            >{contextPercent}%</span
                        >
                    </div>
                    <ZProgress
                        zValue={contextPercent}
                        zMax={100}
                        zSize="xs"
                        zColor={contextPercent >= 90
                            ? 'destructive'
                            : contextPercent >= 75
                              ? 'warning'
                              : 'primary'}
                        zLabel="Context usage"
                    />
                    <div
                        class="flex items-center justify-between gap-3 text-[0.6875rem] text-muted-foreground"
                    >
                        <span
                            >{shortCount(
                                contextTokens >= contextLimit
                                    ? contextLimit
                                    : contextTokens,
                            )}{contextTokens >= contextLimit ? '+' : ''} tokens</span
                        >
                        <span>limit {shortCount(contextLimit)}</span>
                    </div>
                    <div class="mt-1 border-t border-border/60 pt-2">
                        <div
                            class="mb-1 flex items-center justify-between gap-3 text-[0.6875rem]"
                        >
                            <span class="font-medium text-foreground"
                                >Selected limit</span
                            >
                            <span class="tabular-nums text-muted-foreground"
                                >{shortCount(contextLimit)} tokens</span
                            >
                        </div>
                        <ZSlider
                            value={contextLimitIndex}
                            zMin={0}
                            zMax={CONTEXT_LIMITS.length - 1}
                            zStep={1}
                            zSize="sm"
                            zMarks={CONTEXT_LIMITS.map((limit, index) => ({
                                value: index,
                                label: shortCount(limit),
                            }))}
                            zFormatter={(value) =>
                                `${shortCount(CONTEXT_LIMITS[value] ?? contextLimit)} tokens`}
                            zLabel="Auto-compress at"
                            onValueChange={(value) =>
                                setSessionContextLimit(
                                    sessionId,
                                    CONTEXT_LIMITS[value] ?? contextLimit,
                                )}
                        />
                    </div>
                    <p
                        class="text-[0.6875rem] leading-snug text-muted-foreground"
                    >
                        {contextPercent >= 100
                            ? 'Auto-compress will run before the next queued message.'
                            : 'Auto-compress runs when the context reaches the limit.'}
                    </p>
                </div>
            </ZPopover>
        {/if}
        <span
            class="inline-grid h-7 shrink-0 place-items-center {voice.phase ===
            'recording'
                ? 'w-fit'
                : 'w-7'}"
            {@attach zTooltip({ content: voiceTooltip, position: 'top' })}
        >
            <ZButton
                zWave={false}
                type="button"
                zType="ghost"
                zSize="sm"
                class="h-7! shrink-0 gap-2 rounded-full {voice.phase ===
                'recording'
                    ? 'w-fit! bg-muted/80 px-2.5! text-foreground hover:bg-muted ring-1 ring-border/50'
                    : voice.phase === 'transcribing'
                      ? 'size-7! p-0! cursor-wait text-muted-foreground bg-muted/80 ring-1 ring-border/50'
                      : 'size-7! p-0! text-muted-foreground hover:bg-accent/50'}"
                aria-label={voice.phase === 'recording'
                    ? 'Stop dictation'
                    : voice.phase === 'transcribing'
                      ? voiceTooltip
                      : 'Start voice input'}
                aria-pressed={voice.phase === 'recording'}
                aria-busy={voice.phase === 'transcribing'}
                onclick={() => void toggleVoice()}
            >
                {#if voice.phase === 'recording'}
                    <span class="voice-wave" aria-hidden="true">
                        {#each voice.levels as lvl, index (index)}
                            <span style:height="{Math.max(3, 3 + lvl * 11)}px"
                            ></span>
                        {/each}
                    </span>
                    <span
                        class="size-2.5 rounded-[1.5px] bg-foreground shrink-0"
                        aria-hidden="true"
                    ></span>
                {:else if voice.phase === 'transcribing'}
                    <ZIcon
                        zType={'lucideLoaderCircle' as ZIconName}
                        zSize="14"
                        class="size-[14px]! animate-spin"
                    />
                {:else}
                    <ZIcon
                        zType={'lucideAudioLines' as ZIconName}
                        zSize="14"
                        class="size-[14px]!"
                    />
                {/if}
            </ZButton>
        </span>
        {#if running && hasInput}
            <ZButton
                zWave={false}
                type="button"
                zType="ghost"
                zSize="sm"
                class="size-7! shrink-0 rounded-full p-0 text-muted-foreground"
                aria-label="Pause current reply"
                title="Pause current reply · keep draft"
                onclick={() => stopTurnForResume(sessionId)}
            >
                <svg class="size-3" viewBox="0 0 16 16" aria-hidden="true"
                    ><rect
                        x="2.5"
                        y="2.5"
                        width="11"
                        height="11"
                        rx="2.5"
                        fill="currentColor"
                    /></svg
                >
            </ZButton>
        {/if}
        <RunActionButton
            {action}
            {spinning}
            type={action === 'send' ? 'submit' : 'button'}
            disabled={action === 'send' && !hasInput}
            label={action === 'stop'
                ? 'Pause current reply'
                : action === 'resume'
                  ? 'Resume'
                  : willQueue
                    ? 'Queue the message'
                    : 'Send message'}
            tooltip={action === 'stop'
                ? 'Working · Pause'
                : action === 'resume'
                  ? 'Resume'
                  : willQueue
                    ? `Send to queue · Alt+Enter queues next · ${mac ? '⌘' : 'Ctrl'}+Enter sends now`
                    : 'Send'}
            onclick={() => {
                if (action === 'stop') stopTurnForResume(sessionId);
                else if (action === 'resume') resumeStoppedTurn(sessionId);
            }}
        />
    </div>
</form>
<ComposerQuota {agent} {model} />
<ProjectBar />

<!-- The pickers open over the message box, left-aligned to it, and follow what is typed after `@` or `/`. One at a
     time is mounted, so `picker` is always the open one. -->
{#if slashOpen && !categoryMode}
    <PickerPopover
        bind:this={picker}
        anchor={formEl}
        open={slashOpen}
        items={slashItems}
        query={slashQuery}
        position="top-left"
        width={formEl?.clientWidth ? Math.min(formEl.clientWidth, 260) : 260}
        label="Commands and skills"
        empty="No command matches"
        footer="↑↓ navigate · ↵ use · esc close"
        onpick={pickSlash}
        onclose={() => (trigger = null)}
    />
{:else if mentionPaletteOpen}
    <PickerPopover
        bind:this={picker}
        anchor={formEl}
        open={mentionPaletteOpen}
        items={mentionItems}
        query={mentionSearch}
        position="top-left"
        width={formEl?.clientWidth ? Math.min(formEl.clientWidth, 360) : 340}
        label={categoryMode === 'session'
            ? 'Chats'
            : categoryMode === 'project'
              ? 'Projects'
              : categoryMode === 'ai'
                ? 'Models'
                : categoryMode === 'workflow'
                  ? 'Flows'
                  : 'Mention a chat, a project, a model or a flow'}
        rowHeight={34}
        empty="No matches"
        footer="@ mention · /c chat · /p project · /m model · /w flow"
        onpick={pickMention}
        onclose={() => (trigger = null)}
    />
{/if}

<style>
    .voice-wave {
        display: inline-flex;
        height: 0.875rem;
        align-items: center;
        gap: 2px;
    }
    .voice-wave span {
        width: 2px;
        border-radius: 9999px;
        background: currentColor;
        transition: height 60ms ease-out;
    }
    .composer-editor {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        overflow-y: auto;
    }
    .composer-editor:empty::before {
        content: attr(data-placeholder);
        color: var(--color-muted-foreground);
        pointer-events: none;
    }
</style>
