// How a change is drawn. One choice for every change view (the file view and the chat's changed-files list), kept
// across restarts. Icons are the names the z-ui icon set already uses in the app.
export const DIFF_STYLES = [
    { value: 'unified', label: 'Unified', icon: 'lucideRows3' },
    { value: 'split', label: 'Split side by side', icon: 'lucideColumns3' },
    { value: 'hunks', label: 'Hunk cards', icon: 'lucideLayers' },
    { value: 'stats', label: 'Stats list', icon: 'lucideChevronsUpDown' },
] as const;

export type DiffStyle = (typeof DIFF_STYLES)[number]['value'];

const KEY = 'agentdeck.diffStyle';

function load(): DiffStyle {
    try {
        const saved = globalThis.localStorage?.getItem(KEY);
        return DIFF_STYLES.some((style) => style.value === saved)
            ? (saved as DiffStyle)
            : 'unified';
    } catch {
        return 'unified';
    }
}

let current = $state<DiffStyle>(load());

export const diffStyle = {
    get value() {
        return current;
    },
    set(value: DiffStyle) {
        current = value;
        try {
            globalThis.localStorage?.setItem(KEY, value);
        } catch {
            // Storage is full or blocked: the style still changes for this session.
        }
    },
};
