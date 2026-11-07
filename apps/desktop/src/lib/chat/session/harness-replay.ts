/** Copies string IDs from a replay payload and treats missing or stale fields as empty. */
export function replayIds(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}
