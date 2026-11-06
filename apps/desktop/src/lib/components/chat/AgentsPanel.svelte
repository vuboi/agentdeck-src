<script lang="ts">
    import { ZIcon } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
    import { modelLabel } from '../../agents/models.svelte';
    import AgentLogo from '../ui/AgentLogo.svelte';
    import PickerPopover, { type PickerItem } from '../ui/PickerPopover.svelte';
    import TaskStateIcon from '../tasks/TaskStateIcon.svelte';
    import { TRIGGER_ON } from '../../app/ui/popover';
    import { ticker } from '../../app/platform/clock.svelte';
    import { elapsed } from '../../chat/content/blocks';
    import type { Agent } from '../../chat/sessions.svelte';
    import SideChat from './SideChat.svelte';
    import Composer from './Composer.svelte';
    import { workspace } from '../../chat/sessions.svelte';
    import {
        agentView,
        childAgents,
        GRID_MAX,
        toggleGridAgent,
    } from '../../chat/runs/child-agents.svelte';
    import type { ChildAgent } from '../../chat/runs/child-agents';
    import { isWorkActive, stopTarget } from '../../chat/runs/chat-work';
    import { stopWork } from '../../chat/session/work.svelte';
    import { notifyRun } from '../../chat/runs/notices.svelte';
    import { workerUpdatedNotice } from '../../chat/runs/notices';
    import { sendMessage } from '../../chat/session/sending.svelte';
    import type { CardState } from '../../tasks/delegate-task';

    // Sub agents of the open chat beside it: a list, one agent's chat, or a grid of up to four chats.
    const agents = $derived(
        childAgents(workspace.activeId).filter(
            (agent) =>
                isWorkActive(agent.work) ||
                !agentView.dismissed.includes(agent.id),
        ),
    );
    const selected = $derived(
        agents.find((agent) => agent.id === agentView.selected) ?? null,
    );
    const running = $derived(
        agents.filter((agent) => isWorkActive(agent.work)),
    );
    const finished = $derived(
        agents.filter((agent) => !isWorkActive(agent.work)),
    );
    // The grid shows the ones ticked in its picker (running or finished), else every agent, running first, up to
    // GRID_MAX. A finished agent stays until it is removed, so its reply can still be read.
    const gridAgents = $derived.by(() => {
        const picked = agents.filter((agent) =>
            agentView.picked.includes(agent.id),
        );
        return picked.length
            ? picked
            : [...running, ...finished].slice(0, GRID_MAX);
    });
    const gridIds = $derived(gridAgents.map((agent) => agent.id));
    // Each group folds away under its heading, like the days of the Tasks view.
    const folded = $state({ running: false, finished: false });
    // A single view with no agent to show falls back to the list.
    const mode = $derived(
        agentView.mode === 'single' && !selected ? 'list' : agentView.mode,
    );

    const ICON_BUTTON =
        'grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-primary/10 hover:text-primary';
    const ICON_ON = '!bg-primary/15 !text-primary';
    // The stop button of the delegated work cards.
    const STOP_BUTTON =
        'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/60';

    // The state mark of the delegated work cards, by the tray's state.
    const CARD_STATE: Record<ChildAgent['state'], CardState> = {
        queued: 'queued',
        running: 'running',
        paused: 'paused',
        waiting: 'waiting',
        input: 'approval',
        done: 'done',
        failed: 'failed',
        stopped: 'stopped',
        unknown: 'waiting',
    };
    const STATE_LABEL: Record<ChildAgent['state'], string> = {
        queued: 'Queued',
        running: 'Running',
        paused: 'Paused',
        waiting: 'Waiting',
        input: 'Needs input',
        done: 'Done',
        failed: 'Failed',
        stopped: 'Stopped',
        unknown: 'Unknown',
    };

    /** How long it ran: counts up while it runs; a finished one with no end time shows none. */
    function took(agent: ChildAgent): string {
        void ticker.sec;
        const active = isWorkActive(agent.work);
        if (!active && agent.endedAt === undefined) return '';
        return elapsed(
            (active ? Date.now() : agent.endedAt!) - agent.startedAt,
        );
    }
    const stoppable = (agent: ChildAgent) => stopTarget(agent.work) !== null;

    // The grid's own picker: tick the agents to show, without going back to the list. It stays open while ticking.
    let pickerOpen = $state(false);
    let pickerAnchor: HTMLElement | null = $state(null);
    const pickerItems = $derived<PickerItem<string>[]>(
        [...running, ...finished].map((agent) => {
            const on = gridIds.includes(agent.id);
            return {
                id: agent.id,
                label: agent.title,
                hint: agent.model ? modelLabel(agent.model) : undefined,
                agent: (agent.agent ?? undefined) as Agent | undefined,
                selected: on,
                disabled: !on && gridIds.length >= GRID_MAX,
                data: agent.id,
            };
        }),
    );

    // A message to a delegated worker reaches its parent as one line, so the parent waits for the report instead of
    // starting the work again; the message itself stays in the worker's chat.
    function tellParent(agent: ChildAgent) {
        if (!agent.work.delegateId) return;
        void notifyRun(
            agent.parentId,
            workerUpdatedNotice(agent.title),
            'worker-updated',
        );
    }

    function open(id: string) {
        agentView.selected = id;
        agentView.back = mode === 'grid' ? 'grid' : 'list';
        agentView.mode = 'single';
    }

    // The grid cells' own boxes: a message to a worker's chat goes straight there, as the side view's box does.
    const drafts = $state<Record<string, string>>({});
    function ask(agent: ChildAgent) {
        if (agent.source.type !== 'session') return;
        const sessionId = agent.source.sessionId;
        const text = (drafts[sessionId] ?? '').trim();
        if (!text) return;
        sendMessage(text, [], [], [], 'queue', [], sessionId);
        drafts[sessionId] = '';
        tellParent(agent);
    }

    // Clears the panel of the finished agents; the running ones stay.
    function clearFinished() {
        agentView.dismissed = [
            ...agentView.dismissed,
            ...finished.map((agent) => agent.id),
        ];
    }
</script>

{#snippet name(agent: ChildAgent)}
    <span class="flex shrink-0" title={STATE_LABEL[agent.state]}>
        <TaskStateIcon state={CARD_STATE[agent.state]} />
    </span>
    {#if agent.agent}
        <AgentLogo
            agent={agent.agent}
            model={agent.model}
            class="size-3.5 shrink-0"
        />
    {/if}
    <!-- The title keeps room first; the model gives way (truncates) when the panel is narrow. -->
    <span class="min-w-24 flex-1 truncate font-medium text-foreground"
        >{agent.title}</span
    >
    {#if agent.model}
        <span
            class="min-w-0 max-w-32 shrink truncate text-xs text-muted-foreground"
            >{modelLabel(agent.model)}</span
        >
    {/if}
    {#if took(agent)}
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground"
            >{took(agent)}</span
        >
    {/if}
{/snippet}

{#snippet stop(agent: ChildAgent)}
    {#if stoppable(agent)}
        <button
            type="button"
            class={STOP_BUTTON}
            aria-label="Stop {agent.title}"
            title="Stop"
            onclick={() => stopWork(agent.work)}
        >
            <svg class="size-3.5" viewBox="0 0 16 16" aria-hidden="true"
                ><rect
                    x="2.5"
                    y="2.5"
                    width="11"
                    height="11"
                    rx="2.5"
                    fill="currentColor"
                /></svg
            >
        </button>
    {/if}
{/snippet}

<section class="flex h-full min-h-0 flex-col bg-background text-sm">
    <header
        class="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-3 pr-2"
    >
        {#if mode === 'single' && selected}
            <button
                type="button"
                class={ICON_BUTTON}
                aria-label="Back to sub agents"
                title="Back to sub agents"
                onclick={() => (agentView.mode = agentView.back)}
            >
                <ZIcon
                    zType={'lucideArrowLeft' as ZIconName}
                    class="size-3.5"
                />
            </button>
            <div class="flex min-w-0 flex-1 items-center gap-2">
                {@render name(selected)}
            </div>
            {@render stop(selected)}
        {:else}
            <span class="min-w-0 flex-1 truncate font-medium text-foreground"
                >Sub agents</span
            >
        {/if}
        {#if mode === 'grid'}
            <button
                type="button"
                bind:this={pickerAnchor}
                class="{ICON_BUTTON} {pickerOpen ? TRIGGER_ON : ''}"
                aria-label="Choose agents for the grid"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                title="Choose agents (up to {GRID_MAX})"
                onclick={() => (pickerOpen = !pickerOpen)}
            >
                <ZIcon
                    zType={'lucideListChecks' as ZIconName}
                    class="size-3.5"
                />
            </button>
            <PickerPopover
                anchor={pickerAnchor}
                bind:open={pickerOpen}
                items={pickerItems}
                local
                multiple
                size="sm"
                fitContent
                maxHeight={240}
                position="bottom-right"
                width={280}
                tooltip="left"
                label="Agents in the grid"
                empty="No sub agents"
                emptyIcon={'lucideInbox' as ZIconName}
                footer="Up to {GRID_MAX} at once"
                onpick={(item) => toggleGridAgent(item.data, gridIds)}
            />
        {/if}
        {#if mode !== 'single' && finished.length}
            <button
                type="button"
                class={ICON_BUTTON}
                aria-label="Clear finished agents"
                title="Clear finished agents"
                onclick={clearFinished}
            >
                <ZIcon zType={'lucideListX' as ZIconName} class="size-3.5" />
            </button>
        {/if}
        <button
            type="button"
            class="{ICON_BUTTON} {mode === 'grid' ? ICON_ON : ''}"
            aria-label={mode === 'grid' ? 'Show the list' : 'Show the grid'}
            aria-pressed={mode === 'grid'}
            title={mode === 'grid' ? 'Show the list' : 'Show the grid'}
            onclick={() => (agentView.mode = mode === 'grid' ? 'list' : 'grid')}
        >
            <!-- The icon is the layout a click switches to. -->
            <ZIcon
                zType={(mode === 'grid'
                    ? 'lucideLayoutList'
                    : 'lucideLayoutGrid') as ZIconName}
                class="size-3.5"
            />
        </button>
    </header>

    {#if mode === 'single' && selected}
        <SideChat agent={selected} />
        <!-- A worker with a chat of its own (a delegated task, a fork) takes messages here, so a change of plan reaches it
             without going through the main chat. A native sub agent has no chat to write to. -->
        {#if selected.source.type === 'session'}
            <div class="shrink-0 px-2 pb-2">
                <Composer
                    sessionId={selected.source.sessionId}
                    compact
                    onsent={() => tellParent(selected)}
                />
            </div>
        {/if}
    {:else if mode === 'grid'}
        {#if gridAgents.length}
            <!-- Up to four cells share the height; more scroll, each keeping a readable height. -->
            <div
                class="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2 {gridAgents.length >
                4
                    ? 'auto-rows-64'
                    : 'auto-rows-fr'} {gridAgents.length > 1
                    ? 'grid-cols-2'
                    : 'grid-cols-1'}"
            >
                {#each gridAgents as agent (agent.id)}
                    <div
                        class="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-[var(--shadow-card)]"
                    >
                        <div
                            class="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2"
                        >
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
                                title="Open"
                                onclick={() => open(agent.id)}
                            >
                                {@render name(agent)}
                            </button>
                            {@render stop(agent)}
                            <button
                                type="button"
                                class={ICON_BUTTON}
                                aria-label="Remove from grid"
                                title="Remove from grid"
                                onclick={() =>
                                    toggleGridAgent(agent.id, gridIds)}
                            >
                                <ZIcon
                                    zType={'lucideX' as ZIconName}
                                    class="size-3"
                                />
                            </button>
                        </div>
                        <SideChat {agent} />
                        {#if agent.source.type === 'session'}
                            <form
                                class="shrink-0 p-2"
                                onsubmit={(event) => {
                                    event.preventDefault();
                                    ask(agent);
                                }}
                            >
                                <div
                                    class="flex items-center gap-1 rounded-md border border-border bg-background pl-2 pr-1 focus-within:border-primary"
                                >
                                    <input
                                        class="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                                        placeholder="Message {agent.title}"
                                        aria-label="Message {agent.title}"
                                        value={drafts[agent.source.sessionId] ??
                                            ''}
                                        oninput={(event) => {
                                            if (agent.source.type === 'session')
                                                drafts[agent.source.sessionId] =
                                                    event.currentTarget.value;
                                        }}
                                    />
                                    <button
                                        type="submit"
                                        class={ICON_BUTTON}
                                        aria-label="Send"
                                        title="Send"
                                        disabled={!drafts[
                                            agent.source.sessionId
                                        ]?.trim()}
                                    >
                                        <ZIcon
                                            zType={'lucideArrowUp' as ZIconName}
                                            class="size-3.5"
                                        />
                                    </button>
                                </div>
                            </form>
                        {/if}
                    </div>
                {/each}
            </div>
        {:else}
            <div
                class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
            >
                <ZIcon
                    zType={'lucideLayoutGrid' as ZIconName}
                    zSize="28"
                    class="size-7 opacity-60"
                />
                <h2 class="text-sm font-medium text-foreground">
                    No sub agents
                </h2>
                <p class="m-0 max-w-60 text-sm leading-normal">
                    Sub agents of this chat appear here; the grid shows up to {GRID_MAX}.
                </p>
            </div>
        {/if}
    {:else if agents.length}
        <div class="min-h-0 flex-1 overflow-y-auto">
            <!-- Running always has its place, one row tall when nothing runs, as in the Tasks view. -->
            {@render heading('Running', running.length, 'running')}
            {#if !folded.running}
                {#if running.length}
                    <div class="p-1">
                        {#each running as agent (agent.id)}{@render listRow(
                                agent,
                                true,
                            )}{/each}
                    </div>
                {:else}
                    <div
                        class="flex items-center justify-center gap-2 border-b border-border px-1.5 py-1.5 text-sm text-muted-foreground"
                    >
                        <ZIcon
                            zType={'lucideInbox' as ZIconName}
                            class="size-3 shrink-0"
                        />
                        <span>No sub agent running</span>
                    </div>
                {/if}
            {/if}
            {#if finished.length}
                {@render heading('Finished', finished.length, 'finished')}
                {#if !folded.finished}
                    <div class="p-1">
                        {#each finished as agent (agent.id)}{@render listRow(
                                agent,
                                true,
                            )}{/each}
                    </div>
                {/if}
            {/if}
        </div>
    {:else}
        <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
        >
            <ZIcon
                zType={'lucideBot' as ZIconName}
                zSize="28"
                class="size-7 opacity-60"
            />
            <h2 class="text-sm font-medium text-foreground">
                No sub agents or tasks
            </h2>
            <p class="m-0 max-w-60 text-sm leading-normal">
                Sub agents and background tasks of this chat appear here.
            </p>
        </div>
    {/if}
</section>

<!-- The group heading of the Tasks view; both groups fold. -->
{#snippet heading(label: string, count: number, group: 'running' | 'finished')}
    <button
        type="button"
        class="flex h-7 min-h-7 w-full shrink-0 cursor-pointer items-center gap-2 border-b border-border bg-background px-1.5 text-left text-[10px] font-medium tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground"
        aria-expanded={!folded[group]}
        onclick={() => (folded[group] = !folded[group])}
    >
        <ZIcon
            zType={'lucideChevronRight' as ZIconName}
            class="size-3 shrink-0 transition-transform duration-200 {folded[
                group
            ]
                ? ''
                : 'rotate-90'}"
        />
        <span>{label}</span>
        <span class="tabular-nums normal-case">{count}</span>
    </button>
{/snippet}

<!-- One agent of the list; any agent can join the grid. -->
{#snippet listRow(agent: ChildAgent, canGrid: boolean)}
    {@const inGrid = gridIds.includes(agent.id)}
    <!-- The divider belongs to the wrapper, with room around the row, so the hover box never touches it. -->
    <div class="border-b border-border py-1 last:border-b-0">
        <div
            class="flex items-center gap-1 rounded-md pr-1 hover:bg-primary/10"
        >
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-2.5 text-left outline-none"
                onclick={() => open(agent.id)}
            >
                {@render name(agent)}
            </button>
            {@render stop(agent)}
            {#if canGrid}
                <button
                    type="button"
                    class="{ICON_BUTTON} {inGrid ? ICON_ON : ''}"
                    aria-label={inGrid ? 'Remove from grid' : 'Add to grid'}
                    aria-pressed={inGrid}
                    title={inGrid
                        ? 'Remove from grid'
                        : `Add to grid (up to ${GRID_MAX})`}
                    onclick={() => toggleGridAgent(agent.id, gridIds)}
                >
                    <ZIcon
                        zType={(inGrid
                            ? 'lucideGrid2x2Check'
                            : 'lucideGrid2x2Plus') as ZIconName}
                        class="size-3.5"
                    />
                </button>
            {/if}
        </div>
    </div>
{/snippet}
