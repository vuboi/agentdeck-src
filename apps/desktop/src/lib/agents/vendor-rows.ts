/** A model-picker row that merges a vendor's login (CLI or native) with its API-key provider. */
export type VendorId = 'command-code' | 'muse-code';

const hostOf = (baseUrl: string): string => {
    try {
        return new URL(baseUrl).hostname;
    } catch {
        return '';
    }
};

/** The vendor row a custom provider belongs to: its API key and its login share one row, as Claude's credit models do. */
export function vendorOf(provider: {
    id: string;
    baseUrl: string;
    nativeAuth?: string;
}): VendorId | undefined {
    const host = hostOf(provider.baseUrl);
    if (host === 'api.commandcode.ai') return 'command-code';
    if (
        provider.id === 'muse-code' ||
        provider.nativeAuth === 'muse-code' ||
        host === 'api.meta.ai'
    )
        return 'muse-code';
    return undefined;
}
