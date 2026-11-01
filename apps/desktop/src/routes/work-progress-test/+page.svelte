<script lang="ts">
  import BackgroundTasks from '$lib/components/chat/BackgroundTasks.svelte';
  import type { ChatWork } from '$lib/chat/runs/chat-work';

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
</script>

<svelte:head>
  <title>Work Progress visual test</title>
</svelte:head>

<main class="min-h-screen bg-background p-8 text-foreground">
  <div class="mx-auto max-w-2xl space-y-4">
    <div>
      <h1 class="text-lg font-semibold">Work Progress visual test</h1>
      <p class="text-sm text-muted-foreground">Two fake items to verify the row separator.</p>
    </div>
    <BackgroundTasks items={items} sessionId="preview-work-test" />
  </div>
</main>
