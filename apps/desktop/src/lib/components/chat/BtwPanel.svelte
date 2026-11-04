<script lang="ts">
    import { ZButton, ZIcon } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
    import { askText } from '../../chat/session/run.svelte';
    import {
        followUpBtw,
        insertBtwAnswer,
        dropSide,
        sideFor,
        stopBtw,
    } from '../../chat/session/btw.svelte';
    import { toast } from '../../app/platform/toast';
    import Splitter from '../ui/Splitter.svelte';
    import MessageRow from './MessageRow.svelte';

    let { parentId }: { parentId: string } = $props();

    let followUp = $state('');
    // The panel's width, set by dragging its left edge; kept readable at both ends.
    const MIN_WIDTH = 280;
    const MAX_WIDTH = 640;
    let width = $state(352);
    const side = $derived(sideFor(parentId));

    // Dragging left makes the panel wider, as the other side panes do.
    function resize(delta: number) {
        width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - delta));
    }

    const busy = $derived(side?.busy ?? false);
    // The newest answer's text: what Copy and Insert into chat take.
    const latest = $derived(
        (side?.messages ?? [])
            .filter((message) => message.role === 'assistant')
            .map(askText)
            .filter(Boolean)
            .at(-1) ?? '',
    );
    // Waiting for the first piece of the answer: three bars, staggered.
    const waiting = $derived(
        busy && (side?.messages.at(-1)?.blocks.length ?? 0) === 0,
    );

    function send() {
        if (busy || !followUp.trim()) return;
        followUpBtw(parentId, followUp);
        followUp = '';
    }

    function onKey(event: KeyboardEvent) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
        }
    }

    function copy() {
        void navigator.clipboard.writeText(latest).then(
            () => toast.success('Copied'),
            () => toast.error('Could not copy'),
        );
    }

    function insert() {
        insertBtwAnswer(parentId, latest);
        toast.success('Added to the message box');
    }
</script>

<!-- A /btw side question: its own column beside the chat. Its messages never enter the chat's transcript. -->
{#if side}
    <Splitter axis="x" label="Resize side question" onDelta={resize} />
    <aside
        class="flex max-w-full shrink-0 flex-col bg-background"
        style:width="{width}px"
        aria-label="Side question"
    >
        <header
            class="flex items-start gap-2 border-b border-border px-3 py-2.5"
        >
            <div class="min-w-0 flex-1">
                <div
                    class="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                    <span class="font-medium text-foreground">/btw</span>
                    <span>· Read-only</span>
                </div>
                <div class="mt-0.5 truncate text-sm">{side.question}</div>
            </div>
            <ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class="size-7! shrink-0 p-0"
                aria-label="Close side question"
                onclick={() => dropSide(parentId)}
            >
                <ZIcon zType={'lucideX' as ZIconName} class="size-3" />
            </ZButton>
        </header>

        <div
            class="min-h-0 flex-1 overflow-y-auto"
            role="status"
            aria-live="polite"
        >
            {#if waiting}
                <div
                    class="flex flex-col gap-2 px-3 py-3"
                    aria-label="Answering"
                >
                    {#each [0.9, 0.7, 0.8] as width, index (index)}
                        <div
                            class="h-3 animate-pulse rounded bg-muted"
                            style:width="{width * 100}%"
                            style:animation-delay="{index * 120}ms"
                        ></div>
                    {/each}
                </div>
            {:else}
                {#each side.messages as message, index (message.id)}
                    <MessageRow
                        {message}
                        {index}
                        previous={side.messages[index - 1]}
                        last={index === side.messages.length - 1}
                        agent="claude"
                        sessionId={side.session}
                        detached
                    />
                {/each}
            {/if}
        </div>

        {#if latest && !busy}
            <div
                class="flex items-center gap-1 border-t border-border px-3 py-2"
            >
                <ZButton
                    zWave={false}
                    zType="outline"
                    zSize="sm"
                    class="h-7 px-2 text-xs"
                    onclick={copy}
                >
                    <ZIcon zType={'lucideCopy' as ZIconName} class="size-3" />
                    Copy
                </ZButton>
                <ZButton
                    zWave={false}
                    zType="outline"
                    zSize="sm"
                    class="h-7 px-2 text-xs"
                    onclick={insert}
                >
                    Insert into chat
                </ZButton>
            </div>
        {/if}

        <form
            class="m-2 rounded-2xl border border-input bg-card p-2 shadow-lg"
            onsubmit={(event) => {
                event.preventDefault();
                send();
            }}
        >
            <textarea
                rows="2"
                bind:value={followUp}
                onkeydown={onKey}
                disabled={busy}
                placeholder="Ask a follow-up…"
                class="block max-h-40 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            ></textarea>
            <div class="flex justify-end gap-1">
                {#if busy}
                    <ZButton
                        zWave={false}
                        zType="outline"
                        zSize="sm"
                        class="h-7 px-2 text-xs"
                        onclick={stopBtw}
                    >
                        Stop
                    </ZButton>
                {:else}
                    <ZButton
                        zWave={false}
                        zType="ghost"
                        zSize="sm"
                        class="size-7! shrink-0 rounded-full p-0 {followUp.trim()
                            ? '!text-primary'
                            : '!text-muted-foreground'}"
                        aria-label="Send follow-up"
                        disabled={!followUp.trim()}
                        onclick={send}
                    >
                        <ZIcon
                            zType={'lucideCornerDownLeft' as ZIconName}
                            class="size-3.5"
                        />
                    </ZButton>
                {/if}
            </div>
        </form>
    </aside>
{/if}
