// Which provider a sub agent runs on, from its type. A plugin's sub agent is named `<provider>:<agent>` (Codex's
// `codex:codex-rescue`): the provider id before the colon. Free of stores and Tauri so plain node can test it.
import { BUILT_IN_AGENT_IDS } from '../../agents/built-in-ids';

type BuiltInAgent = (typeof BUILT_IN_AGENT_IDS)[number];

/** The registered provider a sub agent type names, or null: a plain type (`explore`), an unknown namespace, or none. */
export function providerOfSubagent(
    type: string | undefined,
): BuiltInAgent | null {
    if (!type) return null;
    const namespace = type.includes(':')
        ? type.slice(0, type.indexOf(':'))
        : type;
    return (BUILT_IN_AGENT_IDS as readonly string[]).includes(namespace)
        ? (namespace as BuiltInAgent)
        : null;
}

/** The `subagent_type` of a sub agent call's input (its JSON), or undefined when the input has none. */
export function subagentTypeOf(input: string): string | undefined {
    try {
        const value = JSON.parse(input) as Record<string, unknown> | null;
        const type = value?.subagent_type;
        return typeof type === 'string' && type ? type : undefined;
    } catch {
        return undefined;
    }
}
