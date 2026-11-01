<script lang="ts">
  import { mcp, setMcpProviders, type McpEntry } from '../../agents/mcp.svelte';
  import { MCP_PROVIDER_IDS, providerSources } from '../../agents/models.svelte';
  import ProviderAccess from './ProviderAccess.svelte';

  let { entry }: { entry: McpEntry } = $props();
  const enabled = $derived(entry.builtin ? entry.agents.filter((a) => a !== 'antigravity').concat(mcp.overview?.agy_auto ? ['antigravity'] : []) : entry.enabled_agents ?? entry.agents);
  const options = $derived(providerSources(MCP_PROVIDER_IDS).map((source) => {
    const fixed = entry.builtin && source.provider !== 'antigravity';
    const unsupportedScope = !entry.builtin && source.provider === 'antigravity' && entry.scope.startsWith('project: ');
    return { id: source.provider, label: source.label, disabled: fixed || unsupportedScope,
      hint: fixed ? 'Built in' : unsupportedScope ? 'Not supported' : undefined };
  }));
</script>

<ProviderAccess name={entry.name} selected={enabled} {options} onsave={(next, initial) => setMcpProviders(entry, next, initial)} />
