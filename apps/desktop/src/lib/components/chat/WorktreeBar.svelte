<script lang="ts">
    import { invoke } from '@tauri-apps/api/core';
    import { activeSession } from '../../chat/session/state.svelte';
    import {
        finishWorktree,
        syncWorktree,
        type WorktreeStatus,
    } from '../../chat/session/worktree-actions';

    // The worktree of the open chat: its branch, how far it has moved from its base, and what to do with it.
    const session = $derived(activeSession());
    const wt = $derived(session?.worktree);
    const busy = $derived(session?.status === 'working');
    let status = $state<WorktreeStatus | null>(null);

    async function refresh(path: string, base: string) {
        try {
            status = await invoke<WorktreeStatus>('worktree_status', {
                path,
                base,
            });
        } catch {
            status = null;
        }
    }
    // Read again when the worktree changes or the agent stops working, since a turn may have committed.
    $effect(() => {
        if (!wt) {
            status = null;
            return;
        }
        void busy;
        void refresh(wt.path, wt.base);
    });

    async function update(id: string) {
        await syncWorktree(id);
        if (wt) await refresh(wt.path, wt.base);
    }
</script>

{#if session && wt}
    <div
        class="flex h-8 shrink-0 items-center gap-3 border-b border-border px-4 text-xs text-muted-foreground"
        aria-label="Worktree"
    >
        <span class="min-w-0 truncate text-foreground" title={wt.path}
            >{wt.branch}</span
        >
        <span class="shrink-0">from {wt.base}</span>
        {#if status}
            <span class="shrink-0"
                >{status.ahead} ahead, {status.behind} behind{status.dirtyFiles >
                0
                    ? `, ${status.dirtyFiles} changed`
                    : ''}</span
            >
        {/if}
        <span class="flex-1"></span>
        <button
            type="button"
            class="shrink-0 cursor-pointer px-2 text-xs text-muted-foreground outline-none transition-colors hover:text-primary disabled:opacity-40"
            disabled={busy}
            title="Bring the base branch into this worktree"
            onclick={() => update(session.id)}>Update from base</button
        >
        <button
            type="button"
            class="shrink-0 cursor-pointer px-2 text-xs text-muted-foreground outline-none transition-colors hover:text-primary disabled:opacity-40"
            disabled={busy}
            title="Merge this branch into {wt.base}, then remove the worktree"
            onclick={() => finishWorktree(session.id, true)}>Merge</button
        >
        <button
            type="button"
            class="shrink-0 cursor-pointer px-2 text-xs text-muted-foreground outline-none transition-colors hover:text-destructive disabled:opacity-40"
            disabled={busy}
            title="Discard this worktree and its branch"
            onclick={() => finishWorktree(session.id, false)}>Discard</button
        >
    </div>
{/if}
