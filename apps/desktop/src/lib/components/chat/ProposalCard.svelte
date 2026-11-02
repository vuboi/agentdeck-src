<script lang="ts">
    import { ZButton } from '@shival99/z-ui-svelte';
    import type { CommandBlock } from '../../chat/content/blocks';
    import {
        cardActions,
        checkProposal,
        proposalOfCommand,
    } from '../../tasks/propose';
    import {
        chatProposal,
        dismissProposal,
        splitProposal,
    } from '../../chat/session/proposal.svelte';

    // A propose_session call: the split the agent suggests, its tasks, and whether they can run at once. The choice made on
    // the card is kept in the call's block (`item.proposal`), so it stays with the reply.
    let { item, sessionId }: { item: CommandBlock; sessionId: string } =
        $props();
    const read = $derived(proposalOfCommand(item.command));
    const check = $derived(read.ok ? checkProposal(read.proposal) : null);
    const actions = $derived(check ? cardActions(check, item.proposal) : null);
</script>

{#if read.ok && check && actions?.visible}
    <div
        class="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-sm"
    >
        <div class="font-medium">{read.proposal.title}</div>
        <ul class="mt-1.5 flex flex-col gap-1.5">
            {#each read.proposal.tasks as task, index (index)}
                {@const mode = check.tasks[index]}
                <li class="flex items-start gap-2">
                    <span class="min-w-0 flex-1">
                        <span class="font-medium">{task.title}</span>
                        <span
                            class="block truncate text-xs text-muted-foreground"
                            title={task.writeScope.join(', ')}
                            >{task.writeScope.join(', ')}</span
                        >
                    </span>
                    <span
                        class="shrink-0 rounded px-1.5 py-px text-[0.6875rem] {mode.mode ===
                        'parallel'
                            ? 'bg-success/15 text-success'
                            : 'bg-muted text-muted-foreground'}"
                        title={mode.why.join('; ')}>{mode.mode}</span
                    >
                </li>
            {/each}
        </ul>
        {#if item.proposal?.state === 'split'}
            <p class="mt-2 text-xs text-muted-foreground">
                Started one worktree per task.
            </p>
        {:else if item.proposal?.state === 'chat'}
            <p class="mt-2 text-xs text-muted-foreground">
                Doing it in this chat.
            </p>
        {/if}
        {#if item.proposal?.note}
            <p class="mt-2 text-xs text-destructive">{item.proposal.note}</p>
        {/if}
        {#if actions.chat}
            {#if !check.parallel}
                <p class="mt-2 text-xs text-muted-foreground">
                    Some tasks overlap or depend on each other, so they cannot
                    run side by side: split is off, do it in this chat.
                </p>
            {/if}
            <div class="mt-2.5 flex flex-wrap gap-2">
                <ZButton
                    zWave={false}
                    zSize="sm"
                    type="button"
                    disabled={!actions.split}
                    onclick={() => splitProposal(sessionId, item)}
                >
                    Split into worktrees
                </ZButton>
                <ZButton
                    zWave={false}
                    zType="outline"
                    zSize="sm"
                    type="button"
                    onclick={() => chatProposal(sessionId, item)}
                >
                    Do it in this chat
                </ZButton>
                <ZButton
                    zWave={false}
                    zType="ghost"
                    zSize="sm"
                    type="button"
                    onclick={() => dismissProposal(item)}
                >
                    Dismiss
                </ZButton>
            </div>
        {/if}
    </div>
{/if}
