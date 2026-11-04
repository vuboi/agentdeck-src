<script lang="ts">
    import { ZButton } from '@shival99/z-ui-svelte';
    import { ledgerConflicts } from '../../chat/runs/change-ledger.svelte';
    import {
        dismissConflict,
        restoreOverwritten,
    } from '../../chat/runs/restore';
    import { workspace } from '../../chat/sessions.svelte';
    import { projectOf } from '../../chat/session/state.svelte';
    import { toast } from '../../app/platform/toast';
    import { pendingNotices } from '../../chat/runs/notices.svelte';

    // Changes one run overwrote with an older request's text (plan 6.5): shown above the composer, where the user
    // reads next, with a way back. Only the conflicts of the chat on screen.
    const mine = $derived(
        ledgerConflicts.filter(
            (conflict) => conflict.writer.sessionId === workspace.activeId,
        ),
    );
    const root = $derived.by(() => {
        const session = workspace.sessions.find(
            (item) => item.id === workspace.activeId,
        );
        return (session && projectOf(session)?.path) || '';
    });
    const laneName = (lane: string) =>
        lane === 'listener' ? 'side run' : lane;

    async function restore(conflict: (typeof mine)[number]) {
        const result = await restoreOverwritten(root, conflict);
        if (result === 'restored') toast.success(`Restored ${conflict.path}`);
        else if (result === 'changed')
            toast.error(`${conflict.path} was edited again: not restored`);
        else if (result === 'unavailable')
            toast.error(`${conflict.path} is too large to restore here`);
        else toast.error(`Could not restore ${conflict.path}`);
    }
</script>

{#if (pendingNotices[workspace.activeId]?.length ?? 0) > 0}
    <!-- Notices a run could not take mid-turn: they go out with the chat's next message (plan 6.6). -->
    <div class="mb-2 text-sm text-muted-foreground" role="status">
        Will tell the next turn about {pendingNotices[workspace.activeId]
            .length}
        change{pendingNotices[workspace.activeId].length === 1 ? '' : 's'} from other
        runs.
    </div>
{/if}
{#each mine as conflict (conflict)}
    <div
        class="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm"
        role="status"
    >
        <span class="min-w-0 truncate">
            <span class="font-medium">{conflict.path}</span>
            <span class="text-muted-foreground">
                {conflict.kind === 'revert'
                    ? `was reverted by the ${laneName(conflict.writer.lane)}`
                    : `was overwritten by the ${laneName(conflict.writer.lane)}`}
                , which holds an older request
            </span>
        </span>
        <span class="ml-auto flex shrink-0 items-center gap-2">
            <ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class="h-7 px-3 text-sm"
                onclick={() => restore(conflict)}
            >
                Restore {laneName(conflict.over.run.lane)}'s change
            </ZButton>
            <ZButton
                zWave={false}
                zType="secondary"
                zSize="sm"
                class="h-7 px-3 text-sm"
                onclick={() => dismissConflict(conflict)}
            >
                Keep this
            </ZButton>
        </span>
    </div>
{/each}
