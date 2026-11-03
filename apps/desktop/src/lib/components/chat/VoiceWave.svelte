<script lang="ts">
    import { onMount } from 'svelte';
    import type { VoiceCapture } from '../../chat/voice.svelte';

    /** Must match WAVE_STEP_MS in chat/voice.svelte.ts. */
    const STEP_MS = 60;
    const WIDTH = 56;
    const HEIGHT = 16;
    /** Distance between bar centers, in CSS pixels. */
    const SPACING = 3;

    let { voice }: { voice: VoiceCapture } = $props();
    let canvas: HTMLCanvasElement | undefined;

    onMount(() => {
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = WIDTH * dpr;
        canvas.height = HEIGHT * dpr;
        context.scale(dpr, dpr);
        context.lineCap = 'round';
        const color = getComputedStyle(canvas).color;
        const mid = HEIGHT / 2;

        // Bars scroll left continuously between samples: the newest bar slides
        // from the right edge into place, so the strip never jumps.
        let frame = 0;
        const draw = (now: number) => {
            context.clearRect(0, 0, WIDTH, HEIGHT);
            context.strokeStyle = color;

            context.globalAlpha = 0.45;
            context.lineWidth = 1.5;
            context.beginPath();
            context.moveTo(0, mid);
            context.lineTo(WIDTH, mid);
            context.stroke();

            context.globalAlpha = 1;
            context.lineWidth = 2;
            const progress = Math.min(
                1,
                Math.max(0, (now - voice.waveAt) / STEP_MS),
            );
            const bars = voice.wave;
            for (let back = 0; back < bars.length; back++) {
                const x = WIDTH - SPACING / 2 - (back + progress) * SPACING;
                if (x < -SPACING) break;
                const height = 2 + bars[bars.length - 1 - back] * (HEIGHT - 2);
                context.beginPath();
                context.moveTo(x, mid - height / 2);
                context.lineTo(x, mid + height / 2);
                context.stroke();
            }
            frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(frame);
    });
</script>

<canvas
    bind:this={canvas}
    class="voice-wave"
    style:width="{WIDTH}px"
    style:height="{HEIGHT}px"
    aria-hidden="true"
></canvas>

<style>
    .voice-wave {
        display: block;
        flex: none;
        /* Fade both ends so bars appear and leave the strip smoothly. */
        -webkit-mask-image: linear-gradient(
            to right,
            transparent,
            #000 20%,
            #000 80%,
            transparent
        );
        mask-image: linear-gradient(
            to right,
            transparent,
            #000 20%,
            #000 80%,
            transparent
        );
    }
</style>
