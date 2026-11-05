<script lang="ts">
    import { ZIcon } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
    import type { CommandBlock } from '../../chat/content/blocks';
    import { argOf } from '../../chat/content/blocks';
    import { layout } from '../../app/ui/layout.svelte';
    import { workspace, sessionCwd } from '../../chat/sessions.svelte';
    import { selectArtifact } from '../../canvas/canvas.svelte';

    let { item, sessionId }: { item: CommandBlock; sessionId: string } =
        $props();
    const args = $derived.by(() => {
        try {
            return JSON.parse(argOf(item.command)) as Record<string, unknown>;
        } catch {
            return {};
        }
    });
    const id = $derived(
        String(args.id ?? item.output.match(/\b(a-[a-z0-9-]+)\b/)?.[1] ?? ''),
    );
    const version = $derived(Number(item.output.match(/\bv(\d+)\b/)?.[1] ?? 1));
    const title = $derived(String((args.title ?? id) || 'Artifact'));
    const kind = $derived(String(args.kind ?? 'code'));
    const icon = $derived(
        (kind === 'html'
            ? 'lucideCode'
            : kind === 'markdown'
              ? 'lucideFileText'
              : kind === 'svg'
                ? 'lucideImage'
                : 'lucideCode') as ZIconName,
    );
    function open() {
        const session = workspace.sessions.find(
            (candidate) => candidate.id === sessionId,
        );
        const root = session && sessionCwd(session);
        if (!root || !id) return;
        selectArtifact(root, id, version);
        layout.activeTool = 'Canvas';
    }
</script>

<button
    type="button"
    class="flex w-full items-center gap-2 border border-border px-3 py-2 text-left text-sm hover:bg-muted/40"
    onclick={open}
    aria-label={`Open ${title} in Canvas`}
>
    <ZIcon zType={icon} class="size-4 shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate font-medium">{title}</span>
    <span class="shrink-0 text-xs text-muted-foreground">v{version}</span>
</button>
