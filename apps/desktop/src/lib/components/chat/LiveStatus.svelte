<script lang="ts">
    import ActivityIndicator from '../ui/ActivityIndicator.svelte';
    import SwapLine from '../ui/SwapLine.svelte';
    import { LOADER_SIZE } from '../../app/platform/loaders';
    import { ticker } from '../../app/platform/clock.svelte';
    import { elapsed } from '../../chat/content/blocks';
    import type { LiveLine } from '../../chat/runs/live-line.svelte';
    import type { Message } from '../../chat/mock';

    // "Thinking... 24s": what the agent is doing, and how long it has taken. Shown only while the reply has no step group
    // to carry it (before the first event, or after text that is done); a group's header carries it otherwise.
    let { message, line }: { message: Message; line: LiveLine } = $props();

    const seconds = $derived(
        elapsed(ticker.sec - (message.startedAt ?? ticker.sec)),
    );
</script>

<!-- Same height and gaps as a step group's header (h-6, gap-2), so the line and the group that replaces it line up. -->
<div
    class="flex h-6 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"
    role="status"
    aria-live="off"
>
    <span class="grid size-3.5 shrink-0 place-items-center">
        {#key line.spinner}
            <ActivityIndicator
                spinner={line.spinner}
                size={LOADER_SIZE}
                color="primary"
            />
        {/key}
    </span>
    <SwapLine text={line.label} shimmer dots hold={900} />
    <!-- A fixed box for the seconds: their width changes with each tick, the box does not, so the text does not shift. -->
    <span class="inline-block min-w-[6ch] text-left tabular-nums"
        >{seconds}</span
    >
</div>
