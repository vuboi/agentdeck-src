import { providerLogo } from './brand-icons';
import { saveProvider, type CustomProvider } from './connectors.svelte';
import { chattable } from './models.svelte';

/** A connector's row id in the Store and MCP provider pickers. The prefix keeps it apart from every CLI id. */
export const CONNECTOR_PREFIX = 'custom:';

/** The CLI agents whose skills and MCP servers a connector uses until it is given a list of its own. */
export const DEFAULT_AGENTS = ['claude', 'codex', 'antigravity'];

export type ConnectorTarget = {
    id: string;
    label: string;
    logo?: string;
    restricted: boolean;
    provider: CustomProvider;
};

export const isConnectorId = (id: string) => id.startsWith(CONNECTOR_PREFIX);

/** The connectors that chat through AgentDeck's own runtime: the same set the model picker lists. */
export function connectorTargets(): ConnectorTarget[] {
    return chattable().map((provider) => ({
        id: `${CONNECTOR_PREFIX}${provider.id}`,
        label: provider.name,
        logo: providerLogo(provider),
        restricted: Boolean(provider.restricted),
        provider,
    }));
}

/** Saves one list of a connector. It changes no API key, so it is not an automatic credential change. */
export function setConnectorList(
    provider: CustomProvider,
    field: 'skills' | 'mcp',
    names: string[],
) {
    saveProvider({ ...provider, [field]: [...new Set(names)] }, true);
}
