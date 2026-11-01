<script lang="ts">
  import { ZButton, ZIcon, ZModal, ZTabs } from '@shival99/z-ui-svelte';
  import type { ZIconName } from '@shival99/z-ui-svelte';
  import ProjectSelect from '../ui/ProjectSelect.svelte';
  import DevEmpty from '../browser/DevEmpty.svelte';
  import Markdown from '../ui/Markdown.svelte';
  import { toast } from '../../app/platform/toast';
  import { inTauri } from '../../app/platform/history';
  import { workspace } from '../../chat/sessions.svelte';
  import { activityEntries, loadProjectActivity, projectActivityCache } from '../../chat/runs/project-activity.svelte';
  import type { ActivityEntry } from '../../chat/runs/project-activity';

  type Range = 'day' | 'week' | 'month' | 'all';
  type Row = ActivityEntry & { projectName: string; root: string };
  type Flat = { id: string; kind: 'day'; key: string; rows: Row[] } | { id: string; kind: 'row'; row: Row };
  const RANGES: { value: Range; label: string; days: number }[] = [
    { value: 'day', label: 'Today', days: 1 }, { value: 'week', label: 'Week', days: 7 },
    { value: 'month', label: 'Month', days: 30 }, { value: 'all', label: 'All', days: 0 },
  ];
  const PAGE_SIZE = 40;
  let range = $state<Range>('month');
  let project = $state<string | null>(null);
  let selected = $state<Row | null>(null);
  let modalOpen = $state(false);
  let saving = $state(false);
  let scroller = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewport = $state(0);
  let measured = $state(0);
  let scrollIntent = false;
  const heights = new Map<string, number>();
  const EST_ROW = 64;
  const EST_DAY = 28;
  const OVERSCAN = 400;

  const projectRows = $derived(workspace.projects.map((item) => ({ root: item.path, name: item.name })));
  $effect(() => { for (const item of projectRows) void loadProjectActivity(item.root); });
  const allRows = $derived.by<Row[]>(() => {
    void projectActivityCache;
    return projectRows.flatMap((item) => activityEntries(item.root).map((entry) => ({ ...entry, projectName: item.name, root: item.root })));
  });
  const projectOptions = $derived([...new Set(allRows.map((row) => row.projectName))].sort((a, b) => a.localeCompare(b)));
  const chosenProject = $derived(project !== null && projectOptions.includes(project) ? project : null);
  const since = (value: Range) => { const days = RANGES.find((item) => item.value === value)?.days ?? 0; if (!days) return 0; const start = new Date(); start.setHours(0, 0, 0, 0); return start.getTime() - (days - 1) * 86_400_000; };
  const shown = $derived(allRows.filter((row) => { const at = Date.parse(row.at); return (!Number.isFinite(at) || at >= since(range)) && (chosenProject === null || row.projectName === chosenProject); }).sort((a, b) => b.at.localeCompare(a.at)));
  let visibleCount = $state(PAGE_SIZE);
  $effect.pre(() => { range; project; visibleCount = PAGE_SIZE; scrollIntent = false; scrollTop = 0; if (scroller) scroller.scrollTop = 0; });
  const dayKey = (at: string) => { const date = new Date(at); return Number.isNaN(date.getTime()) ? at.slice(0, 10) : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  const dayLabel = (key: string) => { const date = new Date(`${key}T00:00:00`); if (Number.isNaN(date.getTime())) return key; const today = dayKey(new Date().toISOString()); const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString()); if (key === today) return 'Today'; if (key === yesterday) return 'Yesterday'; return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); };
  const groups = $derived.by(() => { const out: { key: string; rows: Row[] }[] = []; for (const row of shown.slice(0, visibleCount)) { const key = dayKey(row.at); const current = out.at(-1); if (!current || current.key !== key) out.push({ key, rows: [] }); out.at(-1)!.rows.push(row); } return out; });
  const flat = $derived.by<Flat[]>(() => groups.flatMap((group) => [{ id: `day:${group.key}`, kind: 'day' as const, key: group.key, rows: group.rows }, ...group.rows.map((row, index) => ({ id: `row:${row.root}:${row.id}:${row.at}:${index}`, kind: 'row' as const, row }))]));
  const heightAt = (index: number) => heights.get(flat[index].id) ?? (flat[index].kind === 'day' ? EST_DAY : EST_ROW);
  const layout = $derived.by(() => { void measured; const tops: number[] = new Array(flat.length); let y = 0; for (let i = 0; i < flat.length; i++) { tops[i] = y; y += heightAt(i); } return { tops, total: y }; });
  function firstBelow(edge: number) { let lo = 0; let hi = flat.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (layout.tops[mid] + heightAt(mid) <= edge) lo = mid + 1; else hi = mid; } return lo; }
  const win = $derived.by(() => { const start = firstBelow(scrollTop - OVERSCAN); let end = start; while (end < flat.length && layout.tops[end] < scrollTop + viewport + OVERSCAN) end++; return { start, end, padTop: start < flat.length ? layout.tops[start] : layout.total, padBottom: end < flat.length ? layout.total - layout.tops[end] : 0 }; });
  const visible = $derived(flat.slice(win.start, win.end));
  const pinned = $derived.by(() => { const item = flat[Math.min(firstBelow(scrollTop), flat.length - 1)]; if (!item) return undefined; if (item.kind === 'day') return item; return flat.slice(0, firstBelow(scrollTop) + 1).findLast((entry) => entry.kind === 'day'); });
  const indexOfId = $derived(new Map(flat.map((entry, index) => [entry.id, index])));
  function measure(id: string) { return (el: HTMLElement) => { const observer = new ResizeObserver(() => { const height = el.getBoundingClientRect().height; const index = indexOfId.get(id); if (index === undefined) return; const before = heightAt(index); if (before === height) return; const top = layout.tops[index]; heights.set(id, height); measured++; if (scroller && top + before <= scroller.scrollTop) scroller.scrollTop += height - before; }); observer.observe(el); return () => observer.disconnect(); }; }
  const hasMore = $derived(visibleCount < shown.length);
  function loadMore() { if (hasMore) visibleCount += PAGE_SIZE; }
  function onWheel() { scrollIntent = true; }
  function onScroll() { if (!scroller) return; scrollTop = scroller.scrollTop; const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight; if (scrollIntent && distanceToBottom < 220 && hasMore) { scrollIntent = false; loadMore(); } }
  $effect(() => { if (!scroller || viewport === 0 || !hasMore || layout.total >= viewport + 220) return; loadMore(); });
  const formatTime = (at: string) => { const date = new Date(at); return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const statusTone = (status: ActivityEntry['status']) => status === 'completed' ? 'text-emerald-500' : status === 'failed' ? 'text-destructive' : 'text-muted-foreground';
  const statusLabel = (status: ActivityEntry['status']) => status === 'completed' ? 'Done' : status === 'failed' ? 'Failed' : 'Stopped';
  const safeName = (name: string) => name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project-activity';
  async function download(text: string, name: string) { const filename = name.endsWith('.md') ? name : `${name}.md`; try { saving = true; if (inTauri()) { const { invoke } = await import('@tauri-apps/api/core'); const path = await invoke<string | null>('project_activity_save', { name: filename, text }); if (path) toast.success(`Activity log saved to ${path}`); return; } const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); toast.success(`Downloaded ${filename} to your Downloads folder`); } catch (error) { toast.error(`Could not save activity log: ${String(error)}`); } finally { saving = false; } }
  function activityBody(markdown: string) { return markdown.replace(/(^|[\r\n])## [^\r\n]*(?:\r?\n){2}/, '$1'); }
</script>

{#snippet dayHeader(group: { key: string; rows: Row[] }, pin: boolean)}
  {#if pin}<div class="sticky top-0 z-10 h-0 overflow-visible">{@render dayHeading(group)}</div>
  {:else}{@render dayHeading(group)}{/if}
{/snippet}

{#snippet dayHeading(group: { key: string; rows: Row[] })}
  <div class="flex h-7 min-h-7 w-full shrink-0 items-center border-b border-border bg-background px-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
    {dayLabel(group.key)} <span class="ml-1 tabular-nums">{group.rows.length}</span>
  </div>
{/snippet}

<div class="flex h-full min-h-0 flex-1 flex-col text-sm" role="tabpanel" aria-label="Project activity log">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-1.5"><ZIcon zType={'lucideHistory' as ZIconName} class="size-4 text-primary" /><span class="font-medium">Activity log</span><span class="text-muted-foreground tabular-nums">{shown.length}</span>{#if chosenProject}{@const root = projectRows.find((item) => item.name === chosenProject)?.root}{#if root}<ZButton zWave={false} zType="ghost" zSize="sm" class="ml-auto size-7! p-0" disabled={saving} aria-label="Download project activity log" title="Download project activity log" onclick={() => void download(projectActivityCache[root] ?? '# AgentDeck project activity\n', `${safeName(chosenProject!)}-activity.md`)}><ZIcon zType="lucideDownload" class="size-3.5" /></ZButton>{/if}{/if}</div>
  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-1.5 py-1.5"><ZTabs zTabs={RANGES.map(({ value, label }) => ({ value, label }))} zType="segmented" zSize="sm" zTabsOnly zCache={false} activeTab={range} onTabChange={(next) => (range = next as Range)} />{#if projectOptions.length > 0}<ProjectSelect variant="select" bind:value={project} options={projectOptions} label={(name) => name} class="ml-auto" />{/if}</div>
  <div bind:this={scroller} bind:clientHeight={viewport} class="flex min-h-0 flex-1 flex-col overflow-y-auto" style="overflow-anchor: none" role="region" aria-label="Activity entries" onscroll={onScroll} onwheel={onWheel}>
    {#if allRows.length === 0}<DevEmpty icon="lucideHistory" title="No activity yet" hint="Completed work in a project will appear here automatically." />{:else if shown.length === 0}<DevEmpty icon="lucideInbox" title="No activity in this range" hint="Choose a longer period or another project." />{:else}
      {#if pinned}{@render dayHeader(pinned, true)}{/if}
      <div class="shrink-0" style="padding-top: {win.padTop}px; padding-bottom: {win.padBottom}px">
        {#each visible as entry (entry.id)}
          <div {@attach measure(entry.id)}>
            {#if entry.kind === 'day'}{@render dayHeader(entry, false)}
            {:else}<button type="button" class="flex w-full cursor-pointer items-center gap-2 border-b border-border px-2 py-2 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40" onclick={() => { selected = entry.row; modalOpen = true; }}><ZIcon zType={'lucideGitCompare' as ZIconName} class="size-4 shrink-0 {statusTone(entry.row.status)}" /><span class="min-w-0 flex-1"><span class="block truncate font-medium">{entry.row.title}</span><span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground"><span class="truncate">{entry.row.projectName} · {entry.row.agent}{entry.row.model ? ` · ${entry.row.model}` : ''}</span>{#if entry.row.changes.length > 0}<span class="shrink-0 text-emerald-500">+{entry.row.changes.reduce((sum, change) => sum + change.added, 0)}</span><span class="shrink-0 text-destructive">−{entry.row.changes.reduce((sum, change) => sum + change.removed, 0)}</span>{/if}</span></span><span class="flex shrink-0 flex-col items-end gap-0.5 text-[10px] tabular-nums text-muted-foreground"><span>{formatTime(entry.row.at)}</span><span class={statusTone(entry.row.status)}>{statusLabel(entry.row.status)}</span></span></button>{/if}
          </div>
        {/each}
      </div>
      {#if hasMore}<div class="flex justify-center py-2"><ZButton zWave={false} zType="outline" zSize="sm" class="h-7 px-2.5 text-xs" onclick={loadMore}>Load older activity</ZButton></div>{/if}
    {/if}
  </div>
</div>
{#if selected}<ZModal bind:open={modalOpen} zTitle={`${selected.title} · ${selected.model || selected.agent} · ${new Date(selected.at).toLocaleString()}`} zWidth="min(900px, calc(100vw - 24px))" zBodyClass="max-h-[70vh] overflow-y-auto py-3" onCancel={() => (modalOpen = false)}><Markdown text={activityBody(selected.markdown)} />{#snippet footer()}<div class="flex items-center justify-end gap-2"><ZButton zWave={false} zType="outline" zSize="sm" class="h-8 gap-1.5 px-3 text-sm" disabled={saving} onclick={() => { void download(selected!.markdown, `${safeName(selected!.projectName)}-${safeName(selected!.title)}.md`); modalOpen = false; }}><ZIcon zType={'lucideDownload' as ZIconName} class="size-3.5" /> Download</ZButton><ZButton zWave={false} zSize="sm" class="h-8 px-3 text-sm" onclick={() => (modalOpen = false)}>Close</ZButton></div>{/snippet}</ZModal>{/if}
