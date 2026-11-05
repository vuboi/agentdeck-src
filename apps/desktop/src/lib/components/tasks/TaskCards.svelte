<script lang="ts">
    import { fade, slide } from 'svelte/transition';
    import { ZIcon, ZLoading, ZShimmerText } from '@shival99/z-ui-svelte';
    import AgentLogo from '../ui/AgentLogo.svelte';
    import TaskStateIcon from './TaskStateIcon.svelte';
    import { elapsed, type CommandBlock } from '../../chat/content/blocks';
    import { ticker } from '../../app/platform/clock.svelte';
    import { LOADER, LOADER_SIZE } from '../../app/platform/loaders';
    import { showSession } from '../../app/ui/content-tabs.svelte';
    import { connectors } from '../../agents/connectors.svelte';
    import {
        cardOf,
        MAX_WORKERS,
        parseTaskResult,
        type CardState,
    } from '../../tasks/delegate-task';
    import { modelLabel } from '../../agents/models.svelte';
    import { agentDisplayName } from '../../agents/provider-registry';
    import {
        delegateTasks,
        liveStats,
        needsApproval,
        stopDelegateTask,
        workspace,
    } from '../../chat/sessions.svelte';

    let { items }: { items: CommandBlock[] } = $props();
    let open = $state<Record<string, boolean>>({});
    const key = (item: CommandBlock, index: number) => item.id ?? String(index);
    const recordOf = (item: CommandBlock) => {
        const id = item.taskId ?? parseTaskResult(item.output)?.taskId;
        return id ? delegateTasks[id] : undefined;
    };
    function nameOf(
        card: ReturnType<typeof cardOf>,
        record: ReturnType<typeof recordOf>,
    ): string {
        if (record) return record.label;
        const wanted = card.agent ?? 'an agent';
        const known = agentDisplayName(wanted.toLowerCase());
        const provider = connectors.custom.find((item) => item.id === wanted);
        const name =
            known !== wanted.toLowerCase() ? known : (provider?.name ?? wanted);
        return card.model
            ? `${name} · ${modelLabel(card.model) || card.model}`
            : name;
    }
    const kindOf = (
        card: ReturnType<typeof cardOf>,
        record: ReturnType<typeof recordOf>,
    ) => (record?.agent ?? card.agent ?? '').toLowerCase();
    const live = (state: CardState) =>
        state === 'queued' ||
        state === 'waiting' ||
        state === 'running' ||
        state === 'background' ||
        state === 'paused' ||
        state === 'approval';
    const reducedMotion =
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion = (ms: number) => (reducedMotion ? 0 : ms);
    function took(card: ReturnType<typeof cardOf>): string {
        void ticker.sec;
        if (!card.startedAt) return card.duration ?? '';
        return elapsed((card.endedAt ?? Date.now()) - card.startedAt);
    }
    function doing(card: ReturnType<typeof cardOf>): string {
        if (!live(card.state) || !card.childId) return '';
        void ticker.sec;
        return (
            liveStats(card.childId, card.startedAt ?? Date.now())?.last ?? ''
        );
    }
    const firstLine = (text?: string) =>
        (text ?? '')
            .split('\n')
            .find((line) => line.trim())
            ?.trim() ?? '';
    const finished = $derived(
        items.filter((item) => !live(cardOf(item, recordOf(item)).state))
            .length,
    );
    const failedCount = $derived(
        items.filter((item) => cardOf(item, recordOf(item)).state === 'failed')
            .length,
    );
    const activeCount = $derived(
        items.filter((item) => {
            const state = cardOf(item, recordOf(item)).state;
            return state === 'running' || state === 'background';
        }).length,
    );
    const queuedCount = $derived(
        items.filter((item) => cardOf(item, recordOf(item)).state === 'queued')
            .length,
    );
</script>

<div
    class="block-in w-full max-w-full overflow-hidden rounded-xl border border-border bg-background text-sm shadow-xs"
>
    <div
        class="flex h-9 min-w-0 items-center gap-2 border-b border-border/70 bg-muted/30 px-3 text-xs"
    >
        <span
            class="grid size-5 shrink-0 place-items-center {activeCount > 0
                ? 'text-muted-foreground'
                : 'rounded-md bg-primary/10 text-primary'}"
            aria-hidden="true"
        >
            {#if activeCount > 0}
                <ZLoading
                    zLoading
                    zSpinner={LOADER.background}
                    zSize={LOADER_SIZE}
                    zColor="current"
                />
            {:else}
                <ZIcon zType="lucideUsersRound" class="size-3.5" />
            {/if}
        </span>
        {#if activeCount > 0}
            <ZShimmerText
                class="font-medium"
                zBase="var(--muted-foreground)"
                zPeak="var(--foreground)"
                zText="Delegated work"
            />
        {:else}
            <span class="font-medium">Delegated work</span>
        {/if}
        <span
            class="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
        >
            {#if activeCount > 0}{activeCount} active ·
            {/if}{#if queuedCount > 0}{queuedCount} queued ·
            {/if}{finished - failedCount}/{items.length} complete{#if failedCount > 0}
                · {failedCount} failed{/if}
        </span>
    </div>
    <div class="py-1">
        {#each items as item, index (key(item, index))}
            {@const record = recordOf(item)}
            {@const card = cardOf(item, record)}
            {@const kind = kindOf(card, record)}
            {@const rowKey = key(item, index)}
            {@const expanded = open[rowKey] ?? false}
            {@const activity = doing(card)}
            {@const detail =
                firstLine(card.report) ||
                activity ||
                firstLine(card.task) ||
                'Waiting for the report…'}
            {@const jumpable =
                Boolean(card.childId) &&
                workspace.sessions.some((chat) => chat.id === card.childId)}
            <div
                class="group/row relative flex w-full items-start gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
            >
                <div
                    class="relative z-10 flex w-5 shrink-0 justify-center self-stretch"
                    aria-hidden="true"
                >
                    <div class="flex h-6 items-center justify-center">
                        <TaskStateIcon state={card.state} />
                    </div>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="flex h-6 min-w-0 items-center gap-2">
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                            <AgentLogo
                                agent={kind}
                                model={card.model}
                                class="size-3.5 shrink-0"
                            />
                            <span
                                class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium"
                                title={nameOf(card, record)}
                                >{nameOf(card, record)}{#if took(card)}
                                    — {took(card)}{/if}</span
                            >
                        </div>
                        <div
                            class="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap"
                        >
                            {#if live(card.state) && card.taskId}<button
                                    type="button"
                                    class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/60"
                                    aria-label="Stop the task for {nameOf(
                                        card,
                                        record,
                                    )}"
                                    title="Stop this task"
                                    onclick={() =>
                                        stopDelegateTask(card.taskId!)}
                                    ><svg
                                        class="size-3.5"
                                        viewBox="0 0 16 16"
                                        aria-hidden="true"
                                        ><rect
                                            x="2.5"
                                            y="2.5"
                                            width="11"
                                            height="11"
                                            rx="2.5"
                                            fill="currentColor"
                                        /></svg
                                    ></button
                                >{/if}
                            <button
                                type="button"
                                class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-colors hover:text-primary group-hover/row:text-foreground {jumpable
                                    ? 'cursor-pointer'
                                    : 'cursor-default opacity-40'}"
                                disabled={!jumpable}
                                aria-label="Open the chat of the agent for {nameOf(
                                    card,
                                    record,
                                )}"
                                title="Open this agent's chat"
                                onclick={() =>
                                    jumpable && showSession(card.childId!)}
                                ><ZIcon
                                    zType="lucideChevronRight"
                                    class="size-3.5"
                                /></button
                            >
                        </div>
                    </div>
                    <button
                        type="button"
                        class="mt-1 flex min-h-6 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                        aria-expanded={expanded}
                        aria-label="Details of the task for {nameOf(
                            card,
                            record,
                        )}"
                        onclick={() => (open[rowKey] = !expanded)}
                    >
                        <ZIcon
                            zType="lucideChevronRight"
                            class="size-3 shrink-0 transition-transform duration-200 {expanded
                                ? 'rotate-90'
                                : ''}"
                        />
                        <span class="min-w-0 flex-1 truncate">
                            {#key detail}
                                {#if live(card.state) && activity}
                                    <span
                                        class="block min-w-0 truncate"
                                        in:fade={{ duration: motion(140) }}
                                        out:fade={{ duration: motion(100) }}
                                    >
                                        <ZShimmerText
                                            class="block min-w-0 truncate"
                                            zBase="var(--muted-foreground)"
                                            zPeak="var(--foreground)"
                                            zText={detail}
                                        />
                                    </span>
                                {:else}
                                    <span
                                        class="block min-w-0 truncate"
                                        in:fade={{ duration: motion(140) }}
                                        out:fade={{ duration: motion(100) }}
                                        >{detail}</span
                                    >
                                {/if}
                            {/key}
                        </span>
                        {#if card.childId && needsApproval(card.childId)}<span
                                class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning"
                                >Approval</span
                            >{/if}
                    </button>
                    {#if expanded}<div
                            transition:slide={{ duration: 240 }}
                            class="mt-2 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs"
                        >
                            {#if card.task}<div>
                                    <div
                                        class="mb-0.5 font-medium text-foreground"
                                    >
                                        Task
                                    </div>
                                    <p
                                        class="m-0 max-h-40 overflow-auto leading-snug break-words whitespace-pre-wrap text-muted-foreground"
                                    >
                                        {card.task}
                                    </p>
                                </div>{/if}
                            <div>
                                <div class="mb-0.5 font-medium text-foreground">
                                    {card.state === 'done'
                                        ? 'Report'
                                        : 'Result'}
                                </div>
                                {#if card.report}<p
                                        class="m-0 max-h-72 overflow-auto leading-snug break-words whitespace-pre-wrap text-muted-foreground"
                                    >
                                        {card.report}
                                    </p>{:else if live(card.state)}<p
                                        class="m-0 text-muted-foreground/70 italic"
                                    >
                                        {card.state === 'queued'
                                            ? `Queued: at most ${MAX_WORKERS} workers run at once; it starts when one finishes.`
                                            : card.state === 'waiting'
                                              ? 'Waiting for a dependency or another agent’s answer.'
                                              : card.state === 'paused'
                                                ? 'Paused by the user. Resume it from the Work tray.'
                                                : card.state === 'background'
                                                  ? 'The report returns here when it is done.'
                                                  : 'Waiting for the report…'}
                                    </p>{:else}<p
                                        class="m-0 text-muted-foreground/70 italic"
                                    >
                                        No report
                                    </p>{/if}
                            </div>
                        </div>{/if}
                </div>
            </div>
        {/each}
    </div>
</div>
