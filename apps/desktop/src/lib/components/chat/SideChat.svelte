<script lang="ts">
    import { theme } from '../../app/ui/theme.svelte';
    import { hollow } from '../../chat/content/chat-dividers';
    import type { Message } from '../../chat/mock';
    import {
        callChildBlocks,
        type ChildAgent,
    } from '../../chat/runs/child-agents';
    import { messagesView } from '../../chat/session/run.svelte';
    import { workspace } from '../../chat/sessions.svelte';
    import DevEmpty from '../browser/DevEmpty.svelte';
    import AssistantMessage from './AssistantMessage.svelte';
    import UserMessage from './UserMessage.svelte';

    // A child agent's chat drawn with the main chat's own message rows, so it reads and runs the same: live line,
    // steps, thinking, footer. A native sub agent has no chat of its own: its steps under the call read as one reply.
    let { agent }: { agent: ChildAgent } = $props();

    const sessionId = $derived(
        agent.source.type === 'session'
            ? agent.source.sessionId
            : agent.parentId,
    );
    const session = $derived(
        workspace.sessions.find((item) => item.id === sessionId),
    );
    const messages = $derived.by((): Message[] => {
        const source = agent.source;
        if (source.type === 'session') return messagesView(source.sessionId);
        return [
            {
                id: `${source.messageId}:${source.callId}`,
                role: 'assistant',
                time: '',
                blocks: callChildBlocks(
                    messagesView(agent.parentId),
                    source.messageId,
                    source.callId,
                    agent.kind,
                ),
                live: agent.state === 'running',
                agent: agent.agent as Message['agent'],
                model: agent.model ?? undefined,
                startedAt: agent.startedAt,
                ms: agent.endedAt ? agent.endedAt - agent.startedAt : undefined,
            },
        ];
    });

    // The rows that draw something, with their place in `messages` (a reply cut off before it wrote anything draws none).
    const shown = $derived(
        messages
            .map((message, index) => ({ message, index }))
            .filter(
                ({ message }) => !hollow(message, messages.at(-1) !== message),
            ),
    );

    // Follows the newest output while the view is at the bottom; scrolling up stops following until it is back there.
    let scroller: HTMLDivElement | undefined = $state();
    let content: HTMLDivElement | undefined = $state();
    let following = true;
    $effect(() => {
        if (!scroller || !content) return;
        const box = scroller;
        const observer = new ResizeObserver(() => {
            if (following) box.scrollTop = box.scrollHeight;
        });
        observer.observe(content);
        return () => observer.disconnect();
    });
    function onscroll() {
        if (!scroller) return;
        following =
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
            48;
    }
</script>

<div bind:this={scroller} {onscroll} class="min-h-0 flex-1 overflow-y-auto">
    <div bind:this={content} class="flex min-h-full flex-col py-2">
        {#each shown as { message, index } (message.id)}
            {@const mine = message.role === 'user'}
            <article
                class="group/msg flex w-full min-w-0 flex-col break-words px-3 py-2.5 {mine &&
                theme.chatLayout === 'split'
                    ? 'items-end'
                    : 'items-start'}"
            >
                {#if mine}
                    <UserMessage {message} {sessionId} copyOnly />
                {:else}
                    <AssistantMessage
                        {message}
                        {index}
                        agent={message.agent ??
                            agent.agent ??
                            session?.source ??
                            session?.agent ??
                            'claude'}
                        questionMessageId={undefined}
                        {sessionId}
                        {messages}
                        copyOnly
                    />
                {/if}
            </article>
        {:else}
            <div class="flex flex-1 items-center justify-center">
                <DevEmpty
                    icon="lucideMessageSquareMore"
                    title="Waiting for output"
                    hint="Replies and tool calls appear here as the agent works."
                />
            </div>
        {/each}
    </div>
</div>
