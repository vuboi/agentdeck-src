<script lang="ts">
    import { ZButton, ZIcon } from '@shival99/z-ui-svelte';
    import type {
        ZDropdownMenuItem,
        ZIconName,
        ZPopoverPosition,
    } from '@shival99/z-ui-svelte';
    import Menu from './Menu.svelte';
    import { TRIGGER_ON } from '../../app/ui/popover';

    // An icon button that opens a menu under it, lit while the menu is open.
    let {
        items,
        icon = 'lucideEllipsis',
        label,
        position = 'bottom-right',
        width = 220,
        class: className = 'size-7!',
        onopen,
        onprepare,
        hover = false,
        ontoggle,
    }: {
        items: ZDropdownMenuItem[];
        icon?: string;
        label: string;
        position?: ZPopoverPosition;
        width?: number;
        class?: string;
        /** Called as the menu opens. */ onopen?: () => void;
        /** Warm asynchronous menu data on pointer intent or keyboard focus. */ onprepare?: () => void;
        /** The menu opens while the pointer is on the button or the menu, and closes after it leaves both. */ hover?: boolean;
        /** With `hover`, a click on the button calls this instead of opening the menu. */ ontoggle?: () => void;
    } = $props();

    let anchor = $state<HTMLElement | null>(null);
    let open = $state(false);
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    function enter() {
        if (!hover) return;
        clearTimeout(leaveTimer);
        if (!open) {
            open = true;
            onopen?.();
        }
    }
    function leave() {
        if (!hover) return;
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => (open = false), 200);
    }
</script>

<ZButton
    bind:ref={anchor}
    zWave={false}
    zType="ghost"
    zSize="sm"
    class="{className} shrink-0 p-0 {open
        ? TRIGGER_ON
        : '!bg-transparent !text-muted-foreground hover:!bg-primary/10 hover:!text-primary'}"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    onpointerenter={() => {
        onprepare?.();
        enter();
    }}
    onpointerleave={leave}
    onfocus={() => onprepare?.()}
    onclick={() => {
        // A hover menu opens by the pointer only: a click does nothing, or calls `ontoggle`.
        if (hover) {
            if (!ontoggle) return;
            // The pointer already opened the menu on hover: the click closes it and toggles.
            clearTimeout(leaveTimer);
            open = false;
            ontoggle();
            return;
        }
        open = !open;
        if (open) onopen?.();
    }}
>
    <ZIcon zType={icon as ZIconName} class="size-4" />
</ZButton>

<Menu
    {items}
    bind:open
    {anchor}
    {position}
    {width}
    {label}
    onenter={hover ? () => clearTimeout(leaveTimer) : undefined}
    onleave={hover ? leave : undefined}
/>
