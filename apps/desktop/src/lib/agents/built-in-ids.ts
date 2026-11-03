// The ids of the built-in agents, in a module with no imports so plain node tests can read them. provider-registry.ts
// types its BUILT_IN_AGENTS with this list.
export const BUILT_IN_AGENT_IDS = [
    'claude',
    'codex',
    'antigravity',
    'opencode',
    'workbuddy',
    'copilot',
    'command-code',
] as const;
