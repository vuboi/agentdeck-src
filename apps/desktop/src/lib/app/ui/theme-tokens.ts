// Ported from the z-ui Svelte demo theme customizer: palette -> CSS variable tokens.
export type Primary =
    | 'black'
    | 'red'
    | 'orange'
    | 'amber'
    | 'yellow'
    | 'lime'
    | 'green'
    | 'emerald'
    | 'teal'
    | 'cyan'
    | 'sky'
    | 'blue'
    | 'indigo'
    | 'violet'
    | 'purple'
    | 'fuchsia'
    | 'pink'
    | 'rose';
export type Neutral = 'slate' | 'gray' | 'zinc' | 'neutral' | 'stone';
export type Mode = 'light' | 'dark' | 'system';

export const PRIMARIES: Primary[] = [
    'black',
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
];
export const NEUTRALS: Neutral[] = [
    'slate',
    'gray',
    'zinc',
    'neutral',
    'stone',
];
export const RADII = [0, 0.125, 0.25, 0.375, 0.5];

const NEAR_WHITE = 'oklch(0.985 0 0)';
const PURE_WHITE = 'oklch(1 0 0)';
const shade = (neutral: Neutral, step: number) =>
    `var(--color-${neutral}-${step})`;
// Hairline dividers: softer than the raw palette step.
const hairline = (value: string) =>
    `color-mix(in oklab, ${value} 65%, transparent)`;

export function neutralTokens(
    neutral: Neutral,
    dark: boolean,
): Record<string, string> {
    if (!dark) {
        return {
            '--background': PURE_WHITE,
            '--foreground': shade(neutral, 950),
            '--card': PURE_WHITE,
            '--card-foreground': shade(neutral, 950),
            '--popover': PURE_WHITE,
            '--popover-foreground': shade(neutral, 950),
            '--secondary': shade(neutral, 100),
            '--secondary-foreground': shade(neutral, 900),
            '--muted': shade(neutral, 100),
            '--muted-foreground': shade(neutral, 500),
            '--accent': shade(neutral, 100),
            '--accent-foreground': shade(neutral, 900),
            '--border': hairline(shade(neutral, 200)),
            '--input': shade(neutral, 200),
            '--sidebar': shade(neutral, 50),
            '--sidebar-foreground': shade(neutral, 950),
            '--sidebar-accent': shade(neutral, 100),
            '--sidebar-accent-foreground': shade(neutral, 900),
            '--sidebar-border': hairline(shade(neutral, 200)),
        };
    }
    return {
        // Keep dark mode charcoal instead of near-black. The 900 canvas and softer
        // card surface preserve hierarchy without making the whole app feel black.
        '--background': `color-mix(in oklab, ${shade(neutral, 900)} 25%, ${shade(neutral, 800)})`,
        '--foreground': NEAR_WHITE,
        '--card': `color-mix(in oklab, ${shade(neutral, 900)} 72%, ${shade(neutral, 800)})`,
        '--card-foreground': NEAR_WHITE,
        '--popover': `color-mix(in oklab, ${shade(neutral, 900)} 55%, ${shade(neutral, 800)})`,
        '--popover-foreground': NEAR_WHITE,
        '--secondary': shade(neutral, 800),
        '--secondary-foreground': NEAR_WHITE,
        '--muted': shade(neutral, 800),
        '--muted-foreground': shade(neutral, 400),
        '--accent': shade(neutral, 800),
        '--accent-foreground': NEAR_WHITE,
        '--border': 'oklch(1 0 0 / 7%)',
        '--input': 'oklch(1 0 0 / 15%)',
        '--sidebar': `color-mix(in oklab, ${shade(neutral, 900)} 25%, ${shade(neutral, 800)})`,
        '--sidebar-foreground': NEAR_WHITE,
        '--sidebar-accent': shade(neutral, 800),
        '--sidebar-accent-foreground': NEAR_WHITE,
        '--sidebar-border': 'oklch(1 0 0 / 7%)',
    };
}

/** Dark surfaces the user can pick. `charcoal` keeps the neutral colour's own dark tokens; the others replace the surfaces. */
export const DARK_STYLES = [
    { value: 'charcoal', label: 'Charcoal', swatch: '#1c1c1c' },
    { value: 'black', label: 'Black', swatch: '#000000' },
    { value: 'graphite', label: 'Graphite', swatch: '#2c2c31' },
    { value: 'nord', label: 'Nord', swatch: '#2e3440' },
    { value: 'tokyo', label: 'Tokyo Night', swatch: '#1a1b26' },
    { value: 'forest', label: 'Forest', swatch: '#15231a' },
    { value: 'warm', label: 'Warm', swatch: '#282828' },
] as const;
export type DarkStyle = (typeof DARK_STYLES)[number]['value'];

function surfaceOf(c: {
    bg: string;
    fg: string;
    card: string;
    side: string;
    muted: string;
    mutedFg: string;
    border: string;
}): Record<string, string> {
    return {
        '--background': c.bg,
        '--foreground': c.fg,
        '--card': c.card,
        '--card-foreground': c.fg,
        '--popover': c.card,
        '--popover-foreground': c.fg,
        '--secondary': c.muted,
        '--secondary-foreground': c.fg,
        '--muted': c.muted,
        '--muted-foreground': c.mutedFg,
        '--accent': c.muted,
        '--accent-foreground': c.fg,
        '--border': c.border,
        '--input': c.border,
        '--sidebar': c.side,
        '--sidebar-foreground': c.fg,
        '--sidebar-accent': c.muted,
        '--sidebar-accent-foreground': c.fg,
        '--sidebar-border': c.border,
    };
}

const DARK_SURFACES: Record<DarkStyle, Record<string, string>> = {
    charcoal: {},
    black: surfaceOf({
        bg: '#000000',
        fg: '#ededed',
        card: '#0a0a0a',
        side: '#050505',
        muted: '#161616',
        mutedFg: '#8a8a8a',
        border: '#1f1f1f',
    }),
    graphite: surfaceOf({
        bg: '#1c1c1f',
        fg: '#e4e4e7',
        card: '#232327',
        side: '#18181b',
        muted: '#2c2c31',
        mutedFg: '#9c9ca6',
        border: '#34343a',
    }),
    nord: surfaceOf({
        bg: '#2e3440',
        fg: '#eceff4',
        card: '#3b4252',
        side: '#2e3440',
        muted: '#434c5e',
        mutedFg: '#a3adbf',
        border: '#4c566a',
    }),
    tokyo: surfaceOf({
        bg: '#1a1b26',
        fg: '#c0caf5',
        card: '#1f2335',
        side: '#16161e',
        muted: '#292e42',
        mutedFg: '#787c99',
        border: '#2f3549',
    }),
    forest: surfaceOf({
        bg: '#101a14',
        fg: '#d9e8dd',
        card: '#15231a',
        side: '#0d1611',
        muted: '#1e3125',
        mutedFg: '#7d9c86',
        border: '#25402f',
    }),
    warm: surfaceOf({
        bg: '#282828',
        fg: '#ebdbb2',
        card: '#32302f',
        side: '#1d2021',
        muted: '#3c3836',
        mutedFg: '#a89984',
        border: '#504945',
    }),
};

/** Light surfaces the user can pick. `white` keeps the neutral colour's own light tokens. */
export const LIGHT_STYLES = [
    { value: 'white', label: 'White', swatch: '#ffffff' },
    { value: 'cream', label: 'Cream', swatch: '#fbf8ef' },
    { value: 'sepia', label: 'Sepia', swatch: '#f4ecd8' },
    { value: 'paper', label: 'Paper', swatch: '#f4f4f5' },
    { value: 'sky', label: 'Sky', swatch: '#eef5fb' },
    { value: 'mint', label: 'Mint', swatch: '#eef7f2' },
    { value: 'nord-light', label: 'Nord Light', swatch: '#eceff4' },
] as const;
export type LightStyle = (typeof LIGHT_STYLES)[number]['value'];

const LIGHT_SURFACES: Record<LightStyle, Record<string, string>> = {
    white: {},
    cream: surfaceOf({
        bg: '#fbf8ef',
        fg: '#2b2a26',
        card: '#fffdf6',
        side: '#f5f0e1',
        muted: '#efe8d3',
        mutedFg: '#7a7463',
        border: '#e4dcc4',
    }),
    sepia: surfaceOf({
        bg: '#f4ecd8',
        fg: '#3b2f1e',
        card: '#faf4e4',
        side: '#ebe0c6',
        muted: '#e6dabb',
        mutedFg: '#7d6d52',
        border: '#d9ccab',
    }),
    paper: surfaceOf({
        bg: '#f4f4f5',
        fg: '#18181b',
        card: '#ffffff',
        side: '#ebebed',
        muted: '#e4e4e7',
        mutedFg: '#71717a',
        border: '#d4d4d8',
    }),
    sky: surfaceOf({
        bg: '#eef5fb',
        fg: '#1e2a3a',
        card: '#f8fbfe',
        side: '#e2edf7',
        muted: '#dbe8f4',
        mutedFg: '#5b7088',
        border: '#cddcea',
    }),
    mint: surfaceOf({
        bg: '#eef7f2',
        fg: '#173325',
        card: '#f7fcf9',
        side: '#e0f0e7',
        muted: '#d8ebe0',
        mutedFg: '#5a7a68',
        border: '#c8e0d2',
    }),
    'nord-light': surfaceOf({
        bg: '#eceff4',
        fg: '#2e3440',
        card: '#e5e9f0',
        side: '#d8dee9',
        muted: '#d8dee9',
        mutedFg: '#4c566a',
        border: '#c8ced9',
    }),
};

/** The surface tokens of the chosen style for the current mode; none for the neutral default. */
export function surfaceTokens(
    dark: boolean,
    style: DarkStyle | LightStyle,
): Record<string, string> {
    return dark
        ? (DARK_SURFACES[style as DarkStyle] ?? {})
        : (LIGHT_SURFACES[style as LightStyle] ?? {});
}

const DARK_INK = 'oklch(0.141 0.005 285.823)';
const LIGHT_FOREGROUND = new Set<Primary>(['yellow', 'amber', 'lime']);

export function primaryTokens(
    primary: Primary,
    dark: boolean,
): Record<string, string> {
    const value =
        primary === 'black'
            ? dark
                ? NEAR_WHITE
                : DARK_INK
            : `var(--color-${primary}-${dark ? 400 : 500})`;
    const foreground =
        primary === 'black'
            ? dark
                ? DARK_INK
                : NEAR_WHITE
            : LIGHT_FOREGROUND.has(primary)
              ? DARK_INK
              : NEAR_WHITE;
    return {
        '--primary': value,
        '--primary-foreground': foreground,
        '--ring': value,
        '--sidebar-primary': value,
        '--sidebar-primary-foreground': foreground,
        '--sidebar-ring': value,
    };
}

export const radiusTokens = (radius: number): Record<string, string> => ({
    '--radius': `${radius}rem`,
});

export function swatch(name: Primary | Neutral): string {
    return name === 'black' ? DARK_INK : `var(--color-${name}-500)`;
}
