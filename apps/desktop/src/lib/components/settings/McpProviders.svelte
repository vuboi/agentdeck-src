<script lang="ts">
    import {
        mcp,
        setMcpProviders,
        type McpEntry,
    } from '../../agents/mcp.svelte';
    import {
        MCP_PROVIDER_IDS,
        providerSources,
    } from '../../agents/models.svelte';
    import { isInstalled } from '../../agents/agent-status.svelte';
    import {
        connectorTargets,
        type ConnectorTarget,
        DEFAULT_AGENTS,
        isConnectorId,
        setConnectorList,
    } from '../../agents/connector-targets';
    import { toast } from '../../app/platform/toast';
    import ProviderAccess from './ProviderAccess.svelte';

    let { entry }: { entry: McpEntry } = $props();
    // AgentDeck's own browser is handed to connectors by the app itself, so only a user's server gets connector rows.
    const connectors = $derived(entry.builtin ? [] : connectorTargets());
    const options = $derived([
        ...providerSources(MCP_PROVIDER_IDS.filter(isInstalled)).map(
            (source) => {
                const fixed =
                    entry.builtin && source.provider !== 'antigravity';
                // Only Claude, Codex and Copilot keep project-scoped servers; Antigravity and OpenCode are per user.
                const unsupportedScope =
                    !entry.builtin &&
                    (source.provider === 'antigravity' ||
                        source.provider === 'opencode') &&
                    entry.scope.startsWith('project: ');
                return {
                    id: source.provider,
                    label: source.label,
                    disabled: fixed || unsupportedScope,
                    hint: fixed
                        ? 'Built in'
                        : unsupportedScope
                          ? 'Not supported'
                          : undefined,
                };
            },
        ),
        ...connectors.map((target) => ({
            id: target.id,
            label: target.label,
            logo: target.logo,
            disabled: target.restricted,
            hint: target.restricted ? 'Not supported' : undefined,
        })),
    ]);
    // Only the providers listed below count as selected: an agent this list does not show must not inflate the count.
    const enabled = $derived(
        (entry.builtin
            ? entry.agents
                  .filter((a) => a !== 'antigravity')
                  .concat(mcp.overview?.agy_auto ? ['antigravity'] : [])
            : (entry.enabled_agents ?? entry.agents)
        ).filter((id) => options.some((option) => option.id === id)),
    );

    /** A connector has the server when it is in its own list, else when a CLI config already enables it. */
    function hasServer(target: ConnectorTarget): boolean {
        if (target.restricted) return false;
        return target.provider.mcp
            ? target.provider.mcp.includes(entry.name)
            : entry.enabled_agents.some((agent) =>
                  DEFAULT_AGENTS.includes(agent),
              );
    }
    const selected = $derived([
        ...enabled,
        ...connectors.filter(hasServer).map((target) => target.id),
    ]);

    const sameSet = (a: string[], b: string[]) =>
        a.length === b.length && a.every((id) => b.includes(id));

    /** Save the latest queued selection: the CLI agents through their configs, each connector in its own list. */
    async function save(next: string[], initial: string[]) {
        const cli = (ids: string[]) => ids.filter((id) => !isConnectorId(id));
        const changed = connectors.filter(
            (target) =>
                next.includes(target.id) !== initial.includes(target.id),
        );
        if (changed.length) {
            const defaults = (mcp.overview?.entries ?? [])
                .filter(
                    (item) =>
                        !item.builtin &&
                        item.enabled_agents.some((agent) =>
                            DEFAULT_AGENTS.includes(agent),
                        ),
                )
                .map((item) => item.name);
            for (const target of changed) {
                const names = target.provider.mcp ?? defaults;
                const on = next.includes(target.id);
                setConnectorList(
                    target.provider,
                    'mcp',
                    on
                        ? [...names, entry.name]
                        : names.filter((name) => name !== entry.name),
                );
            }
            toast.success(
                `${entry.name}: providers updated · applies to new sessions`,
            );
        }
        if (sameSet(cli(initial), cli(next))) return true;
        return setMcpProviders(entry, cli(next), cli(initial));
    }
</script>

<ProviderAccess name={entry.name} {selected} {options} onsave={save} />
