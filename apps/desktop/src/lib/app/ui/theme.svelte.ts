import { SvelteMap } from 'svelte/reactivity';
import {
    neutralTokens,
    primaryTokens,
    radiusTokens,
    type Mode,
    type Neutral,
    type Primary,
} from './theme-tokens';
import { logFlow } from '../../tasks/flow-log';

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
        visible: document.visibilityState,
    });
}

/** Records rendered colour styles across the page without writing user-visible text into the debug log. */
function logThemeUiAudit(phase: string) {
    const groups = new SvelteMap<
        string,
        {
            count: number;
            bg: string;
            fg: string;
            border: string;
            fill: string;
            stroke: string;
            tokens: string;
            samples: string[];
        }
    >();
    let inspected = 0;
    let styled = 0;
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
        if (element.getClientRects().length === 0) continue;
        inspected += 1;
        const classes = [...element.classList];
        const colorClasses = classes.filter((name) =>
            /^(?:dark:)?(?:bg|text|border|ring|outline|fill|stroke)-/.test(
                name,
            ),
        );
        const inlineStyle = element.getAttribute('style') ?? '';
        if (
            !colorClasses.length &&
            !/(?:color|background|border|outline|fill|stroke):/i.test(
                inlineStyle,
            )
        )
            continue;
        styled += 1;
        const style = getComputedStyle(element);
        const bg = style.backgroundColor;
        const fg = style.color;
        const border = style.borderTopColor;
        const fill = style.fill;
        const stroke = style.stroke;
        const tokens = colorClasses
            .filter((name) =>
                /^(?:dark:)?(?:bg|text|border|ring|outline|fill|stroke)-(?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|sidebar|input|border|ring)(?:-|\/|$)/.test(
                    name,
                ),
            )
            .sort()
            .join(' ');
        const key = `${bg}|${fg}|${border}|${fill}|${stroke}|${style.opacity}|${tokens}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                count: 0,
                bg,
                fg,
                border,
                fill,
                stroke,
                tokens,
                samples: [],
            };
            groups.set(key, group);
        }
        group.count += 1;
        if (group.samples.length < 2) {
            const identity = [
                element.tagName.toLowerCase(),
                element.id ? `#${element.id}` : '',
                element.getAttribute('role')
                    ? `[role=${element.getAttribute('role')}]`
                    : '',
                element.getAttribute('data-testid')
                    ? `[testid=${element.getAttribute('data-testid')}]`
                    : '',
            ]
                .join('')
                .slice(0, 44);
            const classesForLog = colorClasses
                .slice(0, 4)
                .join(' ')
                .slice(0, 28);
            group.samples.push(`${identity}{${classesForLog}}`);
        }
    }

    const entries = [...groups.values()];
    const limit = 240;
    logFlow(
        '-',
        'theme ui audit',
        JSON.stringify({
            phase,
            inspected,
            styled,
            groups: entries.length,
            recorded: Math.min(entries.length, limit),
        }),
    );
    for (const [index, group] of entries.slice(0, limit).entries()) {
        logFlow(
            '-',
            'theme ui style',
            JSON.stringify({
                i: index,
                n: group.count,
                bg: group.bg,
                fg: group.fg,
                border: group.border,
                fill: group.fill,
                stroke: group.stroke,
                tokens: group.tokens.slice(0, 32),
                samples: group.samples,
            }),
        );
    }
    if (entries.length > limit)
        logFlow(
            '-',
            'theme ui audit truncated',
            `phase=${phase} omitted=${entries.length - limit}`,
        );
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
        let resumeCheck = 0;
        const logThemeSnapshot = (phase: string) =>
            logFlow('-', 'theme snapshot', themeSnapshot(phase));
        const scheduleResumeSnapshot = (phase: string) => {
            window.clearTimeout(resumeCheck);
            resumeCheck = window.setTimeout(() => {
                logThemeSnapshot(phase);
                if (typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(() => logThemeUiAudit(phase), {
                        timeout: 1500,
                    });
                } else {
                    window.setTimeout(() => logThemeUiAudit(phase), 250);
                }
            }, 150);
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible')
                scheduleResumeSnapshot('visible');
        });
        window.addEventListener('focus', () => scheduleResumeSnapshot('focus'));
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
                        if (typeof window.requestIdleCallback === 'function') {
                            window.requestIdleCallback(
                                () => logThemeUiAudit('settled'),
                                { timeout: 1500 },
                            );
                        } else {
                            window.setTimeout(
                                () => logThemeUiAudit('settled'),
                                250,
                            );
                        }
                    });
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
