<script lang="ts">
    import {
        ZButton,
        ZIcon,
        ZInput,
        zModalService,
    } from '@shival99/z-ui-svelte';
    import {
        installDshPlugin,
        removeDshPlugin,
        store,
        type DshPluginItem,
    } from '../../store/store.svelte';
    import { onMount } from 'svelte';

    let spec = $state('');
    let query = $state('');
    let category = $state('all');
    let catalog = $state<DshCatalogItem[]>([]);
    let catalogCategories = $state<DshCatalogCategory[]>([]);
    let catalogLoading = $state(false);
    let catalogError = $state('');

    type DshCatalogItem = {
        name: string;
        title?: string;
        description?: { en?: string; zh?: string } | string;
        homepage?: string;
        repository?: { url?: string };
        metadata?: { category?: string };
        versions?: { version?: string; source?: { type?: string } }[];
    };
    type DshCatalogCategory = {
        id: string;
        title?: { en?: string; zh?: string };
    };
    const CATALOG_URL =
        'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json';

    const catalogItems = $derived(
        catalog
            .filter((item) => {
                const text =
                    `${item.name} ${item.title ?? ''} ${description(item)}`.toLowerCase();
                return (
                    (!query.trim() ||
                        text.includes(query.trim().toLowerCase())) &&
                    (category === 'all' || item.metadata?.category === category)
                );
            })
            .slice(0, 80),
    );

    function description(item: DshCatalogItem) {
        return typeof item.description === 'string'
            ? item.description
            : (item.description?.en ?? item.description?.zh ?? '');
    }

    function installSpec(item: DshCatalogItem) {
        const source = item.versions?.[0]?.source?.type;
        if (source === 'github' && item.repository?.url) {
            const match = item.repository.url.match(
                /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/,
            );
            if (match) return `github:${match[1]}`;
        }
        const version = item.versions?.[0]?.version;
        return version ? `${item.name}@${version}` : item.name;
    }

    function installCatalogItem(item: DshCatalogItem) {
        spec = installSpec(item);
        install();
    }

    async function loadCatalog() {
        catalogLoading = true;
        catalogError = '';
        try {
            const response = await fetch(CATALOG_URL);
            if (!response.ok)
                throw new Error(`Catalog request failed (${response.status})`);
            const payload = (await response.json()) as {
                plugins?: DshCatalogItem[];
                metadata?: {
                    categories?: Record<
                        string,
                        { title?: { en?: string; zh?: string } }
                    >;
                };
            };
            catalog = Array.isArray(payload.plugins) ? payload.plugins : [];
            catalogCategories = Object.entries(
                payload.metadata?.categories ?? {},
            ).map(([id, value]) => ({ id, ...value }));
        } catch (error) {
            catalogError =
                error instanceof Error ? error.message : String(error);
        } finally {
            catalogLoading = false;
        }
    }

    onMount(() => void loadCatalog());

    function install() {
        const value = spec.trim();
        if (!value) return;
        void installDshPlugin(value).then((result) => {
            if (result === 'ok') spec = '';
        });
    }

    function remove(plugin: DshPluginItem) {
        zModalService.danger({
            zTitle: `Remove ${plugin.name}?`,
            zContent: `dsh will remove this bundle from the sdk profile: ${plugin.source}`,
            zConfirmStyle: 'dialog',
            zOkText: 'Remove',
            zOkIcon: 'lucideTrash2',
            zCancelText: 'Cancel',
            zWidth: '400px',
            onOk: () => void removeDshPlugin(plugin),
        });
    }
</script>

<section
    class="border-b border-border px-3 py-3"
    aria-label="DeepSeek Harness plugins"
>
    <div class="mb-2 flex items-center gap-2">
        <ZIcon zType="lucidePuzzle" class="size-4 text-primary" />
        <div class="min-w-0 flex-1">
            <h3 class="m-0 text-sm font-medium text-foreground">
                DeepSeek Harness plugins
            </h3>
            <p class="m-0 text-[0.6875rem] text-muted-foreground">
                Installed into dsh profile <code>sdk</code>. Managed by official
                dsh plugin commands.
            </p>
        </div>
    </div>

    <div class="flex items-center gap-2">
        <ZInput
            bind:value={spec}
            zLabel="dsh plugin package or git spec"
            zLabelClass="sr-only"
            zPlaceholder="@deepseek-ai/dsh-skill-office or https://github.com/owner/plugin"
            class="min-w-0 flex-1"
            onkeydown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    install();
                }
            }}
        />
        <ZButton
            zType="outline"
            zSize="sm"
            class="h-8 shrink-0"
            zLoading={store.busy.startsWith('dsh:add:')}
            onclick={install}
        >
            <ZIcon zType="lucideDownload" class="size-3.5" />Install
        </ZButton>
    </div>

    <div class="mt-3 rounded-md border border-border bg-muted/20 p-2.5">
        <div class="mb-2 flex items-center gap-2">
            <div class="min-w-0 flex-1">
                <div class="text-xs font-medium text-foreground">
                    Awesome DSH Plugin catalog
                </div>
                <div class="text-[0.6875rem] text-muted-foreground">
                    Community catalog. Review permissions before installing
                    third-party code.
                </div>
            </div>
            <ZButton
                zType="ghost"
                zSize="sm"
                class="size-7! shrink-0 p-0"
                aria-label="Refresh DSH plugin catalog"
                onclick={() => void loadCatalog()}
            >
                <ZIcon
                    zType={catalogLoading
                        ? 'lucideLoaderCircle'
                        : 'lucideRefreshCw'}
                    class="size-3.5 {catalogLoading ? 'animate-spin' : ''}"
                />
            </ZButton>
        </div>
        <div class="flex gap-2">
            <ZInput
                bind:value={query}
                zLabel="Search DSH plugins"
                zLabelClass="sr-only"
                zPlaceholder="Search plugins"
                class="min-w-0 flex-1"
            />
            <select
                bind:value={category}
                class="h-8 max-w-[10rem] rounded-md border border-border bg-background px-2 text-xs text-foreground"
                aria-label="Filter DSH plugins by category"
            >
                <option value="all">All categories</option>
                {#each catalogCategories as item (item.id)}
                    <option value={item.id}>{item.title?.en ?? item.id}</option>
                {/each}
            </select>
        </div>
        {#if catalogError}
            <p class="m-0 mt-2 text-[0.6875rem] text-destructive">
                {catalogError}
            </p>
        {:else if catalogLoading && catalog.length === 0}
            <p class="m-0 mt-2 text-[0.6875rem] text-muted-foreground">
                Loading catalog…
            </p>
        {:else if catalogItems.length > 0}
            <ul
                class="m-0 mt-2 flex max-h-64 list-none flex-col gap-1.5 overflow-y-auto p-0"
            >
                {#each catalogItems as item (item.name)}
                    <li
                        class="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2"
                    >
                        <div class="min-w-0 flex-1">
                            <div class="truncate text-xs text-foreground">
                                {item.title ?? item.name}
                            </div>
                            <div
                                class="truncate text-[0.6875rem] text-muted-foreground"
                            >
                                {description(item)}
                            </div>
                        </div>
                        <span
                            class="shrink-0 text-[0.625rem] text-muted-foreground"
                            >{item.metadata?.category ?? 'plugin'}</span
                        >
                        <ZButton
                            zType="outline"
                            zSize="sm"
                            class="h-7 shrink-0"
                            zDisabled={store.busy.startsWith('dsh:add:')}
                            onclick={() => installCatalogItem(item)}
                        >
                            <ZIcon zType="lucideDownload" class="size-3" /> Add
                        </ZButton>
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="m-0 mt-2 text-[0.6875rem] text-muted-foreground">
                No catalog plugins match this filter.
            </p>
        {/if}
    </div>

    {#if store.dshPlugins.length > 0}
        <ul class="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
            {#each store.dshPlugins as plugin (plugin.id)}
                <li
                    class="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2"
                >
                    <ZIcon
                        zType="lucidePuzzle"
                        class="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <div class="min-w-0 flex-1">
                        <div class="truncate text-sm text-foreground">
                            {plugin.name}
                        </div>
                        <div
                            class="truncate text-[0.6875rem] text-muted-foreground"
                        >
                            {plugin.version || plugin.source}
                        </div>
                    </div>
                    <span class="text-[0.6875rem] text-muted-foreground"
                        >{plugin.enabled ? 'enabled' : 'installed'}</span
                    >
                    <ZButton
                        zType="ghost"
                        zSize="sm"
                        class="size-7! shrink-0 p-0 text-destructive hover:!bg-destructive/10"
                        zDisabled={store.busy === `dsh:remove:${plugin.id}`}
                        aria-label="Remove dsh plugin"
                        onclick={() => remove(plugin)}
                    >
                        <ZIcon
                            zType={store.busy === `dsh:remove:${plugin.id}`
                                ? 'lucideLoaderCircle'
                                : 'lucideTrash2'}
                            class="size-3.5 {store.busy ===
                            `dsh:remove:${plugin.id}`
                                ? 'animate-spin'
                                : ''}"
                        />
                    </ZButton>
                </li>
            {/each}
        </ul>
    {:else}
        <p class="m-0 mt-2 text-[0.6875rem] text-muted-foreground">
            No external dsh bundles installed.
        </p>
    {/if}
</section>
