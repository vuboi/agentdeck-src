<script lang="ts">
    import type { ZDropdownMenuItem, ZIconName } from '@shival99/z-ui-svelte';
    import MenuButton from '../ui/MenuButton.svelte';
    import { DIFF_STYLES, diffStyle } from '../../files/diff-style.svelte';

    // One button for the change view's style: its icon is the current style, its menu lists the others.
    const current = $derived(
        DIFF_STYLES.find((style) => style.value === diffStyle.value),
    );
    const items = $derived<ZDropdownMenuItem[]>(
        DIFF_STYLES.map((style) => ({
            label: style.label,
            icon: style.icon as ZIconName,
            iconSize: 12,
            class: 'text-sm! py-1',
            checked: diffStyle.value === style.value,
            onClick: () => diffStyle.set(style.value),
        })),
    );
</script>

<MenuButton
    {items}
    icon={current?.icon ?? 'lucideRows3'}
    label="Change view style"
    width={200}
/>
