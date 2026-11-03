<script lang="ts">
    import BackgroundTasks from '$lib/components/chat/BackgroundTasks.svelte';
    import TaskCards from '$lib/components/tasks/TaskCards.svelte';
    import type { ChatWork } from '$lib/chat/runs/chat-work';
    import type { CommandBlock } from '$lib/chat/content/blocks';

    const now = Date.now();
    const items: ChatWork[] = [
        {
            id: 'preview:work-running',
            sessionId: 'preview-work-test',
            title: 'pnpm --filter desktop dev E:/WORK/PROJECTS/agentdeck',
            state: 'running',
            kind: 'command',
            startedAt: now - 1303_000,
            detail: 'Fake running item for the Work Progress visual check.',
        },
        {
            id: 'preview:work-failed',
            sessionId: 'preview-work-test',
            title: 'pnpm --filter desktop dev ... --port 1432',
            state: 'failed',
            kind: 'command',
            startedAt: now - 36_000,
            endedAt: now - 2_000,
            detail: 'Fake failed item for the Work Progress visual check.',
        },
    ];
    const delegated: CommandBlock[] = [
        {
            kind: 'command',
            id: 'preview:delegated-running',
            command:
                'delegate_task {"agent":"codex","model":"gpt-5.1-codex","task":"Review the task activity card layout"}',
            output: '[task preview-running · chat preview-agent · Review layout · running · 2m 11s]\n\n',
            status: 'running',
            model: 'gpt-5.1-codex',
        },
        {
            kind: 'command',
            id: 'preview:delegated-done',
            command:
                'delegate_task {"agent":"claude","model":"claude-sonnet-4-5","task":"Check the delegated task details"}',
            output: '[task preview-done · chat preview-agent-done · Check details · done · 1m 08s]\n\nThe details panel is ready to inspect.',
            status: 'ok',
            model: 'claude-sonnet-4-5',
        },
    ];
</script>

<svelte:head>
    <title>Work Progress visual test</title>
</svelte:head>

<main class="min-h-screen bg-background p-8 text-foreground">
    <div class="mx-auto max-w-2xl space-y-4">
        <div>
            <h1 class="text-lg font-semibold">Work Progress visual test</h1>
            <p class="text-sm text-muted-foreground">
                Fake delegated cards and Work rows for the compact status
                layout.
            </p>
        </div>
        <section class="space-y-2">
            <h2 class="text-sm font-medium">Chat content — delegated task</h2>
            <TaskCards items={delegated} />
        </section>
        <section class="space-y-2">
            <h2 class="text-sm font-medium">Chat input — background work</h2>
            <BackgroundTasks
                {items}
                sessionId="preview-work-test"
                title="Work"
            />
        </section>
    </div>
</main>
