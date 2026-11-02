<script lang="ts">
    // Dev-only comparison page for the running-line swap (SwapLine) and the streamed reply (AssistantMessage).
    // Not part of the release: +page.ts answers 404 outside `pnpm dev`, and the build does not prerender it.
    // Two scenarios, switched with the buttons:
    //   line  - one SwapLine whose text changes every 150 to 1500 ms, with a stream of text under it;
    //   reply - a real reply: applyAgentEvent builds the blocks, AssistantMessage draws them, three command groups
    //           interleaved with text, and the running command changes every 150 to 1500 ms.
    import { chat } from '$lib/chat/sessions.svelte';
    import { applyAgentEvent } from '$lib/chat/agent-reply';
    import type { AgentEvent } from '$lib/chat/agent';
    import SwapLine from '$lib/components/ui/SwapLine.svelte';
    import Markdown from '$lib/components/ui/Markdown.svelte';
    import AssistantMessage from '$lib/components/chat/AssistantMessage.svelte';

    type Scenario = 'line' | 'reply';
    let scenario = $state<Scenario>('line');

    const lines = [
        'Running pnpm test',
        'Running git status',
        'Reading src/lib/components/chat/CommandGroup.svelte',
        'Running cargo clippy --workspace -- -D warnings',
        'Searching "voiceOf"',
        'Running ls',
        'Using officecli load_skill word with a much longer argument list here',
    ];
    const paragraph =
        'Streaming text should arrive at a steady pace. Each word fades in while the paragraph keeps growing, and **bold** parts or `code` must not flicker. ';
    const commands = [
        'Bash pnpm test',
        'Bash git status',
        'Read src/lib/components/chat/CommandGroup.svelte',
        'Bash rg voiceOf src',
        'Bash pnpm exec svelte-check',
        'Bash ls -la',
    ];

    let line = $state(lines[0]);
    let swaps = $state(0);
    let text = $state('');
    let streaming = $state(true);

    const wait = (ms: number) =>
        new Promise<void>((done) => setTimeout(done, ms));
    const pause = () => wait(150 + Math.random() * 1350);
    const randomOf = <T,>(list: T[]) =>
        list[Math.floor(Math.random() * list.length)];

    // Scenario "line": the running line swaps; the text under it streams and restarts.
    $effect(() => {
        if (scenario !== 'line') return;
        let alive = true;
        const swap = () => {
            if (!alive) return;
            line = randomOf(lines);
            swaps++;
            setTimeout(swap, 150 + Math.random() * 1350);
        };
        const first = setTimeout(swap, 600);
        let sent = 0;
        const source = paragraph.repeat(12);
        const feed = () => {
            if (!alive) return;
            sent = Math.min(
                source.length,
                sent + 8 + Math.floor(Math.random() * 40),
            );
            text = source.slice(0, sent);
            if (sent < source.length)
                setTimeout(feed, 40 + Math.random() * 220);
            else streaming = false;
        };
        text = '';
        streaming = true;
        const start = setTimeout(feed, 300);
        return () => {
            alive = false;
            clearTimeout(first);
            clearTimeout(start);
        };
    });

    // Scenario "reply": a fake reply in chat.messages, filled with the same events a real turn sends.
    // The chat state the page used before is put back when the scenario changes.
    $effect(() => {
        if (scenario !== 'reply') return;
        let alive = true;
        const saved = chat.messages;
        const reply = () => chat.messages[0];
        // Every write checks `alive`: after the scenario changes, chat.messages holds the real messages again.
        const apply = (event: AgentEvent) => {
            const current = reply();
            if (!alive || !current) return;
            const update = applyAgentEvent(current.blocks, event);
            current.blocks = update.blocks;
        };
        const restart = () => {
            if (!alive) return;
            chat.messages = [
                {
                    id: 'swap-demo',
                    role: 'assistant',
                    time: '',
                    blocks: [],
                    live: true,
                    startedAt: Date.now(),
                    agent: 'codex',
                },
            ];
        };
        const call = (id: string, command: string): AgentEvent => {
            const [name, ...rest] = command.split(' ');
            return {
                kind: 'tool_call',
                id,
                name,
                input: rest.join(' '),
                change: null,
                background: false,
            };
        };

        const run = async () => {
            let count = 0;
            while (alive) {
                restart();
                streaming = true;
                for (let group = 0; group < 3 && alive; group++) {
                    apply({
                        kind: 'thinking',
                        text: `Step ${group + 1}: checking what is left. `,
                    });
                    await wait(200);
                    for (let step = 0; step < 3 && alive; step++) {
                        const id = `demo-${++count}`;
                        apply(call(id, commands[count % commands.length]));
                        await pause();
                        apply({
                            kind: 'tool_result',
                            id,
                            output: 'ok',
                            is_error: false,
                        });
                        await wait(120);
                    }
                    const answer = `${paragraph.slice(0, 60)}Group ${group + 1} is done. `;
                    for (let at = 0; at < answer.length && alive; at += 6) {
                        apply({
                            kind: 'delta',
                            text: answer.slice(at, at + 6),
                        });
                        await wait(40 + Math.random() * 120);
                    }
                }
                // The last command runs a little longer, so the title shows a running step at the end as well.
                const last = `demo-${++count}`;
                apply(call(last, 'Bash pnpm test'));
                await wait(1500);
                apply({
                    kind: 'tool_result',
                    id: last,
                    output: 'ok',
                    is_error: false,
                });
                apply({
                    kind: 'done',
                    session_id: null,
                    text: '',
                    cost_usd: null,
                });
                if (alive && chat.messages[0]) chat.messages[0].live = false;
                streaming = false;
                await wait(3000);
            }
        };
        void run();

        return () => {
            alive = false;
            chat.messages = saved;
        };
    });
</script>

<main class="min-h-screen bg-background p-8 text-foreground">
    <div class="mx-auto max-w-xl space-y-6 text-sm">
        <div class="flex flex-wrap items-center gap-2 text-xs">
            <button
                class="rounded border px-2 py-1 {scenario === 'line'
                    ? 'bg-muted'
                    : ''}"
                onclick={() => (scenario = 'line')}>Dòng lệnh (SwapLine)</button
            >
            <button
                class="rounded border px-2 py-1 {scenario === 'reply'
                    ? 'bg-muted'
                    : ''}"
                onclick={() => (scenario = 'reply')}
                >Reply thật (AssistantMessage)</button
            >
        </div>

        {#if scenario === 'line'}
            <div
                class="flex h-6 w-fit max-w-full items-center gap-2 text-muted-foreground"
                data-testid="row"
            >
                <span class="size-3 rounded-full bg-primary"></span>
                <SwapLine text={line} shimmer class="font-medium" />
                <span
                    class="rounded bg-emerald-500/15 px-1 font-mono text-[10px] text-emerald-500"
                    >+12</span
                >
                <span>›</span>
            </div>
            <p class="text-xs text-muted-foreground">swaps: {swaps}</p>
            <Markdown {text} {streaming} />
        {:else if chat.messages[0]}
            <AssistantMessage
                message={chat.messages[0]}
                index={0}
                agent="codex"
                questionMessageId={undefined}
            />
        {/if}
    </div>
</main>
