<script lang="ts">
  import { slide } from 'svelte/transition';
import { MorphIcon, type IconInput } from 'morphicons/svelte';
import { svgToIcon } from 'morphicons/adapters';
import { lucideBan, lucideCheck, lucideCircleDot, lucideLoaderCircle, lucideShieldAlert, lucideX } from '@ng-icons/lucide';
import { ZIcon } from '@shival99/z-ui-svelte';
  import AgentLogo from '../ui/AgentLogo.svelte';
  import StatusRoller from '../ui/StatusRoller.svelte';
  import { elapsed, type CommandBlock } from '../../chat/content/blocks';
  import { ticker } from '../../app/platform/clock.svelte';
  import { showSession } from '../../app/ui/content-tabs.svelte';
  import { connectors } from '../../agents/connectors.svelte';
  import { cardOf, MAX_WORKERS, parseTaskResult, type CardState } from '../../tasks/delegate-task';
  import { modelLabel } from '../../agents/models.svelte';
  import { agentDisplayName } from '../../agents/provider-registry';
  import { delegateTasks, liveStats, needsApproval, stopDelegateTask, workspace } from '../../chat/sessions.svelte';

  let { items }: { items: CommandBlock[] } = $props();
  let open = $state<Record<string, boolean>>({});
  const key = (item: CommandBlock, index: number) => item.id ?? String(index);
  const recordOf = (item: CommandBlock) => {
    const id = item.taskId ?? parseTaskResult(item.output)?.taskId;
    return id ? delegateTasks[id] : undefined;
  };
  function nameOf(card: ReturnType<typeof cardOf>, record: ReturnType<typeof recordOf>): string {
    if (record) return record.label;
    const wanted = card.agent ?? 'an agent';
    const known = agentDisplayName(wanted.toLowerCase());
    const provider = connectors.custom.find((item) => item.id === wanted);
    const name = known !== wanted.toLowerCase() ? known : provider?.name ?? wanted;
    return card.model ? `${name} · ${modelLabel(card.model) || card.model}` : name;
  }
  const kindOf = (card: ReturnType<typeof cardOf>, record: ReturnType<typeof recordOf>) => (record?.agent ?? card.agent ?? '').toLowerCase();
  const STATUS: Record<CardState, string> = { queued: 'Queued', running: 'Working', background: 'Background', approval: 'Needs approval', done: 'Answered', failed: 'Failed', stopped: 'Stopped' };
  const TONE: Record<CardState, string> = { queued: 'text-muted-foreground', running: 'text-primary', background: 'text-primary', approval: 'text-warning', done: 'text-emerald-500', failed: 'text-destructive', stopped: 'text-muted-foreground' };
  const STATUS_RING: Record<CardState, string> = { queued: 'bg-gray-500/10', running: 'bg-blue-500/10', background: 'bg-blue-500/10', approval: 'bg-amber-500/10', done: 'bg-emerald-500/10', failed: 'bg-red-500/10', stopped: 'bg-gray-500/10' };
  const STATUS_BG: Record<CardState, string> = { queued: 'bg-gray-500/15', running: 'bg-blue-500/15', background: 'bg-blue-500/15', approval: 'bg-amber-500/15', done: 'bg-emerald-500/15', failed: 'bg-red-500/15', stopped: 'bg-gray-500/15' };
  const STATUS_ICON: Record<CardState, string> = { queued: 'text-gray-400', running: 'text-blue-400', background: 'text-blue-400', approval: 'text-amber-400', done: 'text-emerald-400', failed: 'text-red-400', stopped: 'text-gray-400' };
  const STATUS_MORPH: Record<CardState, IconInput> = {
    queued: svgToIcon(lucideCircleDot),
    running: svgToIcon(lucideLoaderCircle),
    background: svgToIcon(lucideLoaderCircle),
    approval: svgToIcon(lucideShieldAlert),
    done: svgToIcon(lucideCheck),
    failed: svgToIcon(lucideX),
    stopped: svgToIcon(lucideBan),
  };
  const live = (state: CardState) => state === 'queued' || state === 'running' || state === 'background' || state === 'approval';
  function took(card: ReturnType<typeof cardOf>): string {
    void ticker.sec;
    if (!card.startedAt) return card.duration ?? '';
    return elapsed((card.endedAt ?? Date.now()) - card.startedAt);
  }
  function doing(card: ReturnType<typeof cardOf>): string {
    if (!live(card.state) || !card.childId) return '';
    void ticker.sec;
    return liveStats(card.childId, card.startedAt ?? Date.now())?.last ?? '';
  }
  const firstLine = (text?: string) => (text ?? '').split('\n').find((line) => line.trim())?.trim() ?? '';
  const finished = $derived(items.filter((item) => !live(cardOf(item, recordOf(item)).state)).length);
</script>

<div class="block-in w-full max-w-full overflow-hidden rounded-xl border border-border bg-background text-sm shadow-xs">
  <div class="flex min-w-0 items-center gap-2 border-b border-border/70 bg-muted/30 px-3 py-2">
    <span class="grid size-5 shrink-0 place-items-center rounded-md bg-primary/10 text-primary" aria-hidden="true"><ZIcon zType="lucideUsersRound" class="size-3.5" /></span>
    <span class="min-w-0 truncate font-medium">Delegated work</span>
    <span class="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{finished}/{items.length} complete</span>
  </div>
  <div class="px-3 py-1">
    {#each items as item, index (key(item, index))}
      {@const record = recordOf(item)}
      {@const card = cardOf(item, record)}
      {@const kind = kindOf(card, record)}
      {@const rowKey = key(item, index)}
      {@const expanded = open[rowKey] ?? false}
      {@const jumpable = Boolean(card.childId) && workspace.sessions.some((chat) => chat.id === card.childId)}
      <div class="group/row relative flex w-full items-start gap-2 py-2.5">
        <div class="relative flex w-5 shrink-0 justify-center self-stretch" aria-hidden="true">
          {#if index < items.length - 1}<span class="absolute top-5 bottom-[-0.625rem] w-px bg-border/80"></span>{/if}
          <span class="relative z-10 flex size-5 items-center justify-center rounded-full {STATUS_RING[card.state]}">
            <span class="relative flex size-3.5 items-center justify-center rounded-full {STATUS_BG[card.state]} {STATUS_ICON[card.state]}">
              <MorphIcon
                icon={STATUS_MORPH[card.state]}
                size="10"
                strokeWidth={2.3}
                spring="snappy"
                reducedMotion="user"
                class="size-2.5 {card.state === 'running' || card.state === 'background' ? 'animate-spin' : ''}"
              />
            </span>
          </span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <AgentLogo agent={kind} model={card.model} class="size-3.5 shrink-0" />
              <span class="min-w-0 truncate font-medium" title={nameOf(card, record)}>{nameOf(card, record)}</span>
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              <span class="inline-flex max-w-[8rem] items-center gap-1 overflow-hidden text-xs {TONE[card.state]}">
                {#if card.state === 'running' || card.state === 'background' || card.state === 'queued'}<StatusRoller current={STATUS[card.state]} sizes={Object.values(STATUS)} />{:else}<span class="truncate">{STATUS[card.state]}</span>{/if}
              </span>
              {#if took(card)}<span class="shrink-0 text-xs tabular-nums text-muted-foreground">{took(card)}</span>{/if}
            </div>
            {#if live(card.state) && card.taskId}<button type="button" class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/60" aria-label="Stop the task for {nameOf(card, record)}" title="Stop this task" onclick={() => stopDelegateTask(card.taskId!)}><ZIcon zType="lucideSquare" class="size-3 fill-current" /></button>{/if}
            <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:text-primary group-hover/row:text-foreground {jumpable ? 'cursor-pointer' : 'cursor-default opacity-40'}" disabled={!jumpable} aria-label="Open the chat of the agent for {nameOf(card, record)}" title="Open this agent's chat" onclick={() => jumpable && showSession(card.childId!)}><ZIcon zType="lucideChevronRight" class="size-3.5" /></button>
          </div>
          <button type="button" class="mt-1 flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60" aria-expanded={expanded} aria-label="Details of the task for {nameOf(card, record)}" onclick={() => (open[rowKey] = !expanded)}>
            <span class="min-w-0 flex-1 truncate">{firstLine(card.report) || doing(card) || firstLine(card.task) || 'Waiting for the report…'}</span>
            {#if card.childId && needsApproval(card.childId)}<span class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">Approval</span>{/if}
          </button>
          {#if expanded}<div transition:slide={{ duration: 240 }} class="mt-2 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[0.6875rem]">
            {#if card.task}<div><div class="mb-0.5 font-medium text-foreground">Task</div><p class="m-0 max-h-40 overflow-auto leading-snug break-words whitespace-pre-wrap text-muted-foreground">{card.task}</p></div>{/if}
            <div><div class="mb-0.5 font-medium text-foreground">{card.state === 'done' ? 'Report' : 'Result'}</div>{#if card.report}<p class="m-0 max-h-72 overflow-auto leading-snug break-words whitespace-pre-wrap text-muted-foreground">{card.report}</p>{:else if live(card.state)}<p class="m-0 text-muted-foreground/70 italic">{card.state === 'queued' ? `Queued: at most ${MAX_WORKERS} workers run at once; it starts when one finishes.` : card.state === 'background' ? 'The report returns here when it is done.' : 'Waiting for the report…'}</p>{:else}<p class="m-0 text-muted-foreground/70 italic">No report</p>{/if}</div>
          </div>{/if}
        </div>
      </div>
    {/each}
  </div>
</div>
