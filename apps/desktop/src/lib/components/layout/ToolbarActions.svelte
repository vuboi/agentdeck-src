<script lang="ts">
    import { ZButton, ZIcon } from '@shival99/z-ui-svelte';
    import type { ZDropdownMenuItem, ZIconName } from '@shival99/z-ui-svelte';
    import {
        layout,
        toggleThemePanel,
        toggleTools,
    } from '../../app/ui/layout.svelte';
    import { terminal, toggleTerminal } from '../../terminal/terminal.svelte';
    import { workspace } from '../../chat/sessions.svelte';
    import {
        AGENTS_TOOL,
        childAgents,
        toggleAgentsPanel,
    } from '../../chat/runs/child-agents.svelte';
    import { isAway } from '../../app/ui/layout.svelte';
    import Menu from '../ui/Menu.svelte';

    // The divider only makes sense when other actions come before this group.
    let { divider = true }: { divider?: boolean } = $props();

    // The sub agents of the open chat: the button shows only while there are some.
    const agents = $derived(childAgents(workspace.activeId));
    const agentsRunning = $derived({
        total: agents.length,
        running: agents.filter((agent) => agent.state === 'running').length,
    });

    // On a narrow window the three actions fold into one menu button, like the other toolbars do.
    let narrow = $state(false);
    $effect(() => {
        const query = matchMedia('(max-width: 640px)');
        const update = () => (narrow = query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    });

    let trigger: HTMLElement | null = $state(null);
    let menuTrigger: HTMLElement | null = $state(null);
    let menuOpen = $state(false);
    // The theme popover is placed at the button that is on screen: the palette button, or the menu button when folded.
    $effect(() => {
        const element = narrow ? menuTrigger : trigger;
        layout.themeAnchor = element;
        return () => {
            if (layout.themeAnchor === element) layout.themeAnchor = null;
        };
    });

    const menuItems = $derived<ZDropdownMenuItem[]>([
        {
            label: terminal.open ? 'Hide terminal' : 'Show terminal',
            icon: 'lucideSquareTerminal',
            iconSize: '12',
            shortcut: 'Ctrl+`',
            class: 'text-sm! py-1',
            onClick: () => toggleTerminal(),
        },
        {
            label: 'Theme colors',
            icon: 'lucidePalette',
            iconSize: '12',
            class: 'text-sm! py-1',
            onClick: () => toggleThemePanel(),
        },
        {
            label: layout.toolsOpen ? 'Hide tools' : 'Show tools',
            icon: 'lucidePanelRight',
            iconSize: '12',
            class: 'text-sm! py-1',
            onClick: () => toggleTools(),
        },
    ]);
</script>

<div class="flex shrink-0 items-center gap-1">
    {#if divider}
        <!-- Short divider: separates the preceding actions from terminal + palette + collapse. -->
        <span class="mx-1.5 h-4 w-px bg-border" aria-hidden="true"></span>
    {/if}
    {#if narrow}
        <ZButton
            bind:ref={menuTrigger}
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-8! {menuOpen
                ? '!bg-primary/15 !text-primary hover:!bg-primary/20 hover:!text-primary'
                : '!bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary'}"
            aria-label="Panels and terminal"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onclick={() => (menuOpen = !menuOpen)}
        >
            <ZIcon zType={'lucideMenu' as ZIconName} class="size-4" />
        </ZButton>
        <Menu
            items={menuItems}
            bind:open={menuOpen}
            anchor={menuTrigger}
            position="bottom-right"
            width={220}
            label="Panels and terminal"
        />
    {:else}
        {#if agentsRunning.total > 0}
            <ZButton
                zWave={false}
                zType="ghost"
                zSize="sm"
                zIconOnly={true}
                class="size-8! [&>.z-button-content]:!overflow-visible {layout.toolsOpen &&
                layout.activeTool === AGENTS_TOOL
                    ? '!bg-primary/15 !text-primary hover:!bg-primary/20 hover:!text-primary'
                    : '!bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary'}"
                aria-label="Sub agents"
                aria-pressed={layout.toolsOpen &&
                    layout.activeTool === AGENTS_TOOL &&
                    !isAway(AGENTS_TOOL)}
                title="Sub agents ({agentsRunning.running} running of {agentsRunning.total})"
                onclick={toggleAgentsPanel}
            >
                <span class="relative flex">
                    <ZIcon zType={'lucideBot' as ZIconName} class="size-4" />
                    <!-- The badge counts every sub agent of the chat, running or finished. -->
                    <span
                        class="absolute -top-2 -right-2 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] leading-none font-medium text-primary-foreground tabular-nums"
                        >{agentsRunning.total}</span
                    >
                </span>
            </ZButton>
        {/if}
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-8! {terminal.open
                ? '!bg-primary/15 !text-primary hover:!bg-primary/20 hover:!text-primary'
                : '!bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary'}"
            aria-label={terminal.open ? 'Hide terminal' : 'Show terminal'}
            aria-pressed={terminal.open}
            title={terminal.open
                ? 'Hide terminal (Ctrl+`)'
                : 'Show terminal (Ctrl+`)'}
            onclick={toggleTerminal}
        >
            <ZIcon zType="lucideSquareTerminal" class="size-4" />
        </ZButton>
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-8! {layout.themePanelOpen
                ? '!bg-primary/15 !text-primary hover:!bg-primary/20 hover:!text-primary'
                : '!bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary'}"
            id="theme-trigger"
            bind:ref={trigger}
            aria-label="Theme colors"
            aria-haspopup="dialog"
            aria-expanded={layout.themePanelOpen}
            title="Theme colors"
            onclick={toggleThemePanel}
        >
            <ZIcon zType="lucidePalette" class="size-4" />
        </ZButton>
        <ZButton
            zWave={false}
            zType="ghost"
            zSize="sm"
            class="size-8! !bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary"
            aria-label={layout.toolsOpen
                ? 'Hide tools panel'
                : 'Show tools panel'}
            title={layout.toolsOpen ? 'Hide tools' : 'Show tools'}
            onclick={toggleTools}
        >
            <ZIcon zType="lucidePanelRight" class="size-4" />
        </ZButton>
    {/if}
</div>
