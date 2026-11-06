<script lang="ts">
    import { slide } from 'svelte/transition';
    import { ZIcon } from '@shival99/z-ui-svelte';
    import AgentLogo from '../ui/AgentLogo.svelte';
    import PhyllotaxisLoader from '../ui/PhyllotaxisLoader.svelte';
    import TaskStateIcon from './TaskStateIcon.svelte';
    import { ticker } from '../../app/platform/clock.svelte';
    import { showSession } from '../../app/ui/content-tabs.svelte';
    import { modelLabel } from '../../agents/models.svelte';
    import { agentDisplayName } from '../../agents/provider-registry';
    import {
        delegateRuns,
        isDelegating,
        isRunActive,
        liveStats,
        needsApproval,
        queuedCount,
        retryWorker,
        workspace,
    } from '../../chat/sessions.svelte';
    import { shortCount, totalTokens, usd } from '../../chat/runs/usage';
    import type { Block } from '../../chat/mock';
    import {
        finishWorktree,
        mergeWorkers,
    } from '../../chat/session/worktree-actions';

    // Delegated agents attached to a message, with their live state and links to their chats.
    let { blocks }: { blocks: Extract<Block, { kind: 'delegate' }>[] } =
        $props();

    // A card still "running" with nothing running behind it: the run was cut off (the page was reloaded while it ran). The
    // chat itself tells how far it got: one that has its answer is shown as answered, not as stopped.
    const settledOf = (
        block: Extract<Block, { kind: 'delegate' }>,
    ): 'queued' | 'running' | 'done' | 'failed' | 'skipped' => {
        // A queued worker is skipped if its run ended before a worker slot opened.
        if (block.state === 'queued')
            return isRunActive(blocks.map((item) => item.childId))
                ? 'queued'
                : 'skipped';
        if (block.state === 'asking') return 'running';
        if (block.state !== 'running' || isDelegating(block.childId))
            return block.state;
        const child = workspace.sessions.find(
            (item) => item.id === block.childId,
        );
        return child && (child.messageCount ?? 0) >= 2 ? 'done' : 'failed';
    };
    const done = $derived(
        blocks.filter((block) => settledOf(block) === 'done').length,
    );
    const working = $derived(
        blocks.some((block) => settledOf(block) === 'running'),
    );

    /** What a delegated chat is doing right now (its last line), read again each second while it works. */
    function lineOf(childId: string, state: string): string {
        if (state !== 'running') return '';
        void ticker.sec;
        return liveStats(childId, Date.now())?.last ?? '';
    }
    // A worker run in its own git worktree (isolation: worktree): its branch, and the two ways out of it.
    const worktreeOf = (childId: string) =>
        workspace.sessions.find((item) => item.id === childId)?.worktree;
    // A row opens in place to show the delegated agent's run details.
    let openRows = $state<Record<string, boolean>>({});
    const nodeOf = (childId: string) =>
        delegateRuns
            .find((run) => run.nodes.some((node) => node.childId === childId))
            ?.nodes.find((node) => node.childId === childId);
    const span = (ms: number) => {
        const seconds = Math.max(0, Math.round(ms / 1000));
        return seconds < 60
            ? `${seconds}s`
            : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    };
    const snippet = (text: string) => {
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat;
    };
    /** What a row shows when opened: agent, model, time, tokens, cost, tool calls and the start of its answer. */
    function detail(
        block: Extract<Block, { kind: 'delegate' }>,
        settled: string,
    ) {
        void ticker.sec;
        const node = nodeOf(block.childId);
        const stats =
            node && node.state !== 'running'
                ? node.stats
                : liveStats(block.childId, node?.startedAt ?? Date.now());
        const ms = node
            ? (node.endedAt ?? Date.now()) - node.startedAt
            : stats?.ms;
        return {
            time:
                ms != null && settled !== 'queued' && settled !== 'skipped'
                    ? span(ms)
                    : '',
            tokens: stats?.tokens ? shortCount(totalTokens(stats.tokens)) : '',
            cost: stats?.cost != null ? usd(stats.cost) : '',
            tools: stats?.tools ?? 0,
            answer: snippet(node?.output ?? stats?.last ?? ''),
            note: block.note ?? node?.note ?? '',
        };
    }
    // The state mark of a row, drawn as in the Sub agents panel.
    const CARD_STATE = {
        queued: 'queued',
        running: 'running',
        done: 'done',
        failed: 'failed',
        skipped: 'stopped',
    } as const;
</script>

<div
    class="block-in w-full max-w-full overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]"
>
    <div
        class="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-sm"
    >
        <ZIcon zType="lucideAtSign" class="size-3.5 text-muted-foreground" />
        <span class="truncate font-medium"
            >{blocks.length === 1
                ? 'Handed to an agent'
                : `Handed to ${blocks.length} agents`}</span
        >
        <span
            class="ml-auto flex shrink-0 items-center gap-1 {working
                ? 'text-warning'
                : 'text-muted-foreground'}"
        >
            {#if working}<PhyllotaxisLoader className="text-current" />{/if}
            {done}/{blocks.length} done
        </span>
        {#if !working && blocks.filter( (block) => worktreeOf(block.childId) ).length > 1}
            <button
                type="button"
                class="shrink-0 cursor-pointer px-2 text-xs text-muted-foreground outline-none transition-colors hover:text-primary"
                title="Merge every worker's branch into the project, in the order they started, then remove their worktrees"
                onclick={() =>
                    mergeWorkers(blocks.map((block) => block.childId))}
                >Merge all</button
            >
        {/if}
    </div>
    <div>
        {#each blocks as block, i (block.childId)}
            {@const settled = settledOf(block)}
            {@const jumpable = settled !== 'queued' && settled !== 'skipped'}
            {@const expanded = openRows[block.childId] ?? false}
            {@const wt = worktreeOf(block.childId)}
            {@const info = detail(block, settled)}
            <div
                class="group/row flex w-full items-stretch transition-colors hover:bg-muted/60 {i >
                0
                    ? 'border-t border-border'
                    : ''} {settled === 'queued' || settled === 'skipped'
                    ? 'opacity-70'
                    : ''}"
            >
                <button
                    type="button"
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pr-1 pl-3 text-left text-sm outline-none"
                    aria-expanded={expanded}
                    aria-label="Details of {block.agent}"
                    onclick={() => (openRows[block.childId] = !expanded)}
                >
                    <span class="flex shrink-0">
                        <TaskStateIcon state={CARD_STATE[settled]} />
                    </span>
                    <AgentLogo
                        agent={block.agent}
                        model={block.model}
                        class="size-3.5 shrink-0"
                    />
                    <span class="shrink-0 font-medium"
                        >{agentDisplayName(block.agent, block.model)}</span
                    >
                    {#if wt}<span
                            class="shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                            title={wt.path}>{wt.branch}</span
                        >{/if}
                    <span
                        class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                        >{lineOf(block.childId, settled) ||
                            modelLabel(block.model)}{#if info.time}
                            — {info.time}{/if}</span
                    >
                    {#if settled === 'skipped'}
                        <span
                            class="max-w-32 shrink-0 truncate text-xs text-muted-foreground"
                            >{block.note ?? 'Not run'}</span
                        >
                    {:else if settled === 'failed'}
                        <span
                            class="max-w-32 shrink-0 truncate text-xs text-destructive"
                            >{block.note ?? 'Interrupted'}</span
                        >
                    {/if}
                    {#if needsApproval(block.childId)}<span
                            class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning"
                            >Needs approval</span
                        >{/if}
                    {#if queuedCount(block.childId) > 0}<span
                            class="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                            title="Messages waiting in this worker's chat"
                            >{queuedCount(block.childId)} waiting</span
                        >{/if}
                </button>
                {#if wt}
                    <button
                        type="button"
                        class="shrink-0 cursor-pointer px-2 text-xs text-muted-foreground outline-none transition-colors hover:text-primary disabled:opacity-40"
                        disabled={settled === 'running' || settled === 'queued'}
                        title="Merge this worker's branch into the project and remove its worktree"
                        onclick={() => finishWorktree(block.childId, true)}
                        >Merge</button
                    >
                    <button
                        type="button"
                        class="shrink-0 cursor-pointer px-2 text-xs text-muted-foreground outline-none transition-colors hover:text-destructive disabled:opacity-40"
                        disabled={settled === 'running' || settled === 'queued'}
                        title="Discard this worker's worktree and branch"
                        onclick={() => finishWorktree(block.childId, false)}
                        >Discard</button
                    >
                {/if}
                {#if settled === 'failed'}
                    <button
                        type="button"
                        class="grid w-8 shrink-0 cursor-pointer place-items-center text-muted-foreground outline-none transition-colors hover:text-primary"
                        aria-label="Retry {block.agent}"
                        title="Send the task to this worker again"
                        onclick={() => retryWorker(block.childId)}
                    >
                        <ZIcon zType="lucideRotateCw" class="size-3.5" />
                    </button>
                {/if}
                <button
                    type="button"
                    class="grid w-9 shrink-0 place-items-center text-muted-foreground outline-none transition-colors hover:text-primary group-hover/row:text-foreground {jumpable
                        ? 'cursor-pointer'
                        : 'cursor-default opacity-40'}"
                    disabled={!jumpable}
                    aria-label="Open the chat of {block.agent}"
                    title="Open this agent's chat"
                    onclick={() => jumpable && showSession(block.childId)}
                >
                    <ZIcon zType="lucideChevronRight" class="size-3.5" />
                </button>
            </div>
            {#if expanded}
                <div
                    transition:slide={{ duration: 300 }}
                    class="flex flex-col gap-1.5 bg-muted/20 px-3 py-2 text-xs"
                >
                    <div
                        class="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground tabular-nums"
                    >
                        <span
                            ><span class="text-foreground"
                                >{agentDisplayName(
                                    block.agent,
                                    block.model,
                                )}</span
                            >
                            > · {modelLabel(block.model)}{#if info.time}
                                — {info.time}{/if}</span
                        >
                        {#if info.time}<span
                                class="inline-flex items-center gap-1"
                                ><ZIcon
                                    zType="lucideClock"
                                    class="size-3"
                                /></span
                            >{/if}
                        {#if info.tokens}<span
                                class="inline-flex items-center gap-1"
                                ><ZIcon
                                    zType="lucideDatabase"
                                    class="size-3"
                                />{info.tokens}</span
                            >{/if}
                        {#if info.cost}<span
                                class="inline-flex items-center gap-1"
                                ><ZIcon
                                    zType="lucideCoins"
                                    class="size-3"
                                />{info.cost}</span
                            >{/if}
                        {#if info.tools > 0}<span
                                class="inline-flex items-center gap-1"
                                ><ZIcon
                                    zType="lucideTerminal"
                                    class="size-3"
                                />{info.tools} tool calls</span
                            >{/if}
                    </div>
                    {#if info.answer || info.note}<p
                            class="m-0 leading-snug break-words text-muted-foreground"
                        >
                            {info.answer || info.note}
                        </p>{:else}<p
                            class="m-0 text-muted-foreground/70 italic"
                        >
                            No output yet
                        </p>{/if}
                </div>
            {/if}
        {/each}
    </div>
</div>
