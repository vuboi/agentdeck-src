<script lang="ts">
    import { ZIcon, ZShimmerText, ZShowMore } from '@shival99/z-ui-svelte';
    import { ticker } from '../../app/platform/clock.svelte';
    import {
        elapsed,
        thinkingPreview,
        thinkingTitle,
    } from '../../chat/content/blocks';
    import Markdown from '../ui/Markdown.svelte';

    // One reasoning entry, the same in a reply and in a step group: "Thinking" with the time and the line it is on while it
    // streams, then "Thought for 8s". Folded by default; opened, the reasoning sits under it beside a thin rule.
    // `mounted`: the body is built only once it has been opened (a folded group does not render its reasoning).
    let {
        text,
        streaming = false,
        startedAt,
        endedAt,
        open,
        ontoggle,
        mounted = true,
    }: {
        text: string;
        streaming?: boolean;
        startedAt?: number;
        endedAt?: number;
        open: boolean;
        ontoggle: () => void;
        mounted?: boolean;
    } = $props();

    const title = $derived(thinkingTitle(streaming, { startedAt, endedAt }));
    const preview = $derived(streaming ? thinkingPreview(text) : '');
</script>

<div class="flex flex-col text-sm">
    <button
        type="button"
        class="flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md py-0.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-expanded={open}
        onclick={ontoggle}
    >
        <ZIcon zType="lucideLightbulb" class="size-3 shrink-0" />
        {#if streaming}<ZShimmerText
                class="font-medium"
                zText="Thinking"
            />{:else}<span class="font-medium">{title}</span>{/if}
        {#if streaming && startedAt !== undefined}<span class="tabular-nums"
                >{elapsed(ticker.sec - startedAt)}</span
            >{/if}
        {#if preview}<span class="min-w-0 truncate">{preview}</span>{/if}
        <ZIcon
            zType="lucideChevronDown"
            class="size-3 shrink-0 transition-transform duration-300 {open
                ? 'rotate-180'
                : ''}"
        />
    </button>
    <div
        class="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none {open
            ? 'grid-rows-[1fr]'
            : 'grid-rows-[0fr]'}"
    >
        <div class="min-h-0 overflow-hidden">
            {#if mounted}
                <div
                    class="mt-1.5 ml-[5px] border-l-2 border-border py-0.5 pl-3 leading-relaxed text-muted-foreground"
                >
                    <!-- Short reasoning is shown as is: the show-more box keeps room for its button even when it has none. -->
                    {#if text.length > 600}
                        <ZShowMore
                            zMaxHeight={160}
                            zButtonSize="sm"
                            zBlurColor="var(--background)"
                            moreLabel="Show more"
                            lessLabel="Show less"
                        >
                            <Markdown {text} />
                        </ZShowMore>
                    {:else}
                        <Markdown {text} />
                    {/if}
                </div>
            {/if}
        </div>
    </div>
</div>
