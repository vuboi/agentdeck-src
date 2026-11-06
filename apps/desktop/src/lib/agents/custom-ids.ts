// Ids of the hidden custom providers the app keeps for itself. Pure, so plain node can test it.
//
// WorkBuddy has two faces: the CLI (provider id `workbuddy`, see provider-descriptors.ts) and a hidden custom provider
// that serves its API. The custom one used to carry the same id, so a route `workbuddy|…` could mean either. It now has
// its own id. Saved providers that still carry the old one are renamed when they are read.

export const WORKBUDDY_API_ID = 'workbuddy-api';

/** A saved custom provider in its stored shape: only the fields the rename needs. */
type StoredProvider = { id: string; nativeAuth?: string };

/** The provider with the id it has now. The hidden WorkBuddy provider is the one marked `nativeAuth: 'workbuddy'`. */
export function migrateCustomProviderId<T extends StoredProvider>(
    provider: T,
): T {
    if (provider.id === 'workbuddy' && provider.nativeAuth === 'workbuddy')
        return { ...provider, id: WORKBUDDY_API_ID };
    return provider;
}
