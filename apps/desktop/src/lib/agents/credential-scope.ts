/**
 * The credential a turn runs under: the key of its lane (see credential-switch.ts), of its account epoch (see
 * chat/runs/account-epoch.svelte.ts) and of its busy label (`switch:<scope>`). One rule, so no caller maps agents by hand.
 *
 * - Antigravity is `agy` everywhere: its connector, lane and switch label all use that name.
 * - Each custom provider has its own credential: `custom:<providerId>`. A custom model id is `<providerId>::<model>`.
 *   A custom model without a provider id falls back to plain `custom`.
 * - Every other agent is its own id.
 */
export function credentialScope(
    agent: string | null | undefined,
    model?: string | null,
): string {
    if (agent === 'antigravity') return 'agy';
    if (agent === 'custom') {
        const at = model?.indexOf('::') ?? -1;
        const providerId = model && at > 0 ? model.slice(0, at) : '';
        return providerId ? customScope(providerId) : 'custom';
    }
    return agent ?? '';
}

/** The scope of one custom provider, for callers that hold its id rather than a model. */
export const customScope = (providerId: string): string =>
    `custom:${providerId}`;
