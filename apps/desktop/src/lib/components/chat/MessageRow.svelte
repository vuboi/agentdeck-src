<script lang="ts">
    import { theme } from '../../app/ui/theme.svelte';
    import { openSelectionMenu } from '../../app/ui/selection-menu.svelte';
    import {
        hollow,
        markerText,
        turnDivider,
    } from '../../chat/content/chat-dividers';
    import type { Message } from '../../chat/mock';
    import UserMessage from './UserMessage.svelte';
    import AssistantMessage from './AssistantMessage.svelte';
    import DelegateList from '../tasks/DelegateList.svelte';

    /**
     * One message as the transcript draws it: its divider or session line, its bubble or reply, and the delegated
     * workers it handed out. The chat and a /btw side question both draw their messages with it.
     * `index` is the message's place in its list, `previous` the message before it, `last` whether it is the newest.
     */
    let {
        message,
        index,
        previous,
        last,
        agent,
        sessionId,
        questionMessageId = undefined,
        detached = false,
    }: {
        message: Message;
        index: number;
        previous: Message | undefined;
        last: boolean;
        agent: string;
        sessionId?: string;
        questionMessageId?: string | undefined;
        detached?: boolean;
    } = $props();

    const mine = $derived(message.role === 'user');
    const isHollow = $derived(hollow(message, !last));
</script>

{#if theme.turnDividers && message.mark}
    <div
        class="chat-mark mx-auto flex w-full max-w-[52rem] items-center gap-3 px-3 pt-3 min-[720px]:px-8"
        role="separator"
        aria-label={markerText(message.mark)}
    >
        <span class="chat-rule"></span>
        <span class="shrink-0 text-[0.6875rem] text-muted-foreground"
            >{markerText(message.mark)}</span
        >
        <span class="chat-rule"></span>
    </div>
{:else if isHollow}
    <!-- Cut off before it wrote anything: nothing to draw. -->
{:else if turnDivider(previous, message, theme.turnDividers)}
    <div
        class="mx-auto w-full max-w-[52rem] px-3 pt-1 min-[720px]:px-8"
        role="separator"
        aria-hidden="true"
    >
        <div class="chat-rule"></div>
    </div>
{/if}
<!-- No avatars: your messages are a bubble (right side, or left in one-sided mode); the agent is just its coloured name. -->
{#if !isHollow}
    <article
        oncontextmenu={(event) =>
            openSelectionMenu(
                event,
                message.blocks
                    .map((block) =>
                        block.kind === 'response' ? block.text : '',
                    )
                    .filter(Boolean)
                    .join('\n\n'),
            )}
        class="group/msg mx-auto flex w-full min-w-0 max-w-[52rem] flex-col break-words py-2.5 px-3 min-[720px]:px-8 {mine &&
        theme.chatLayout === 'split'
            ? 'items-end'
            : 'items-start'}"
    >
        {#if mine}
            <UserMessage {message} {sessionId} />
        {:else}
            <AssistantMessage
                {message}
                {index}
                {agent}
                {questionMessageId}
                {sessionId}
                {detached}
            />
        {/if}
    </article>
    <!-- Delegated agents are shown as their own row, apart from the user's bubble, so hovering one does not light up the other. -->
    {#if mine && message.blocks.some((block) => block.kind === 'delegate')}
        <div
            class="mx-auto flex w-full min-w-0 max-w-[52rem] flex-col items-start px-3 pb-2.5 min-[720px]:px-8"
        >
            <DelegateList
                blocks={message.blocks.filter(
                    (block) => block.kind === 'delegate',
                )}
            />
        </div>
    {/if}
{/if}
