<script lang="ts">
    import { onDestroy } from 'svelte';
    import { fly } from 'svelte/transition';
    import { cubicOut } from 'svelte/easing';
    import { ZShimmerText } from '@shival99/z-ui-svelte';

    // One line of text that changes often (the step an agent is running now). A new line slides in over the old one in the
    // same spot, so the row never holds two lines at once, and the width eases to the new length instead of jumping, so
    // the chips and chevron after it glide. Lines that change faster than HOLD_MS are merged: the latest one waits until
    // the current one has been readable for a moment, and the ones in between are skipped.
    // `hold`: how long a line stays readable before the next one may replace it (a state label that flips between
    // "Reasoning" and "Thinking" wants a longer hold than a step name).
    // `dots`: the animated "..." after the line. It lives inside the line, so when the line is cut to fit, the dots take
    // the place of the cut-off ellipsis instead of stacking after it.
    let {
        text,
        shimmer = false,
        class: className = '',
        containerClass = '',
        hold = 420,
        dots = false,
    }: {
        text: string;
        shimmer?: boolean;
        class?: string;
        containerClass?: string;
        hold?: number;
        dots?: boolean;
    } = $props();

    const outerClass = $derived(
        dots
            ? 'flex min-w-0 whitespace-nowrap'
            : 'block min-w-0 truncate whitespace-nowrap',
    );
    const textClass = $derived(
        dots
            ? 'block min-w-0 overflow-hidden whitespace-nowrap'
            : 'block truncate',
    );

    const reduced =
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ms = (value: number) => (reduced ? 0 : value);

    let shown = $state('');
    let shownAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let width = $state(0);
    // offsetWidth rounds down: a line 65.45px wide measured as 65 cut its last letter. The exact width is rounded up.
    const measure = (node: HTMLElement) => {
        const observer = new ResizeObserver(() => {
            width = Math.ceil(node.getBoundingClientRect().width);
        });
        observer.observe(node);
        return () => observer.disconnect();
    };
    // A longer line takes its full width at once, so its text is never cut while the width eases; only a shorter one eases.
    let rising = $state(false);
    let lastWidth = 0;
    $effect.pre(() => {
        rising = width > lastWidth;
        lastWidth = width;
    });

    const show = (line: string) => {
        shown = line;
        shownAt = performance.now();
    };

    $effect.pre(() => {
        const line = text;
        if (line === shown) {
            clearTimeout(timer);
            timer = undefined;
            return;
        }
        const wait = shown ? hold - (performance.now() - shownAt) : 0;
        clearTimeout(timer);
        if (wait <= 0) show(line);
        else timer = setTimeout(() => show(text), wait);
    });

    onDestroy(() => clearTimeout(timer));
</script>

<span
    class="swap-line relative inline-grid min-w-0 max-w-full overflow-hidden align-middle {containerClass}"
    style:width={width ? `${width}px` : undefined}
    style:transition-duration="{ms(260)}ms"
    style:transition-property={rising ? 'none' : 'width'}
>
    <!-- Measures the line that is shown, for the width the row eases to. -->
    <span
        class="pointer-events-none invisible absolute left-0 top-0 w-max whitespace-nowrap {className}"
        aria-hidden="true"
        {@attach measure}
        >{shown}{#if dots}<span class="loading-dots ml-0.5 inline-flex"
                ><span>.</span><span>.</span><span>.</span></span
            >{/if}</span
    >
    <!-- Keyed on the shown line only. A shimmer change alone (the title goes from the summary to a running step, or
         back) swaps the inner text inside the same slot without replaying the slide-in of the line. -->
    {#key shown}
        <span
            class="col-start-1 row-start-1 {outerClass}"
            in:fly={{ y: 7, duration: ms(200), easing: cubicOut }}
            out:fly={{ y: -7, duration: ms(150), easing: cubicOut }}
        >
            {#if shimmer}
                <ZShimmerText class="{textClass} {className}" zText={shown} />
            {:else}
                <span class="{textClass} {className}">{shown}</span>
            {/if}
            {#if dots}
                <span
                    class="loading-dots ml-0.5 inline-flex shrink-0 {className}"
                    aria-hidden="true"
                    ><span>.</span><span>.</span><span>.</span></span
                >
            {/if}
        </span>
    {/key}
</span>

<style>
    .swap-line {
        transition-property: width;
        /* Eases in as well as out: an ease-out alone moved a long width change by ~90px in its first frame. */
        transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
</style>
