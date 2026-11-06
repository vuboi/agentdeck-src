<script lang="ts">
    import { tick } from 'svelte';
    import {
        ZIcon,
        ZPopover,
        ZSelect,
        ZSlider,
        ZTabs,
    } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
    import { layout } from '../../app/ui/layout.svelte';
    import {
        MONO_FONTS,
        SANS_FONTS,
        theme,
        UI_FONT_SIZE,
        type MonoFont,
        type SansFont,
    } from '../../app/ui/theme.svelte';
    import SectionTitle from '../ui/SectionTitle.svelte';
    import {
        DARK_STYLES,
        LIGHT_STYLES,
        NEUTRALS,
        PRIMARIES,
        swatch,
        type DarkStyle,
        type LightStyle,
        type Mode,
    } from '../../app/ui/theme-tokens';
    import type { ChatLayout } from '../../app/ui/theme.svelte';

    const layouts = [
        {
            value: 'split',
            label: 'Both sides',
            icon: 'lucideColumns3' as ZIconName,
        },
        {
            value: 'single',
            label: 'One side',
            icon: 'lucideSquare' as ZIconName,
        },
    ];

    const modes = [
        { value: 'light', label: 'Light', icon: 'lucideSun' as ZIconName },
        { value: 'dark', label: 'Dark', icon: 'lucideMoon' as ZIconName },
        {
            value: 'system',
            label: 'System',
            icon: 'lucideMonitor' as ZIconName,
        },
    ];

    // The popover scales in; tabs measured during that are off-centre. They are drawn again once it has settled.
    let settled = $state(false);
    $effect(() => {
        if (!layout.themePanelOpen) {
            settled = false;
            return;
        }
        const timer = setTimeout(() => (settled = true), 280);
        return () => clearTimeout(timer);
    });

    // ZPopover owns outside click, Escape and the enter/exit animation. Focus enters the panel on open
    // and goes back to the trigger when it closes.
    function focusPanel() {
        void tick().then(() =>
            document
                .querySelector<HTMLElement>('[data-theme-panel] button')
                ?.focus(),
        );
    }
</script>

<ZPopover
    anchor={layout.themeAnchor}
    bind:open={layout.themePanelOpen}
    zTrigger="manual"
    zPosition="bottom-right"
    zOffset={6}
    zWidth={280}
    onOpen={focusPanel}
    onClosed={() => document.getElementById('theme-trigger')?.focus()}
>
    <div data-theme-panel class="flex w-full flex-col gap-4 p-3">
        <div>
            {#key settled}
                <ZTabs
                    zTabs={modes}
                    zType="segmented"
                    zSize="sm"
                    zTabsOnly
                    zNavFullWidth
                    class="w-full [&_.z-tab-item]:flex-1 [&_.z-tab-item-label]:text-center"
                    zCache={false}
                    activeTab={theme.mode}
                    onTabChange={(value) => (theme.mode = value as Mode)}
                />
            {/key}
        </div>

        <div>
            <SectionTitle label="PRIMARY" />
            <div
                class="grid grid-cols-9 justify-items-center gap-y-3"
                role="radiogroup"
                aria-label="Primary color"
            >
                {#each PRIMARIES as color (color)}
                    <button
                        type="button"
                        role="radio"
                        aria-checked={theme.primary === color}
                        aria-label={color}
                        title={color}
                        class="swatch relative grid size-5 cursor-pointer place-items-center rounded-[2px] outline-none ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring {theme.primary ===
                        color
                            ? 'swatch-selected'
                            : ''}"
                        style:background={swatch(color)}
                        style:--halo={swatch(color)}
                        onclick={() => (theme.primary = color)}
                    >
                        {#if theme.primary === color}<ZIcon
                                zType="lucideCheck"
                                class="size-3 text-white mix-blend-difference"
                            />{/if}
                    </button>
                {/each}
            </div>
        </div>

        <div>
            <SectionTitle label="NEUTRAL" />
            <div
                class="grid grid-cols-9 justify-items-center gap-y-3"
                role="radiogroup"
                aria-label="Neutral color"
            >
                {#each NEUTRALS as color (color)}
                    <button
                        type="button"
                        role="radio"
                        aria-checked={theme.neutral === color}
                        aria-label={color}
                        title={color}
                        class="swatch relative grid size-5 cursor-pointer place-items-center rounded-[2px] outline-none ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring {theme.neutral ===
                        color
                            ? 'swatch-selected'
                            : ''}"
                        style:background={swatch(color)}
                        style:--halo={swatch(color)}
                        onclick={() => {
                            theme.neutral = color;
                            // A surface picked for this mode would hide the neutral: picking a neutral returns to that mode's default surface.
                            if (theme.dark) theme.darkStyle = 'charcoal';
                            else theme.lightStyle = 'white';
                        }}
                    >
                        {#if theme.neutral === color}<ZIcon
                                zType="lucideCheck"
                                class="size-3 text-white mix-blend-difference"
                            />{/if}
                    </button>
                {/each}
            </div>
        </div>

        <div>
            <SectionTitle label="SURFACE" />
            <div
                class="grid grid-cols-7 justify-items-center gap-y-3"
                role="radiogroup"
                aria-label="Surface"
            >
                {#each [...LIGHT_STYLES.map( (style) => ({ ...style, dark: false }) ), ...DARK_STYLES.map( (style) => ({ ...style, dark: true }) )] as style (`${style.dark ? 'dark' : 'light'}-${style.value}`)}
                    {@const active = theme.dark === style.dark}
                    {@const picked =
                        active &&
                        (theme.dark ? theme.darkStyle : theme.lightStyle) ===
                            style.value}
                    <button
                        type="button"
                        role="radio"
                        disabled={!active}
                        aria-checked={picked}
                        aria-label={style.label}
                        title={active
                            ? style.label
                            : `${style.label} (${style.dark ? 'dark' : 'light'} mode only)`}
                        class="swatch relative grid size-5 cursor-pointer place-items-center rounded-[2px] border border-border outline-none ring-offset-2 ring-offset-popover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 {picked
                            ? 'swatch-selected'
                            : ''}"
                        style:background={style.swatch}
                        style:--halo={style.swatch}
                        onclick={() =>
                            theme.dark
                                ? (theme.darkStyle = style.value as DarkStyle)
                                : (theme.lightStyle =
                                      style.value as LightStyle)}
                    >
                        {#if picked}<ZIcon
                                zType="lucideCheck"
                                class="size-3 text-white mix-blend-difference"
                            />{/if}
                    </button>
                {/each}
            </div>
        </div>

        <div>
            <SectionTitle label="TEXT SIZE" />
            <div class="flex items-center gap-3 text-sm">
                <ZSlider
                    zMin={UI_FONT_SIZE.min}
                    zMax={UI_FONT_SIZE.max}
                    zStep={UI_FONT_SIZE.step}
                    zType="dot"
                    zSize="sm"
                    class="min-w-0 flex-1"
                    bind:value={theme.uiFontSize}
                />
                <span class="w-10 text-right tabular-nums text-muted-foreground"
                    >{theme.uiFontSize}px</span
                >
                <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground"
                    onclick={() => (theme.uiFontSize = UI_FONT_SIZE.default)}
                    >Reset</button
                >
            </div>
        </div>

        <div>
            <SectionTitle label="UI FONT" />
            <ZSelect
                class="w-full"
                zSize="sm"
                zOptions={SANS_FONTS.map((font) => ({
                    label: font.label,
                    value: font.value,
                }))}
                value={theme.uiFont}
                onValueChange={(value) =>
                    (theme.uiFont = String(value) as SansFont)}
            />
        </div>

        <div>
            <SectionTitle label="CODE FONT" />
            <ZSelect
                class="w-full"
                zSize="sm"
                zOptions={MONO_FONTS.map((font) => ({
                    label: font.label,
                    value: font.value,
                }))}
                value={theme.codeFont}
                onValueChange={(value) =>
                    (theme.codeFont = String(value) as MonoFont)}
            />
        </div>

        <div>
            <SectionTitle label="CHAT LAYOUT" />
            {#key settled}
                <ZTabs
                    zTabs={layouts}
                    zType="segmented"
                    zSize="sm"
                    zTabsOnly
                    zNavFullWidth
                    class="w-full [&_.z-tab-item]:flex-1 [&_.z-tab-item-label]:text-center"
                    zCache={false}
                    activeTab={theme.chatLayout}
                    onTabChange={(value) =>
                        (theme.chatLayout = value as ChatLayout)}
                />
            {/key}
        </div>
    </div>
</ZPopover>

<style>
    /* Selected swatch: one soft halo in its own colour, same idea as the z-toast status halo. Static, no animation. */
    .swatch-selected {
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--halo) 40%, transparent);
    }
</style>
