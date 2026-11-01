<script lang="ts">
  import { ZButton, ZIcon, ZModal, ZTabs } from '@shival99/z-ui-svelte';
  import type { ZIconName } from '@shival99/z-ui-svelte';
  import ProjectSelect from '../ui/ProjectSelect.svelte';
  import DevEmpty from '../browser/DevEmpty.svelte';
  import Markdown from '../ui/Markdown.svelte';
  import { toast } from '../../app/platform/toast';
  import { workspace } from '../../chat/sessions.svelte';
  import { activityEntries, loadProjectActivity, projectActivityCache } from '../../chat/runs/project-activity.svelte';
  import type { ActivityEntry } from '../../chat/runs/project-activity';

  type Range = 'day' | 'week' | 'month' | 'all';
  type Row = ActivityEntry & { projectName: string; root: string };
  type Group = { key: string; at: string; rows: Row[] };

  const RANGES: { value: Range; label: string; days: number }[] = [
    { value: 'day', label: 'Today', days: 1 },
    { value: 'week', label: 'Week', days: 7 },
    { value: 'month', label: 'Month', days: 30 },
    { value: 'all', label: 'All', days: 0 },
  ];

  let range = $state<Range>('month');
  let project = $state<string | null>(null);
  let selected = $state<Row | null>(null);
  let modalOpen = $state(false);

  const projectRows = $derived(workspace.projects.map((item) => ({ root: item.path, name: item.name })));
  $effect(() => {
    for (const item of projectRows) void loadProjectActivity(item.root);
  });

  const allRows = $derived.by<Row[]>(() => {
    void projectActivityCache;
    return projectRows.flatMap((item) => activityEntries(item.root).map((entry) => ({ ...entry, projectName: item.name, root: item.root })));
  });
  const projectOptions = $derived([...new Set(allRows.map((row) => row.projectName))].sort((a, b) => a.localeCompare(b)));
  const chosenProject = $derived(project !== null && projectOptions.includes(project) ? project : null);

  const since = (value: Range) => {
    const days = RANGES.find((item) => item.value === value)?.days ?? 0;
    if (!days) return 0;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime() - (days - 1) * 86_400_000;
  };
  const shown = $derived(
    allRows
      .filter((row) => {
        const at = Date.parse(row.at);
        return (!Number.isFinite(at) || at >= since(range)) && (chosenProject === null || row.projectName === chosenProject);
      })
      .sort((a, b) => b.at.localeCompare(a.at)),
  );
  const dayKey = (at: string) => {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return at.slice(0, 10);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const dayLabel = (key: string) => {
    const date = new Date(`${key}T00:00:00`);
    if (Number.isNaN(date.getTime())) return key;
    const today = dayKey(new Date().toISOString());
    const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
    if (key === today) return 'Today';
    if (key === yesterday) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  };
  const groups = $derived.by<Group[]>(() => {
    const out: Group[] = [];
    for (const row of shown) {
      const key = dayKey(row.at);
      const current = out.at(-1);
      if (!current || current.key !== key) out.push({ key, at: row.at, rows: [] });
      out.at(-1)!.rows.push(row);
    }
    return out;
  });

  const formatTime = (at: string) => {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const statusTone = (status: ActivityEntry['status']) => status === 'completed' ? 'text-emerald-500' : status === 'failed' ? 'text-destructive' : 'text-muted-foreground';
  const statusLabel = (status: ActivityEntry['status']) => status === 'completed' ? 'Done' : status === 'failed' ? 'Failed' : 'Stopped';
  const safeName = (name: string) => name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project-activity';

  function download(text: string, name: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name.endsWith('.md') ? name : `${name}.md`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('Markdown downloaded');
  }

  function downloadProject(root: string, name: string) {
    download(projectActivityCache[root] ?? '# AgentDeck project activity\n', `${safeName(name)}-activity.md`);
  }

  function downloadEntry(row: Row) {
    download(row.markdown, `${safeName(row.projectName)}-${safeName(row.title)}.md`);
  }
</script>

<div class="flex h-full min-h-0 flex-1 flex-col text-sm" role="tabpanel" aria-label="Project activity log">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-1.5">
    <ZIcon zType={'lucideHistory' as ZIconName} class="size-4 text-primary" />
    <span class="font-medium">Activity log</span>
    <span class="text-muted-foreground tabular-nums">{shown.length}</span>
    {#if chosenProject}
      {@const root = projectRows.find((item) => item.name === chosenProject)?.root}
      {#if root}
        <ZButton zWave={false} zType="ghost" zSize="sm" class="ml-auto size-7! p-0" aria-label="Download project activity log" title="Download project activity log" onclick={() => downloadProject(root, chosenProject!)}>
          <ZIcon zType="lucideDownload" class="size-3.5" />
        </ZButton>
      {/if}
    {/if}
  </div>

  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-1.5 py-1.5">
    <ZTabs zTabs={RANGES.map(({ value, label }) => ({ value, label }))} zType="segmented" zSize="sm" zTabsOnly zCache={false} activeTab={range} onTabChange={(next) => (range = next as Range)} />
    {#if projectOptions.length > 0}
      <ProjectSelect variant="select" bind:value={project} options={projectOptions} label={(name) => name} class="ml-auto" />
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if allRows.length === 0}
      <DevEmpty icon="lucideHistory" title="No activity yet" hint="Completed work in a project will appear here automatically." />
    {:else if shown.length === 0}
      <DevEmpty icon="lucideInbox" title="No activity in this range" hint="Choose a longer period or another project." />
    {:else}
      {#each groups as group (group.key)}
        <div class="border-b border-border bg-background px-1.5 py-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {dayLabel(group.key)} <span class="ml-1 tabular-nums">{group.rows.length}</span>
        </div>
        {#each group.rows as row (row.id)}
          <button type="button" class="flex w-full cursor-pointer items-center gap-2 border-b border-border px-2 py-2 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40" onclick={() => { selected = row; modalOpen = true; }}>
            <ZIcon zType={'lucideGitCompare' as ZIconName} class="size-4 shrink-0 {statusTone(row.status)}" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{row.title}</span>
              <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                {#if chosenProject === null}<span class="max-w-32 truncate">{row.projectName}</span><span aria-hidden="true">·</span>{/if}
                <span class="truncate">{row.agent}{row.model ? ` · ${row.model}` : ''}</span>
                {#if row.changes.length > 0}<span class="shrink-0 text-emerald-500">+{row.changes.reduce((sum, change) => sum + change.added, 0)}</span><span class="shrink-0 text-destructive">−{row.changes.reduce((sum, change) => sum + change.removed, 0)}</span>{/if}
              </span>
            </span>
            <span class="flex shrink-0 flex-col items-end gap-0.5 text-[10px] tabular-nums text-muted-foreground"><span>{formatTime(row.at)}</span><span class={statusTone(row.status)}>{statusLabel(row.status)}</span></span>
          </button>
        {/each}
      {/each}
    {/if}
  </div>
</div>

{#if selected}
  <ZModal bind:open={modalOpen} zTitle={selected.title} zWidth="min(900px, calc(100vw - 24px))" zBodyClass="max-h-[70vh] overflow-y-auto py-3" zOkText="Close" zCancelText={null} onOk={() => (modalOpen = false)} onCancel={() => (modalOpen = false)}>
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2 border-b border-border pb-2 text-[0.6875rem] text-muted-foreground">
        <span class="flex-1">{selected.projectName} · {new Date(selected.at).toLocaleString()}</span>
        <ZButton zWave={false} zType="ghost" zSize="sm" class="h-7 gap-1.5 text-xs" onclick={() => downloadEntry(selected!)}><ZIcon zType="lucideDownload" class="size-3.5" /> Download .md</ZButton>
      </div>
      <Markdown text={selected.markdown} />
    </div>
  </ZModal>
{/if}

