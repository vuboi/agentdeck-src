<script lang="ts">
    import {
        answerPermission,
        answerQuestions,
        activeSession,
        chat,
        forkSession,
        isRunning,
        projectOf,
        replyBlockRendered,
        replyRendering,
        workspace,
    } from '../../chat/sessions.svelte';
    import { fly } from 'svelte/transition';
    import { cubicOut } from 'svelte/easing';
    import { runPosition } from '../../chat/content/chat-dividers';
    import { runUsage } from '../../chat/runs/run-usage';
    import {
        elapsed,
        reuseSegments,
        segments,
        type Segment,
    } from '../../chat/content/blocks';
    import { estimateCost } from '../../chat/runs/usage';
    import ArtifactCards from './ArtifactCards.svelte';
    import ChatBlock from './ChatBlock.svelte';
    import CommandGroup from './CommandGroup.svelte';
    import TurnChanges from './TurnChanges.svelte';
    import PlanCard from './PlanCard.svelte';
    import ProposalCard from './ProposalCard.svelte';
    import CanvasCard from './CanvasCard.svelte';
    import ArtifactFenceCard from './ArtifactFenceCard.svelte';
    import TaskCards from '../tasks/TaskCards.svelte';
    import AgentActivityCards from './AgentActivityCards.svelte';
    import LiveStatus from './LiveStatus.svelte';
    import MessageFooter from './MessageFooter.svelte';
    import ReplyHeader from './ReplyHeader.svelte';
    import { afterSteps, spokenRun } from './chat-helpers';
    import { isWriting, liveLine } from '../../chat/runs/live-line.svelte';
    import { LOADER } from '../../app/platform/loaders';
    import type { Message } from '../../chat/mock';

    /** `index` is the message's place in chat.messages; `questionMessageId` the reply the open question card belongs to. */
    let {
        message,
        index,
        agent,
        questionMessageId,
    }: {
        message: Message;
        index: number;
        agent: string;
        questionMessageId: string | undefined;
    } = $props();

    // The segments of the last render, so the ones a streamed delta did not change are the same objects and their groups
    // do not render again (reuseSegments). Plain variable on purpose: it is a cache, not state.
    let lastParts: Segment[] = [];
    const parts = $derived.by(() => {
        lastParts = reuseSegments(lastParts, segments(message.blocks));
        return lastParts;
    });
    // Replies of the same agent and model that follow one another share one name line, while each actual answer keeps
    // its own footer so copy, fork and read-aloud actions remain available for every completed reply.
    const place = $derived(runPosition(chat.messages, index, agent));
    const quiet = $derived(place.quiet);
    const grouped = $derived(place.grouped);
    // The numbers on the name line are the whole run's: the replies a newer message cut off are in them too.
    const usage = $derived(
        grouped || quiet
            ? undefined
            : runUsage(chat.messages, index, estimateCost),
    );
    // Live only while the chat really runs: a reply left marked live (a lost "done") shows its footer.
    const showLive = $derived(message.live && isRunning(workspace.activeId));
    // The footer (copy, fork, time) waits until the text has been written out on screen, not only until the run ends.
    const typing = $derived(
        !showLive && replyRendering(workspace.activeId, message.id),
    );
    // Any provider: text that stops growing while the turn runs is no longer being written. The agent is deciding or
    // writing its next step (most CLIs report a tool only once its input is complete), so after a short pause the line
    // says "Thinking" again instead of leaving the reply looking frozen. Providers that report the start of a tool call
    // (`text_end`) end the text at once and need no wait.
    const WRITING_PAUSE_MS = 800;
    const writtenLength = $derived.by(() => {
        const last = message.blocks.findLast(
            (block) => block.kind !== 'loading',
        );
        return last?.kind === 'response' && last.streaming
            ? last.text.length
            : -1;
    });
    let paused = $state(false);
    $effect(() => {
        paused = false;
        // Restarts with every chunk of text.
        if (!showLive || writtenLength < 0) return;
        const timer = setTimeout(() => (paused = true), WRITING_PAUSE_MS);
        return () => clearTimeout(timer);
    });
    const line = $derived.by(() => {
        if (!showLive) return null;
        const now = liveLine(message);
        if (!isWriting(now)) return now;
        return paused ? { label: 'Thinking', spinner: LOADER.thinking } : null;
    });
    // The newest group carries the line when nothing but text being written comes after it, so the line stays above
    // that text; its running step and the line take turns in the group's header.
    const liveGroup = $derived.by(() => {
        if (!line) return -1;
        const last = parts.findLastIndex((part) => part.kind === 'commands');
        if (last === -1) return -1;
        const tail = parts.slice(last + 1);
        return tail.every(
            (part) =>
                part.kind === 'block' &&
                (part.block.kind === 'loading' ||
                    (part.block.kind === 'response' && part.block.streaming)),
        )
            ? last
            : -1;
    });
    // Reasoning that streams on its own (before any step) already shows "Thinking" in its own title: the slot stays empty,
    // so the same status is not drawn twice.
    const tailThinking = $derived.by(() => {
        const last = parts.at(-1);
        return (
            last?.kind === 'block' &&
            last.block.kind === 'thinking' &&
            Boolean(last.block.streaming)
        );
    });
    // Otherwise the line has its own row in the slot under the reply.
    const slotLine = $derived(liveGroup === -1 && !tailThinking ? line : null);
</script>

{#if !quiet && !grouped}
    <ReplyHeader {message} {agent} {usage} />
{/if}
<div class="flex w-full min-w-0 flex-col gap-2">
    {#each parts as segment, position (position)}
        {#if segment.kind === 'commands'}
            <!-- The newest group of a running reply is the live line; it carries the only loader. -->
            <!-- Step lines in a row sit close together, like one list. -->
            <div
                class="{afterSteps(parts, position) ? '-mt-1.5' : ''} {parts[
                    position + 1
                ]?.kind === 'block'
                    ? '-mb-0.5'
                    : ''}"
            >
                <CommandGroup
                    items={segment.items}
                    thoughts={segment.thoughts}
                    live={false}
                    working={Boolean(message.live) &&
                        isRunning(workspace.activeId) &&
                        !parts
                            .slice(position + 1)
                            .some(
                                (part) =>
                                    part.kind === 'block' &&
                                    part.block.kind !== 'loading',
                            )}
                    status={position === liveGroup ? line : null}
                    startedAt={message.startedAt}
                    stateKey="{workspace.activeId}:{message.id}:{position}"
                />
            </div>
        {:else if segment.kind === 'plan'}
            <PlanCard items={segment.items} />
        {:else if segment.kind === 'proposal'}
            <ProposalCard item={segment.item} sessionId={workspace.activeId} />
        {:else if segment.kind === 'artifact'}
            <CanvasCard item={segment.item} sessionId={workspace.activeId} />
        {:else if segment.kind === 'artifact_fence'}
            <ArtifactFenceCard
                response={segment.response}
                fence={segment.fence}
                sessionId={workspace.activeId}
            />
        {:else if segment.kind === 'tasks'}
            <TaskCards items={segment.items} />
        {:else if segment.kind === 'agent_activity'}
            <AgentActivityCards
                items={segment.items}
                agent={message.agent ??
                    activeSession()?.source ??
                    activeSession()?.agent ??
                    'codex'}
                sessionId={activeSession()?.id}
            />
        {:else}
            <!-- The first text of a reply rises in as it appears; later streamed text only grows in place. -->
            <div
                in:fly={{
                    y: 6,
                    duration: segment.block.kind === 'response' ? 260 : 0,
                    easing: cubicOut,
                }}
            >
                <ChatBlock
                    block={segment.block}
                    running={Boolean(message.live) &&
                        isRunning(workspace.activeId)}
                    flush={chat.messages.at(-1)?.id !== message.id}
                    agent={message.agent ??
                        activeSession()?.source ??
                        activeSession()?.agent}
                    onanswer={(answer) =>
                        answerPermission(
                            message.id,
                            message.blocks.indexOf(segment.block),
                            answer,
                        )}
                    onquestions={(text) =>
                        answerQuestions(workspace.activeId, text)}
                    onrendered={segment.block.kind === 'response'
                        ? () =>
                              replyBlockRendered(
                                  workspace.activeId,
                                  message.id,
                                  message.blocks.indexOf(segment.block),
                              )
                        : undefined}
                    answered={!message.live && questionMessageId !== message.id}
                    showQuestions={false}
                />
            </div>
        {/if}
    {/each}
    <TurnChanges
        blocks={message.blocks}
        projectRoot={(activeSession() && projectOf(activeSession()!)?.path) ||
            ''}
    />
    <ArtifactCards
        blocks={message.blocks}
        root={(activeSession() && projectOf(activeSession()!)?.path) || null}
        live={Boolean(message.live) && isRunning(workspace.activeId)}
    />
    <!-- One status line for the whole reply: what the agent is doing now (thinking, running a command,
       editing…), as in Claude and Codex; the steps above stay plain, finished lines. -->
    {#if message.stoppedAfter !== undefined && !message.live}
        <!-- Rises into place as the reply ends, so the text above moves up with it instead of jumping. -->
        <p
            class="m-0 text-sm text-muted-foreground"
            in:fly={{ y: 8, duration: 260, easing: cubicOut }}
        >
            You stopped after {elapsed(message.stoppedAfter)}
        </p>
    {/if}
</div>
<!-- The status line and the footer share one fixed-height slot, so the row does not jump when the reply ends. -->
{#if showLive || ((message.blocks.length > 0 || message.stoppedAfter !== undefined) && !quiet)}
    <div class="relative h-[30px] w-full shrink-0">
        {#if showLive}
            <!-- The live line sits where the next group will appear: right under the header before any content, one
               gap (gap-2) under the last text after it. It has the group header's height, so the group replaces it
               in place. While a group carries the line, or text is being written, the slot stays empty. -->
            {#if slotLine}
                <div
                    class="absolute inset-x-0 {parts.length
                        ? 'top-2'
                        : 'top-0'}"
                >
                    <LiveStatus {message} line={slotLine} />
                </div>
            {/if}
        {:else if typing}
            <!-- Nothing yet: the slot keeps its height. -->
        {:else}
            <MessageFooter
                {message}
                onfork={() => forkSession(workspace.activeId, message.id)}
                speak={spokenRun(index)}
            />
        {/if}
    </div>
{/if}
