<script lang="ts">
    import { MorphIcon, type IconInput } from 'morphicons/svelte';
    import { svgToIcon } from 'morphicons/adapters';
    import {
        lucideBan,
        lucideCheck,
        lucideCircleDot,
        lucideLoaderCircle,
        lucideShieldAlert,
        lucideX,
    } from '@ng-icons/lucide';
    import PhyllotaxisLoader from '../ui/PhyllotaxisLoader.svelte';
    import type { CardState } from '../../tasks/delegate-task';

    // The state mark of a worker: a loader while it runs, else a tinted dot with its icon (a tick, a cross, a stop).
    // Delegated work cards and the Sub agents panel draw the same mark.
    let { state }: { state: CardState } = $props();

    const STATUS_RING: Record<CardState, string> = {
        queued: 'bg-gray-500/10',
        waiting: 'bg-gray-500/10',
        running: 'bg-transparent',
        background: 'bg-transparent',
        paused: 'bg-gray-500/10',
        approval: 'bg-amber-500/10',
        done: 'bg-emerald-500/10',
        failed: 'bg-red-500/10',
        stopped: 'bg-gray-500/10',
    };
    const STATUS_BG: Record<CardState, string> = {
        queued: 'bg-gray-500/15',
        waiting: 'bg-gray-500/15',
        running: 'bg-transparent',
        background: 'bg-transparent',
        paused: 'bg-gray-500/15',
        approval: 'bg-amber-500/15',
        done: 'bg-emerald-500/15',
        failed: 'bg-red-500/15',
        stopped: 'bg-gray-500/15',
    };
    const STATUS_ICON: Record<CardState, string> = {
        queued: 'text-gray-400',
        waiting: 'text-muted-foreground',
        running: 'text-muted-foreground',
        background: 'text-muted-foreground',
        paused: 'text-muted-foreground',
        approval: 'text-amber-400',
        done: 'text-emerald-400',
        failed: 'text-red-400',
        stopped: 'text-gray-400',
    };
    const STATUS_MORPH: Record<CardState, IconInput> = {
        queued: svgToIcon(lucideCircleDot),
        waiting: svgToIcon(lucideCircleDot),
        running: svgToIcon(lucideLoaderCircle),
        background: svgToIcon(lucideLoaderCircle),
        paused: svgToIcon(lucideBan),
        approval: svgToIcon(lucideShieldAlert),
        done: svgToIcon(lucideCheck),
        failed: svgToIcon(lucideX),
        stopped: svgToIcon(lucideBan),
    };
</script>

{#if state === 'running' || state === 'background'}
    <span
        class="relative z-10 flex size-5 items-center justify-center {STATUS_ICON[
            state
        ]}"
    >
        <PhyllotaxisLoader className="text-current" />
    </span>
{:else}
    <span
        class="relative z-10 flex size-5 items-center justify-center rounded-full {STATUS_RING[
            state
        ]}"
    >
        <span
            class="relative flex size-3.5 items-center justify-center rounded-full {STATUS_BG[
                state
            ]} {STATUS_ICON[state]}"
        >
            <MorphIcon
                icon={STATUS_MORPH[state]}
                size="10"
                strokeWidth={2.3}
                spring="snappy"
                reducedMotion="user"
                class="size-2.5"
            />
        </span>
    </span>
{/if}
