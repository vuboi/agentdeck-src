// The one list of built-in providers (agent CLIs). Pure data, no store or UI import, so plain node can test it.
// Adding a provider: one entry here, its look in provider-registry.ts (icon, logo, tone), and its adapter in crates/adapters.
// Everything else (types, CLI names, fallback chain, prewarm, live model, credential scope, pickers, send) reads from here.

export const BUILT_IN_IDS = [
    'claude',
    'codex',
    'antigravity',
    'opencode',
    'workbuddy',
    'copilot',
    'command-code',
] as const;

export type BuiltInAgent = (typeof BUILT_IN_IDS)[number];
/** A chat's provider: a built-in CLI, or `custom` (a user's own endpoint, named by its provider id in a ModelRef). */
export type ProviderId = BuiltInAgent | 'custom';

export type ProviderDescriptor = {
    id: BuiltInAgent;
    label: string;
    /** The CLI binary. Also the name Rust detects the tool by (`connectors.detected`). */
    binary: string;
    /** The account scope the provider's credentials and switch run under. */
    credentialScope: string;
    /** The CLI can change model in a kept process, so a model change does not start a new conversation (Rust `live_model`). */
    liveModel: boolean;
    /** Its kept process is started before the first message (`prewarmChat`). */
    prewarm: boolean;
    /** A chat that fails can move to this provider (the user's recovery chain). */
    inFallbackChain: boolean;
};

export const PROVIDERS: readonly ProviderDescriptor[] = [
    {
        id: 'claude',
        label: 'Claude',
        binary: 'claude',
        credentialScope: 'claude',
        liveModel: true,
        prewarm: true,
        inFallbackChain: true,
    },
    {
        id: 'codex',
        label: 'Codex',
        binary: 'codex',
        credentialScope: 'codex',
        liveModel: false,
        prewarm: true,
        inFallbackChain: true,
    },
    {
        id: 'antigravity',
        label: 'Antigravity',
        binary: 'agy',
        credentialScope: 'agy',
        liveModel: false,
        prewarm: true,
        inFallbackChain: true,
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        binary: 'opencode',
        credentialScope: 'opencode',
        liveModel: false,
        prewarm: true,
        inFallbackChain: true,
    },
    {
        id: 'workbuddy',
        label: 'WorkBuddy',
        binary: 'codebuddy',
        credentialScope: 'workbuddy',
        liveModel: false,
        prewarm: true,
        inFallbackChain: true,
    },
    {
        id: 'copilot',
        label: 'GitHub Copilot',
        binary: 'gh',
        credentialScope: 'copilot',
        liveModel: false,
        prewarm: true,
        inFallbackChain: true,
    },
    {
        id: 'command-code',
        label: 'Command Code',
        binary: 'command-code',
        credentialScope: 'command-code',
        liveModel: false,
        prewarm: false,
        inFallbackChain: true,
    },
];

export const descriptorOf = (id: string | null | undefined) =>
    PROVIDERS.find((item) => item.id === id);

export const isBuiltInAgent = (
    id: string | null | undefined,
): id is BuiltInAgent => descriptorOf(id) !== undefined;

/** The CLI binary of a built-in provider; undefined for `custom` and unknown ids. */
export const cliOf = (id: string | null | undefined) =>
    descriptorOf(id)?.binary;

/** The credential scope a provider's accounts run under (`antigravity` is `agy`); the id itself for anything else. */
export const credentialScopeOf = (id: string) =>
    descriptorOf(id)?.credentialScope ?? id;

export const liveModel = (id: string) => descriptorOf(id)?.liveModel ?? false;

/** Whether a provider's kept process is started ahead of the first message. */
export const prewarmOf = (id: string) => descriptorOf(id)?.prewarm ?? false;

/** Built-in providers whose kept process is started ahead of the first message. */
export const prewarmAgents = (): readonly BuiltInAgent[] =>
    PROVIDERS.filter((item) => item.prewarm).map((item) => item.id);

/** Agents a failing chat may move to, in descriptor order. A custom provider is added by the caller. */
export const fallbackAgents = (): readonly BuiltInAgent[] =>
    PROVIDERS.filter((item) => item.inFallbackChain).map((item) => item.id);
