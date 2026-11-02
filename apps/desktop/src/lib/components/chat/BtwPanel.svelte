<script lang="ts">
    import { ZButton } from '@shival99/z-ui-svelte';
    import { localMessages } from '../../chat/session/state.svelte';
    import { askText } from '../../chat/session/run.svelte';
    import { sideOf, dropSide } from '../../chat/session/btw.svelte';

    let { parentId }: { parentId: string } = $props();

    const side = $derived(sideOf(parentId));
    const answer = $derived(
        side
            ? (localMessages[side.id] ?? [])
                  .filter((message) => message.role === 'assistant')
                  .map(askText)
                  .filter(Boolean)
                  .join('\n\n')
            : '',
    );
</script>

<!-- A /btw side question: its answer sits above the input and never enters the chat's transcript. -->
{#if side}
    <div
        class="mb-2 flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm"
        role="status"
        aria-live="polite"
    >
        <div class="min-w-0 flex-1">
            <div class="text-xs text-muted-foreground">
                /btw · {side.side?.question ?? ''}
            </div>
            <div class="mt-1 whitespace-pre-wrap">
                {answer || 'Answering…'}
            </div>
        </div>
        <ZButton
            zWave={false}
            zType="default"
            zSize="sm"
            class="h-7 shrink-0 px-2 text-xs"
            onclick={() => dropSide(parentId)}>Close</ZButton
        >
    </div>
{/if}
