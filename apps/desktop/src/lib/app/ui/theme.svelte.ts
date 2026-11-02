import {
    neutralTokens,
    primaryTokens,
    radiusTokens,
    type Mode,
    type Neutral,
    type Primary,
} from './theme-tokens';
import { logFlow } from '../../tasks/flow-log';
import { inTauri } from '../platform/history';

const KEY = 'agentdeck.theme';
export type ChatLayout = 'split' | 'single';
/** The text size of the whole app, in px: the root size every rem (Tailwind's text sizes) follows. */
export const UI_FONT_SIZE = { min: 11, max: 20, step: 1, default: 16 } as const;
type Saved = {
    primary: Primary;
    neutral: Neutral;
    mode: Mode;
    chatLayout: ChatLayout;
    turnDividers: boolean;
    fontSize: number;
};
const DEFAULTS: Saved = {
    primary: 'violet',
    neutral: 'zinc',
    mode: 'dark',
    chatLayout: 'split',
    turnDividers: true,
    fontSize: UI_FONT_SIZE.default,
};
// The corner radii live in app.css (--radius-small / --radius-large). `--radius` itself is what z-ui falls back to when
// something reads it directly: the large size.
const RADIUS = 0.375;

/** Captures the active theme and representative surfaces for diagnosing partial theme updates. */
function themeSnapshot(phase: string): string {
    const root = document.documentElement;
    const backgroundOf = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? getComputedStyle(element).backgroundColor : 'missing';
    };
    return JSON.stringify({
        phase,
        mode: theme.mode,
        dark: theme.dark,
        htmlDark: root.classList.contains('dark'),
        scheme: root.style.colorScheme,
        token: getComputedStyle(root).getPropertyValue('--background').trim(),
        html: getComputedStyle(root).backgroundColor,
        body: document.body
            ? getComputedStyle(document.body).backgroundColor
            : 'missing',
        surface: backgroundOf('.bg-background'),
        card: backgroundOf('.bg-card'),
        popover: backgroundOf('.bg-popover'),
        // Elements painted with a hole (page-layer.ts): a hole keeps the colour it was cut in until it is cut again.
        holes: document.querySelectorAll('[style*="no-repeat"]').length,
        visible: document.visibilityState,
    });
}

function read(): Saved {
    try {
        return {
            ...DEFAULTS,
            ...(JSON.parse(
                localStorage.getItem(KEY) ?? '{}',
            ) as Partial<Saved>),
        };
    } catch {
        return { ...DEFAULTS };
    }
}

const initial = read();
const media = matchMedia('(prefers-color-scheme: dark)');
/** The dark flag the Rust side was last told (null: not told yet). */
let previewDark: boolean | null = null;

/** The Preview's blank colour and its error page follow the app's theme. */
function tellPreview(dark: boolean) {
    if (!inTauri()) return;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('browser_theme', { dark }))
        .catch(() => {});
}

/** Theme state. Tokens are applied inline on <html>, so they win over the stylesheet's z-theme layer. */
class Theme {
    primary = $state(initial.primary);
    neutral = $state(initial.neutral);
    readonly radius = RADIUS;
    mode = $state(initial.mode);
    /** `split`: your messages on the right, the agent on the left. `single`: everything on the left. */
    chatLayout = $state(initial.chatLayout);
    /** A thin line between two replies of the agent, and a line where a session was resumed or compacted (on by default). */
    turnDividers = $state(initial.turnDividers);
    /** The app's text size in px (see UI_FONT_SIZE). */
    uiFontSize = $state(
        Math.min(
            UI_FONT_SIZE.max,
            Math.max(UI_FONT_SIZE.min, initial.fontSize),
        ),
    );
    private systemDark = $state(media.matches);

    readonly dark = $derived(
        this.mode === 'system' ? this.systemDark : this.mode === 'dark',
    );
    /**
     * The theme as heavy views (the chat's rows) should see it: updated synchronously with the CSS tokens so the
     * virtual list rebuilds in the same frame that already carries the new dark class — no half-painted flash.
     */
    settledKey = $state('');
    private readonly tokens = $derived({
        ...neutralTokens(this.neutral, this.dark),
        ...primaryTokens(this.primary, this.dark),
        ...radiusTokens(this.radius),
    });

    constructor() {
        media.addEventListener(
            'change',
            (event) => (this.systemDark = event.matches),
        );
        this.settledKey = this.keyNow();
        let unfreeze = 0;
        const logThemeSnapshot = (phase: string) =>
            logFlow('-', 'theme snapshot', themeSnapshot(phase));
        // Catch another page subsystem overwriting the global theme class or tokens after startup.
        new MutationObserver(() => {
            const root = document.documentElement;
            const mismatch =
                root.classList.contains('dark') !== this.dark ||
                Object.entries(this.tokens).some(
                    ([name, value]) =>
                        root.style.getPropertyValue(name) !== value,
                );
            if (mismatch) logThemeSnapshot('root drift');
        }).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
        });
        // App-lifetime singleton: the root effect is never torn down.
        $effect.root(() => {
            $effect(() => {
                const root = document.documentElement;
                const key = this.keyNow();
                const changed = key !== this.settledKey;
                // During a theme swap nothing animates: thousands of `transition-colors` elements easing at once on a busy
                // page is what left the window half in the old theme and half in the new one.
                if (changed) {
                    logThemeSnapshot('before apply');
                    root.classList.add('theme-switching');
                    cancelAnimationFrame(unfreeze);
                }
                root.classList.toggle('dark', this.dark);
                root.style.colorScheme = this.dark ? 'dark' : 'light';
                document
                    .querySelector('meta[name="theme-color"]')
                    ?.setAttribute(
                        'content',
                        this.dark ? '#0a0a0a' : '#ffffff',
                    );
                root.style.fontSize = `${this.uiFontSize}px`;
                for (const [name, value] of Object.entries(this.tokens))
                    root.style.setProperty(name, value, 'important');
                if (changed) {
                    // settledKey is updated synchronously so {#key settledKey} in Chat.svelte recreates the virtual-list rows
                    // in the same Svelte flush that already has the new dark class and CSS tokens — no half-painted frame.
                    // Only removing theme-switching (re-enabling transitions) is deferred: one rAF lets the browser commit the
                    // new colours first, so transitions start from the new baseline and never ease across the old→new gap.
                    this.settledKey = key;
                    logFlow('-', 'theme applied', themeSnapshot('applied'));
                    unfreeze = requestAnimationFrame(() => {
                        logThemeSnapshot('next frame');
                        root.classList.remove('theme-switching');
                    });
                }
                if (this.dark !== previewDark) {
                    previewDark = this.dark;
                    tellPreview(this.dark);
                }
                try {
                    const saved: Saved = {
                        primary: this.primary,
                        neutral: this.neutral,
                        mode: this.mode,
                        chatLayout: this.chatLayout,
                        turnDividers: this.turnDividers,
                        fontSize: this.uiFontSize,
                    };
                    localStorage.setItem(KEY, JSON.stringify(saved));
                } catch {
                    // Persisting is best-effort.
                }
            });
        });
    }

    private keyNow() {
        return `${this.dark}|${this.primary}|${this.neutral}`;
    }

    toggle() {
        this.mode = this.dark ? 'light' : 'dark';
    }
}

export const theme = new Theme();
