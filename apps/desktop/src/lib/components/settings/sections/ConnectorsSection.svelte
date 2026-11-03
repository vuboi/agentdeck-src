<script lang="ts">
    import desktopPackage from '../../../../../package.json';
    import { tick } from 'svelte';
    import { fade, fly, slide } from 'svelte/transition';
    import {
        ZButton,
        ZIcon,
        ZSwitch,
        ZTabs,
        ZTextMorph,
    } from '@shival99/z-ui-svelte';
    import type { ZIconName, ZTab } from '@shival99/z-ui-svelte';
    import { toast } from '../../../app/platform/toast';
    import { ticker } from '../../../app/platform/clock.svelte';
    import {
        CLAUDE_LOGO,
        COPILOT_LOGO,
        GEMINI_LOGO,
        GITHUB_SVG,
        COMMAND_CODE_SVG,
        MUSE_LOGO,
        OPENAI_SVG,
        OPENCODE_SVG,
        WORKBUDDY_LOGO,
    } from '../../../agents/brand-icons';
    import { openExternal } from '../../../browser/browser.svelte';
    import { runUpdateCheck } from '../../../app/platform/updater.svelte';
    import {
        addAccount,
        cancelAccountAdd,
        cancelLogin,
        connectors,
        install,
        installed,
        login,
        logoutNativeConnector,
        newerVersion,
        pendingUpdates,
        refreshAccounts,
        refreshAccount,
        refreshAgyAccount,
        refreshAgyAccounts,
        refreshAgyQuota,
        refreshConnector,
        refreshDetect,
        removeAccount,
        removeAgyAccount,
        retrySaveAgyAccount,
        setConnectorAutoSwitch,
        switchAccount,
        switchAgyAccount,
        subscribeQuotaRefresh,
        tool,
        type Account,
        type AccountProvider,
        type ConnectorId,
        type Login,
        type UsageWindow,
    } from '../../../agents/connectors.svelte';

    /** The connector tab shown and the account whose "reset limit" confirmation is open: both kept by the modal shell. */
    /* eslint-disable no-useless-assignment -- `$bindable()` marks resetAsk as bindable; the parent always binds it, so the fallback is never read. */
    let {
        connectorTab = $bindable(''),
        resetAsk = $bindable(),
    }: { connectorTab: string; resetAsk?: string } = $props();
    /* eslint-enable no-useless-assignment */

    const icon = (name: string) => name as ZIconName;
    const CLAUDE_SDK_VERSION =
        desktopPackage.dependencies['@anthropic-ai/claude-agent-sdk'];

    type Card = {
        id: ConnectorId;
        label: string;
        binary: string;
        brand: string;
        /** Raw SVG used instead of `brand` when the icon set's version cannot take a colour. */
        svg?: string;
        /** A full-colour logo (image) that keeps its own colours; wins over `svg` and `brand`. */
        image?: string;
        /** Colour of the brand icon: the same as the agent's colour in the chat. */
        tone: string;
        note: string;
        accounts?: AccountProvider;
        manager?: { id: string; label: string; why: string };
    };
    const CARDS: Card[] = [
        {
            id: 'claude',
            label: 'Claude Code',
            binary: 'claude',
            brand: 'brandClaude',
            image: CLAUDE_LOGO,
            tone: 'bg-orange-500/12 text-orange-500',
            note: 'AgentDeck includes the Claude Agent SDK. Install Claude Code separately, then sign in here to use your Claude account.',
            accounts: 'claude',
            manager: {
                id: 'cswap',
                label: 'claude-swap',
                why: 'Saves each login and switches between them (cswap).',
            },
        },
        {
            id: 'codex',
            label: 'Codex',
            binary: 'codex',
            brand: 'brandOpenai',
            svg: OPENAI_SVG,
            tone: 'bg-foreground/10 text-foreground',
            note: 'OpenAI’s coding agent. Sign-in opens your browser.',
            accounts: 'codex',
            manager: {
                id: 'codex-auth',
                label: 'codex-auth',
                why: 'Saves each login, shows usage and can switch automatically.',
            },
        },
        {
            id: 'agy',
            label: 'Antigravity',
            binary: 'agy',
            brand: 'brandGemini',
            image: GEMINI_LOGO,
            tone: 'bg-sky-500/12 text-sky-500',
            note: 'Google’s agent CLI (agy). Its sign-in runs in its own window. It has its own browser tools: AgentDeck’s are off for it.',
        },
        {
            id: 'opencode',
            label: 'OpenCode',
            binary: 'opencode',
            brand: 'lucideTerminal',
            svg: OPENCODE_SVG,
            tone: 'bg-foreground/10 text-foreground',
            note: 'Open-source coding agent. Sign-in opens the OpenCode provider chooser.',
        },
        {
            id: 'copilot',
            label: 'GitHub Copilot',
            binary: 'copilot',
            brand: 'lucideBot',
            svg: GITHUB_SVG,
            tone: 'bg-foreground/10 text-foreground',
            note: 'GitHub Copilot coding models. The Copilot CLI is installed here; sign in and switch accounts with GitHub CLI.',
            image: COPILOT_LOGO,
            accounts: 'copilot',
            manager: {
                id: 'gh',
                label: 'GitHub CLI',
                why: 'Uses the active gh auth account for Copilot access.',
            },
        },
        {
            id: 'workbuddy',
            label: 'WorkBuddy',
            binary: 'codebuddy',
            brand: 'lucideBot',
            image: WORKBUDDY_LOGO,
            tone: 'bg-cyan-500/12 text-cyan-600 dark:text-cyan-400',
            note: 'Tencent WorkBuddy. Sign-in uses a browser device flow; chat uses its authenticated model catalog.',
        },
        {
            id: 'muse-code',
            label: 'Muse Code',
            binary: 'muse-code',
            brand: 'lucideBot',
            image: MUSE_LOGO,
            tone: 'bg-violet-500/12 text-violet-600 dark:text-violet-400',
            note: 'Muse Code subscription. Sign-in uses Meta’s device flow and mints a native inference key.',
        },
        {
            id: 'command-code',
            label: 'Command Code',
            binary: 'command-code',
            brand: 'lucideTerminal',
            svg: COMMAND_CODE_SVG,
            tone: 'bg-foreground/10 text-foreground',
            note: 'Command Code coding agent through its own CLI. Sign-in runs in the CLI, so chats use your CLI account, not an API key.',
        },
    ];

    const loginOf = (id: ConnectorId): Login | undefined => {
        const detected = connectors.detected;
        if (!detected) return undefined;
        if (id === 'agy') return detected.antigravity;
        if (id === 'muse-code') return detected.muse_code;
        return (detected as unknown as Record<string, Login | undefined>)[id];
    };

    /** Email of the account card whose Refresh button was clicked: only that card's icon spins. */
    let refreshing = $state('');
    /** Manual refresh state is scoped to each connector tab so one tab never disables another. */
    let refreshingCards = $state<Partial<Record<ConnectorId, boolean>>>({});
    /** Changes after a completed account refresh so the result cards replay their entrance animation. */
    let refreshGeneration = $state<Partial<Record<ConnectorId, number>>>({});
    const isRefreshingCard = (id: ConnectorId) => Boolean(refreshingCards[id]);
    const busyOf = (...keys: string[]) =>
        keys.map((key) => connectors.busy[key]).find(Boolean);
    const lastLog = (id: string) => connectors.logs[id]?.slice(-4) ?? [];
    const urlIn = (lines: string[]) =>
        lines
            .map((line) => line.match(/https?:\/\/\S+/)?.[0])
            .filter(Boolean)
            .pop();
    /** The one-time code a device sign-in asks for (GitHub prints `ABCD-1234`). */
    const codeIn = (lines: string[]) =>
        lines
            .map(
                (line) =>
                    /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(
                        line,
                    )?.[1],
            )
            .filter(Boolean)
            .pop();
    // The connectors are shown one at a time, as tabs along the top, instead of one long list to scroll.
    const activeCard = $derived(
        CARDS.some((card) => card.id === connectorTab)
            ? connectorTab
            : CARDS[0]?.id,
    );
    /** How many accounts a connector has saved (none to count for OpenCode). */
    const accountCount = (card: Card): number | undefined =>
        card.accounts
            ? connectors.accounts[card.accounts]?.accounts.length
            : card.id === 'agy'
              ? connectors.accounts.agy.length
              : undefined;
    // The tab says the short name; the card under it keeps the full one.
    const TAB_NAME: Record<string, string> = {
        claude: 'Claude',
        copilot: 'Copilot',
    };
    const cardTabs = $derived<ZTab[]>(
        CARDS.map((card) => ({
            value: card.id,
            label: TAB_NAME[card.id] ?? card.label,
            iconTemplate: tabIcon,
            badge: pendingUpdates().includes(card.id)
                ? 'Update'
                : accountCount(card) || undefined,
        })),
    );

    // Counts down second by second under two days, as the account menu does; longer waits show days, hours and minutes.
    function countdown(resetsAt: number | null, now: number): string {
        if (resetsAt === null) return 'No reset scheduled';
        const seconds = resetsAt - Math.floor(now / 1000);
        if (seconds <= 0) return 'No reset pending';
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (seconds >= 2 * 86400)
            return `resets in ${days}d ${hours}h ${minutes}m`;
        const secs = seconds % 60;
        return hours
            ? `resets in ${hours}h ${minutes}m ${secs}s`
            : `resets in ${minutes}m ${secs}s`;
    }

    // One colour per plan, so the tier reads at a glance.
    function planClass(plan: string | null): string {
        switch (plan?.toLowerCase()) {
            case 'plus':
                return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
            case 'pro':
                return 'bg-violet-500/15 text-violet-600 dark:text-violet-400';
            case 'max':
                return 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400';
            case 'team':
            case 'business':
                return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
            case 'enterprise':
            case 'edu':
                return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
            default:
                return 'bg-muted text-muted-foreground';
        }
    }

    function observedAgo(at: number, now: number): string {
        const minutes = Math.max(0, Math.round((now / 1000 - at) / 60));
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes} min ago`;
        return minutes < 2880
            ? `${Math.round(minutes / 60)} h ago`
            : `${Math.round(minutes / 1440)} d ago`;
    }

    const barColor = (pct: number) =>
        pct >= 90
            ? 'bg-destructive'
            : pct >= 70
              ? 'bg-amber-500'
              : 'bg-emerald-500';
    const stale = (account: Account, now: number) =>
        account.observed_at !== null &&
        now / 1000 - account.observed_at > 15 * 60;
    const authFailure = (status: string | null | undefined) =>
        /\b(?:401|404)\b|expired|unauthori[sz]ed|authentication required|login required|invalid token|credentials are missing|saved credentials are missing/i.test(
            status ?? '',
        );
    const needsLogin = (account: Account) =>
        account.expired || authFailure(account.status);
    const needsAgyLogin = (
        account: { expired: boolean; status: string | null },
        error: string | null | undefined,
    ) => account.expired || authFailure(account.status) || authFailure(error);

    // Keep one shared grid so accounts with missing or different quota data cannot split the layout.
    const agyAccounts = $derived(
        [...connectors.accounts.agy].sort(
            (a, b) => Number(b.active) - Number(a.active),
        ),
    );

    async function refreshCardAccounts(card: Card) {
        if (isRefreshingCard(card.id)) return;
        refreshingCards[card.id] = true;
        // Let the skeleton paint before the native command starts and updates the cached account state.
        await tick();
        try {
            if (card.id === 'agy') {
                await Promise.all([
                    refreshAgyAccounts(false, true),
                    refreshAgyQuota(false, true),
                ]);
            } else if (card.accounts) {
                await refreshAccounts(card.accounts, true);
            }
        } finally {
            refreshGeneration[card.id] = (refreshGeneration[card.id] ?? 0) + 1;
            delete refreshingCards[card.id];
        }
    }

    async function onConnectorTabChange(value: string) {
        const id = value as ConnectorId;
        connectorTab = id;
        const card = CARDS.find((item) => item.id === id);
        if (
            card?.id === 'agy' &&
            connectors.detected?.antigravity.logged_in === true
        ) {
            await refreshCardAccounts(card);
            return;
        }
        void refreshConnector(id);
    }

    $effect(() => {
        const card = CARDS.find((item) => item.id === activeCard);
        if (!card || (!card.accounts && card.id !== 'agy')) return;
        const refresh = () => {
            if (card.id === 'agy') void refreshAgyQuota();
            else if (card.accounts) void refreshAccounts(card.accounts);
        };
        return subscribeQuotaRefresh(refresh);
    });
    const shown = (window: UsageWindow, now: number) =>
        window.resets_at !== null && window.resets_at * 1000 <= now
            ? 0
            : Math.min(100, window.pct);

    const refreshingDetect = $derived(Boolean(connectors.busy.detect));
</script>

{#snippet tabIcon(tab: ZTab)}
    {@const card = CARDS.find((item) => item.id === tab.value)}
    {#if card?.image}<img
            src={card.image}
            alt=""
            class="size-3.5 shrink-0 rounded-xs object-contain"
        />{:else if card?.svg}<ZIcon
            zSvg={card.svg}
            class="size-3.5"
        />{:else if card}<ZIcon
            zType={icon(card.brand)}
            class="size-3.5"
        />{/if}
{/snippet}

<!-- The tab strip stays put; only the body below it scrolls, so nothing shifts and the body never runs under the strip. -->
<div class="flex h-full min-h-0 min-w-0 flex-col">
    <div
        class="shrink-0 min-w-0 max-w-full border-b border-border px-3.5 pt-2 pb-2 [&_.z-tab-item]:items-center [&_.z-tab-item>span:first-child]:flex [&_.z-tab-item>span:first-child]:items-center"
    >
        <ZTabs
            zTabs={cardTabs}
            zType="bar"
            zSize="sm"
            zTabsOnly
            zShowNavWrapper
            zCache={false}
            activeTab={activeCard}
            onTabChange={(value) => void onConnectorTabChange(value)}
        />
    </div>
    <div
        class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3.5 [scrollbar-gutter:stable]"
    >
        {#if connectors.errors.detect && connectors.detected}
            <div
                class="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
                role="alert"
            >
                <p class="min-w-0 flex-1 text-destructive">
                    Could not check installed connectors: {connectors.errors
                        .detect}
                </p>
                <ZButton
                    zWave={false}
                    zType="outline"
                    zSize="sm"
                    class="h-7 shrink-0 px-2 text-sm"
                    disabled={refreshingDetect}
                    onclick={() => void refreshDetect()}
                >
                    Retry
                </ZButton>
            </div>
        {/if}
        {#if !connectors.detected && connectors.errors.detect}
            <div
                class="rounded-xl border border-destructive/30 bg-destructive/5 p-5"
                role="alert"
            >
                <h3 class="text-sm font-semibold text-destructive">
                    Connectors could not be loaded
                </h3>
                <p
                    class="mt-2 break-words text-[0.75rem] text-muted-foreground"
                >
                    {connectors.errors.detect}
                </p>
                <ZButton
                    zWave={false}
                    zSize="sm"
                    class="mt-4 h-8 gap-1.5 px-3 text-sm"
                    disabled={refreshingDetect}
                    onclick={() => void refreshDetect()}
                >
                    <ZIcon
                        zType={icon(
                            refreshingDetect
                                ? 'lucideLoaderCircle'
                                : 'lucideRefreshCw',
                        )}
                        class="size-3.5 {refreshingDetect
                            ? 'animate-spin'
                            : ''}"
                    />
                    {refreshingDetect ? 'Retrying…' : 'Try again'}
                </ZButton>
            </div>
        {:else}
            <!-- Placeholders and the real cards share one grid cell: the cards fade in over the placeholders as they fade
                 out, so nothing is pushed down or jumps while they swap. -->
            <!-- One column that may shrink below its content: a wide child (the tab strip, a usage row) cannot widen the page. -->
            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)]">
                {#if !connectors.detected}
                    <div
                        class="col-start-1 row-start-1 flex flex-col gap-4"
                        out:fade={{ duration: 180 }}
                        aria-busy="true"
                        aria-label="Loading connectors"
                    >
                        <!-- Like the real page: a strip of tabs and one card, so nothing is taller than it will be (no scrollbar that goes away). -->
                        <div class="flex gap-2" aria-hidden="true">
                            {#each CARDS as tab (tab.id)}<span
                                    class="h-8 w-24 animate-pulse rounded-lg bg-muted/60"
                                ></span>{/each}
                        </div>
                        {#each CARDS.slice(0, 1) as card (card.id)}
                            <div
                                class="animate-pulse rounded-xl border border-border bg-card/40"
                            >
                                <div class="flex items-start gap-3 p-4">
                                    <span
                                        class="size-10 shrink-0 rounded-lg bg-muted"
                                    ></span>
                                    <span
                                        class="flex flex-1 flex-col gap-2 pt-0.5"
                                    >
                                        <span
                                            class="h-3.5 w-32 rounded bg-muted"
                                        ></span>
                                        <span
                                            class="h-3 w-56 max-w-full rounded bg-muted/70"
                                        ></span>
                                        <span
                                            class="h-2.5 w-40 max-w-full rounded bg-muted/50"
                                        ></span>
                                    </span>
                                    <span class="h-8 w-24 rounded-md bg-muted"
                                    ></span>
                                </div>
                                {#if card.accounts || card.id === 'agy'}
                                    <div
                                        class="border-t border-border/70 px-4 py-3"
                                    >
                                        <span
                                            class="mb-2 block h-3 w-28 rounded bg-muted/70"
                                        ></span>
                                        <span
                                            class="block h-12 rounded-lg bg-muted/40"
                                        ></span>
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {:else}
                    <div
                        class="col-start-1 row-start-1 flex min-w-0 flex-col gap-4"
                        in:fade={{ duration: 220, delay: 60 }}
                    >
                        {#each CARDS.filter((item) => item.id === activeCard) as card (card.id)}
                            {@const info = loginOf(card.id)}
                            {@const native =
                                card.id === 'workbuddy' ||
                                card.id === 'muse-code'}
                            {@const path = native
                                ? card.id
                                : tool(card.binary)?.path}
                            {@const cliInstalled = native
                                ? Boolean(tool(card.binary)?.path)
                                : Boolean(path)}
                            {@const version =
                                card.id === 'claude'
                                    ? `SDK ${CLAUDE_SDK_VERSION}`
                                    : native
                                      ? 'OAuth'
                                      : tool(card.binary)?.version}
                            {@const cliUpdate = cliInstalled
                                ? newerVersion(
                                      connectors.latest[card.id],
                                      tool(card.binary)?.version,
                                  )
                                : null}
                            {@const sdkUpdate =
                                card.id === 'claude'
                                    ? newerVersion(
                                          connectors.latest['claude-sdk'],
                                          CLAUDE_SDK_VERSION,
                                      )
                                    : null}
                            {@const list = card.accounts
                                ? connectors.accounts[card.accounts]
                                : null}
                            {@const working = busyOf(
                                `install:${card.id}`,
                                `login:${card.id}`,
                                `add:${card.id}`,
                            )}
                            {@const log = lastLog(card.id)}
                            {@const link = urlIn(
                                connectors.logs[card.id] ?? [],
                            )}
                            {@const code = codeIn(
                                connectors.logs[card.id] ?? [],
                            )}
                            <section
                                class="min-w-0 rounded-xl border border-border bg-card/40"
                                aria-label={card.label}
                            >
                                <div
                                    class="flex h-[4.5rem] items-start gap-3 p-4"
                                >
                                    <span
                                        class="grid size-10 shrink-0 place-items-center rounded-lg {card.tone}"
                                        >{#if card.image}<img
                                                src={card.image}
                                                alt=""
                                                class="size-5 object-contain"
                                            />{:else if card.svg}<ZIcon
                                                zSvg={card.svg}
                                                class="size-5"
                                            />{:else}<ZIcon
                                                zType={icon(card.brand)}
                                                class="size-5"
                                            />{/if}</span
                                    >
                                    <div class="min-w-0 flex-1">
                                        <div
                                            class="flex flex-wrap items-center gap-2"
                                        >
                                            <h3 class="text-sm font-semibold">
                                                {card.label}
                                            </h3>
                                            {#if !connectors.detected || path}
                                                <!-- Grey while the version is read; the text morphs into the checked version in green. -->
                                                <span
                                                    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] tabular-nums transition-colors duration-300 {connectors.detected &&
                                                    version
                                                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                                        : 'bg-muted text-muted-foreground'}"
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            'lucideCheck',
                                                        )}
                                                        class="size-3"
                                                    />
                                                    <ZTextMorph
                                                        zText={!connectors.detected
                                                            ? 'Checking…'
                                                            : (version ??
                                                              'Installed')}
                                                    />
                                                </span>
                                            {:else}
                                                <span
                                                    class="rounded-full bg-muted px-2 py-0.5 text-[0.75rem] text-muted-foreground"
                                                    >Not installed</span
                                                >
                                            {/if}
                                            {#if path && info?.logged_in === true}
                                                <span
                                                    class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.6875rem] text-emerald-600 dark:text-emerald-400"
                                                    ><span
                                                        class="size-1.5 rounded-full bg-emerald-500"
                                                    ></span>Signed in</span
                                                >
                                            {:else if path && info?.logged_in === false}
                                                <span
                                                    class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.6875rem] text-amber-600 dark:text-amber-400"
                                                    >Not signed in</span
                                                >
                                            {/if}
                                        </div>
                                        <p
                                            class="mt-0.5 truncate text-[0.75rem] text-muted-foreground"
                                        >
                                            {#if info?.email}Account: {#key info.email}<span
                                                        class="text-foreground"
                                                        in:fade={{
                                                            duration: 180,
                                                        }}>{info.email}</span
                                                    >{/key}{#if info.plan}{' · ' +
                                                        info.plan}{/if}{#if info.detail}{' · ' +
                                                        info.detail}{/if}{:else}{card.note}{/if}
                                        </p>
                                    </div>
                                    <div
                                        class="flex shrink-0 items-center gap-1.5"
                                    >
                                        <!-- The buttons cross-fade when the state changes (install → installing → signed in) instead of cutting over. -->
                                        <!-- Shown only when npm has a newer release than the installed one; the check is silent. -->
                                        {#if cliUpdate}
                                            <span
                                                class="inline-flex"
                                                title="Version {cliUpdate} is available"
                                                in:fade={{
                                                    duration: 180,
                                                    delay: 60,
                                                }}
                                                out:fade={{ duration: 120 }}
                                            >
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-8 gap-1.5 px-3 text-sm"
                                                    disabled={Boolean(working)}
                                                    onclick={() =>
                                                        void install(
                                                            card.id,
                                                            card.label,
                                                            'updated',
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            working
                                                                ? 'lucideLoaderCircle'
                                                                : 'lucideDownload',
                                                        )}
                                                        class="size-3.5 {working
                                                            ? 'animate-spin'
                                                            : ''}"
                                                    />
                                                    <ZTextMorph
                                                        zText={working
                                                            ? 'Updating…'
                                                            : 'Update'}
                                                    />
                                                </ZButton>
                                            </span>
                                        {/if}
                                        {#if sdkUpdate}
                                            <span
                                                class="inline-flex"
                                                title="SDK {sdkUpdate} is available. The SDK ships inside AgentDeck, so this checks for an AgentDeck update."
                                                in:fade={{
                                                    duration: 180,
                                                    delay: 60,
                                                }}
                                                out:fade={{ duration: 120 }}
                                            >
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-8 gap-1.5 px-3 text-sm"
                                                    onclick={() =>
                                                        void runUpdateCheck()}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            'lucideDownload',
                                                        )}
                                                        class="size-3.5"
                                                    />
                                                    <ZTextMorph
                                                        zText="Update SDK"
                                                    />
                                                </ZButton>
                                            </span>
                                        {/if}
                                        {#if connectors.detected && !cliInstalled && !native}
                                            <span
                                                class="inline-flex"
                                                in:fade={{
                                                    duration: 180,
                                                    delay: 60,
                                                }}
                                                out:fade={{ duration: 120 }}
                                            >
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-8 gap-1.5 px-3 text-sm"
                                                    disabled={Boolean(working)}
                                                    onclick={() =>
                                                        void install(
                                                            card.id,
                                                            card.label,
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            working
                                                                ? 'lucideLoaderCircle'
                                                                : 'lucideDownload',
                                                        )}
                                                        class="size-3.5 {working
                                                            ? 'animate-spin'
                                                            : ''}"
                                                    />
                                                    <ZTextMorph
                                                        zText={working
                                                            ? 'Installing…'
                                                            : 'Install'}
                                                    />
                                                </ZButton>
                                            </span>
                                        {:else if path && (card.id !== 'agy' || info?.logged_in !== true || connectors.busy[`login:${card.id}`])}
                                            {@const waiting = Boolean(
                                                connectors.busy[
                                                    `login:${card.id}`
                                                ],
                                            )}
                                            {#if card.id === 'workbuddy' && !cliInstalled}
                                                <span
                                                    class="inline-flex"
                                                    in:fade={{
                                                        duration: 180,
                                                        delay: 60,
                                                    }}
                                                    out:fade={{ duration: 120 }}
                                                >
                                                    <ZButton
                                                        zWave={false}
                                                        zType="outline"
                                                        zSize="sm"
                                                        class="h-8 gap-1.5 px-3 text-sm"
                                                        disabled={Boolean(
                                                            working,
                                                        )}
                                                        onclick={() =>
                                                            void install(
                                                                card.id,
                                                                card.label,
                                                            )}
                                                    >
                                                        <ZIcon
                                                            zType={icon(
                                                                working
                                                                    ? 'lucideLoaderCircle'
                                                                    : 'lucideDownload',
                                                            )}
                                                            class="size-3.5 {working
                                                                ? 'animate-spin'
                                                                : ''}"
                                                        />
                                                        <ZTextMorph
                                                            zText={working
                                                                ? 'Installing…'
                                                                : 'Install CLI'}
                                                        />
                                                    </ZButton>
                                                </span>
                                            {/if}
                                            <span
                                                class="inline-flex items-center gap-1.5"
                                                in:fade={{
                                                    duration: 180,
                                                    delay: 60,
                                                }}
                                                out:fade={{ duration: 120 }}
                                            >
                                                {#if waiting}
                                                    <ZButton
                                                        zWave={false}
                                                        zType="outline"
                                                        zSize="sm"
                                                        class="h-8 gap-1.5 px-3 text-sm"
                                                        onclick={() =>
                                                            void cancelLogin(
                                                                card.id,
                                                            )}
                                                    >
                                                        Cancel
                                                    </ZButton>
                                                {/if}
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-8 gap-1.5 px-3 text-sm"
                                                    disabled={waiting ||
                                                        Boolean(working)}
                                                    onclick={() =>
                                                        void login(
                                                            card.id,
                                                            card.label,
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            waiting
                                                                ? 'lucideLoaderCircle'
                                                                : 'lucideLogIn',
                                                        )}
                                                        class="size-3.5 {waiting
                                                            ? 'animate-spin'
                                                            : ''}"
                                                    />
                                                    <ZTextMorph
                                                        zText={waiting
                                                            ? 'Waiting for login…'
                                                            : info?.logged_in
                                                              ? 'Sign in again'
                                                              : 'Sign in'}
                                                    />
                                                </ZButton>
                                                {#if native && info?.logged_in === true && !waiting}
                                                    <ZButton
                                                        zWave={false}
                                                        zType="outline"
                                                        zSize="sm"
                                                        class="h-8 px-3 text-sm text-muted-foreground"
                                                        disabled={Boolean(
                                                            working,
                                                        )}
                                                        onclick={() =>
                                                            void logoutNativeConnector(
                                                                card.id as
                                                                    | 'workbuddy'
                                                                    | 'muse-code',
                                                            )}>Sign out</ZButton
                                                    >
                                                {/if}
                                            </span>
                                        {/if}
                                    </div>
                                </div>

                                <div
                                    class="flex items-center gap-3 border-t border-border/70 px-4 py-2.5"
                                >
                                    <span
                                        class="min-w-0 flex-1 text-[0.75rem] text-muted-foreground"
                                        >{card.id === 'opencode' ||
                                        card.id === 'workbuddy' ||
                                        card.id === 'muse-code' ||
                                        card.id === 'command-code'
                                            ? 'Automatic account switching is unavailable for this connector.'
                                            : 'Rotate to another saved account when quota or sign-in fails.'}</span
                                    >
                                    <span
                                        class="text-xs font-medium {card.id ===
                                        'opencode'
                                            ? 'text-muted-foreground'
                                            : ''}">Auto switch</span
                                    >
                                    <ZSwitch
                                        zVariant="dot"
                                        checked={card.id !== 'opencode' &&
                                            card.id !== 'workbuddy' &&
                                            card.id !== 'muse-code' &&
                                            card.id !== 'command-code' &&
                                            Boolean(
                                                connectors.autoSwitch[card.id],
                                            )}
                                        zSize="sm"
                                        zDisabled={card.id === 'opencode' ||
                                            card.id === 'workbuddy' ||
                                            card.id === 'muse-code' ||
                                            card.id === 'command-code'}
                                        onChange={(value) =>
                                            setConnectorAutoSwitch(
                                                card.id,
                                                value,
                                            )}
                                    />
                                </div>

                                {#if working || log.length > 0 || connectors.errors[`install:${card.id}`] || connectors.errors[`login:${card.id}`] || connectors.errors[`add:${card.id}`]}
                                    <div
                                        class="mx-4 mb-4 rounded-lg bg-muted/60 p-3 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground"
                                        role="status"
                                    >
                                        {#if working}<div
                                                class="mb-1 font-sans text-sm text-foreground"
                                            >
                                                {working}…
                                            </div>{/if}
                                        <!-- A long line (an address with its query) wraps instead of widening the card. -->
                                        {#each log as line, index (index)}<div
                                                class="break-all whitespace-pre-wrap"
                                            >
                                                {line}
                                            </div>{/each}
                                        {#each [`install:${card.id}`, `login:${card.id}`, `add:${card.id}`] as key (key)}
                                            {#if connectors.errors[key]}<div
                                                    class="font-sans text-sm text-destructive"
                                                    role="alert"
                                                >
                                                    {connectors.errors[key]}
                                                </div>{/if}
                                        {/each}
                                        {#if code && working}
                                            <button
                                                type="button"
                                                class="mt-1 mr-3 cursor-pointer font-sans text-sm text-primary underline underline-offset-2"
                                                onclick={() =>
                                                    void navigator.clipboard
                                                        .writeText(code)
                                                        .then(() =>
                                                            toast.success(
                                                                'Code copied',
                                                            ),
                                                        )}
                                                >Copy the code {code}</button
                                            >
                                        {/if}
                                        {#if link && working}
                                            <button
                                                type="button"
                                                class="mt-1 cursor-pointer font-sans text-sm text-primary underline underline-offset-2"
                                                onclick={() =>
                                                    void openExternal(link)}
                                                >Browser did not open? Open the
                                                sign-in page</button
                                            >
                                        {/if}
                                    </div>
                                {/if}

                                {#if card.id === 'agy'}
                                    {@const accountsRefreshing =
                                        isRefreshingCard(card.id) ||
                                        (Boolean(
                                            connectors.busy['accounts:agy'],
                                        ) &&
                                            connectors.accounts.agy.length ===
                                                0)}
                                    <div
                                        class="border-t border-border/70 px-4 py-3"
                                    >
                                        <div
                                            class="mb-2 flex items-center gap-2"
                                        >
                                            <h4
                                                class="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
                                            >
                                                Antigravity accounts
                                            </h4>
                                            <span class="ml-auto"></span>
                                            {#if connectors.errors['login:agy'] && info?.logged_in && info.email}
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-7 shrink-0 px-2.5 text-sm"
                                                    disabled={Boolean(
                                                        connectors.busy[
                                                            'save:agy'
                                                        ],
                                                    )}
                                                    onclick={() =>
                                                        void retrySaveAgyAccount()}
                                                >
                                                    {connectors.busy['save:agy']
                                                        ? 'Saving…'
                                                        : 'Retry save'}
                                                </ZButton>
                                            {/if}
                                            <!-- While a sign-in waits, its Cancel and "Waiting for login…" are the card's own (above), as for Claude and Codex: one set of buttons. -->
                                            {#if info?.logged_in === true && !connectors.busy['login:agy']}
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-7 gap-1.5 px-2.5 text-sm"
                                                    disabled={!path}
                                                    title="Open Antigravity to add another Google account"
                                                    onclick={() =>
                                                        void login(
                                                            'agy',
                                                            card.label,
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            'lucideLogIn',
                                                        )}
                                                        class="size-3.5"
                                                    /> Add account
                                                </ZButton>
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-7 gap-1.5 px-2.5 text-sm"
                                                    disabled={isRefreshingCard(
                                                        card.id,
                                                    )}
                                                    aria-label="Refresh all accounts for {card.label}"
                                                    onclick={() =>
                                                        void refreshCardAccounts(
                                                            card,
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            isRefreshingCard(
                                                                card.id,
                                                            )
                                                                ? 'lucideLoaderCircle'
                                                                : 'lucideRefreshCw',
                                                        )}
                                                        class="size-3.5 {isRefreshingCard(
                                                            card.id,
                                                        )
                                                            ? 'animate-spin'
                                                            : ''}"
                                                    />
                                                    Refresh all accounts
                                                </ZButton>
                                            {/if}
                                        </div>
                                        {#if !info?.logged_in || !info.email}
                                            <p
                                                class="mb-3 rounded-lg border border-dashed border-border p-3 text-[0.75rem] text-muted-foreground"
                                            >
                                                Sign in to Antigravity to save
                                                this account automatically.
                                            </p>
                                        {:else if accountsRefreshing}
                                            <div
                                                class="mb-3 grid gap-2 sm:grid-cols-2"
                                                aria-label="Loading Antigravity accounts"
                                                aria-busy="true"
                                            >
                                                {#each [0, 1, 2, 3] as placeholder (placeholder)}
                                                    <div
                                                        class="animate-pulse rounded-lg border border-border p-3 min-h-[96px]"
                                                    >
                                                        <div
                                                            class="h-4 w-2/3 rounded bg-muted"
                                                        ></div>
                                                        <div
                                                            class="mt-3 h-2 w-full rounded bg-muted/70"
                                                        ></div>
                                                        <div
                                                            class="mt-2 h-2 w-4/5 rounded bg-muted/50"
                                                        ></div>
                                                    </div>
                                                {/each}
                                            </div>
                                        {:else if connectors.errors['accounts:agy']}
                                            <p
                                                class="mb-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                                                role="alert"
                                            >
                                                {connectors.errors[
                                                    'accounts:agy'
                                                ]}
                                            </p>
                                        {:else if connectors.accounts.agy.length === 0}
                                            <p
                                                class="mb-3 rounded-lg border border-dashed border-border p-3 text-[0.75rem] text-muted-foreground"
                                            >
                                                The signed-in account is being
                                                saved to Windows Credential
                                                Manager…
                                            </p>
                                        {:else}
                                            <!-- One shared grid keeps account cards aligned even when quota groups differ. -->
                                            {#key refreshGeneration[card.id] ?? 0}
                                                <ul
                                                    class="mb-3 grid gap-2 sm:grid-cols-2"
                                                >
                                                    {#each agyAccounts as account, accountIndex (account.id)}
                                                        {@const quota =
                                                            connectors.agyAccountQuotas.find(
                                                                (item) =>
                                                                    item.id ===
                                                                    account.id,
                                                            )}
                                                        {@const switching =
                                                            Boolean(
                                                                connectors.busy[
                                                                    'switch:agy'
                                                                ]?.endsWith(
                                                                    account.email,
                                                                ),
                                                            )}
                                                        {@const authRequired =
                                                            needsAgyLogin(
                                                                account,
                                                                quota?.error,
                                                            )}
                                                        {@const accountRefreshing =
                                                            refreshing ===
                                                            account.id}
                                                        <li
                                                            class="min-w-0 self-start rounded-lg border p-3 {account.active
                                                                ? 'border-emerald-500/50 bg-emerald-500/5'
                                                                : 'border-border'}"
                                                            in:fly={{
                                                                y: 18,
                                                                duration: 300,
                                                                delay:
                                                                    accountIndex *
                                                                    70,
                                                            }}
                                                        >
                                                            <div
                                                                class="flex items-center gap-2"
                                                            >
                                                                <span
                                                                    class="min-w-0 flex-1 truncate text-sm font-medium"
                                                                    title={account.email}
                                                                    >{account.email}</span
                                                                >
                                                                {#if account.active}<span
                                                                        class="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                                                                        >IN USE</span
                                                                    >{/if}
                                                                {#if authRequired}
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="size-6! shrink-0 p-0 text-destructive"
                                                                        aria-label="Sign in again {account.email}"
                                                                        title={account.status ??
                                                                            quota?.error ??
                                                                            'Sign in again'}
                                                                        disabled={Boolean(
                                                                            connectors
                                                                                .busy[
                                                                                'login:agy'
                                                                            ],
                                                                        )}
                                                                        onclick={() =>
                                                                            void login(
                                                                                'agy',
                                                                                card.label,
                                                                            )}
                                                                    >
                                                                        <ZIcon
                                                                            zType={icon(
                                                                                connectors
                                                                                    .busy[
                                                                                    'login:agy'
                                                                                ]
                                                                                    ? 'lucideLoaderCircle'
                                                                                    : 'lucideLogIn',
                                                                            )}
                                                                            class="size-3 {connectors
                                                                                .busy[
                                                                                'login:agy'
                                                                            ]
                                                                                ? 'animate-spin'
                                                                                : ''}"
                                                                        />
                                                                    </ZButton>
                                                                {/if}
                                                                {#if !account.active && !authRequired}
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="size-6! shrink-0 p-0"
                                                                        aria-label="Use {account.email}"
                                                                        title="Use this account"
                                                                        disabled={Boolean(
                                                                            connectors
                                                                                .busy[
                                                                                'switch:agy'
                                                                            ],
                                                                        )}
                                                                        onclick={() =>
                                                                            void switchAgyAccount(
                                                                                account,
                                                                            )}
                                                                    >
                                                                        <ZIcon
                                                                            zType={icon(
                                                                                switching
                                                                                    ? 'lucideLoaderCircle'
                                                                                    : 'lucideArrowLeftRight',
                                                                            )}
                                                                            class="size-3 {switching
                                                                                ? 'animate-spin'
                                                                                : ''}"
                                                                        />
                                                                    </ZButton>
                                                                {/if}
                                                                {#if !account.active}
                                                                    {@const removing =
                                                                        Boolean(
                                                                            connectors
                                                                                .busy[
                                                                                `remove:agy:${account.id}`
                                                                            ],
                                                                        )}
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="size-6! shrink-0 p-0 text-muted-foreground hover:!border-destructive/60 hover:!bg-destructive/10 hover:!text-destructive"
                                                                        aria-label="Remove {account.email}"
                                                                        title="Remove account"
                                                                        disabled={removing}
                                                                        onclick={() =>
                                                                            void removeAgyAccount(
                                                                                account,
                                                                            )}
                                                                    >
                                                                        <ZIcon
                                                                            zType={icon(
                                                                                removing
                                                                                    ? 'lucideLoaderCircle'
                                                                                    : 'lucideTrash2',
                                                                            )}
                                                                            class="size-3 {removing
                                                                                ? 'animate-spin'
                                                                                : ''}"
                                                                        />
                                                                    </ZButton>
                                                                {/if}
                                                                <ZButton
                                                                    zWave={false}
                                                                    zType="outline"
                                                                    zSize="sm"
                                                                    class="size-6! shrink-0 p-0"
                                                                    aria-label="Refresh {account.email}"
                                                                    title="Refresh this account"
                                                                    disabled={Boolean(
                                                                        connectors
                                                                            .busy[
                                                                            `quota:agy:${account.id}`
                                                                        ],
                                                                    )}
                                                                    onclick={() => {
                                                                        refreshing =
                                                                            account.id;
                                                                        void refreshAgyAccount(
                                                                            account.id,
                                                                        ).finally(
                                                                            () =>
                                                                                (refreshing =
                                                                                    ''),
                                                                        );
                                                                    }}
                                                                >
                                                                    <ZIcon
                                                                        zType={icon(
                                                                            accountRefreshing
                                                                                ? 'lucideLoaderCircle'
                                                                                : 'lucideRefreshCw',
                                                                        )}
                                                                        class="size-3 {accountRefreshing
                                                                            ? 'animate-spin'
                                                                            : ''}"
                                                                    />
                                                                </ZButton>
                                                            </div>
                                                            {#if quota?.quota && quota.quota.groups.length > 0}
                                                                <div
                                                                    class="mt-2.5 grid gap-2.5"
                                                                >
                                                                    {#each quota.quota.groups as group (group.id)}
                                                                        <div>
                                                                            <div
                                                                                class="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-medium"
                                                                            >
                                                                                <ZIcon
                                                                                    zType={icon(
                                                                                        group.id ===
                                                                                            'gemini'
                                                                                            ? 'brandGemini'
                                                                                            : 'lucideLayers',
                                                                                    )}
                                                                                    class="size-3 shrink-0"
                                                                                />
                                                                                <span
                                                                                    class="truncate"
                                                                                    >{group.label}</span
                                                                                >
                                                                            </div>
                                                                            <div
                                                                                class="grid gap-y-2"
                                                                            >
                                                                                {#each group.windows as window (window.label)}
                                                                                    {@const pct =
                                                                                        shown(
                                                                                            window,
                                                                                            ticker.sec,
                                                                                        )}
                                                                                    <div
                                                                                    >
                                                                                        <div
                                                                                            class="mb-1 flex items-baseline justify-between gap-2 text-[0.6875rem]"
                                                                                        >
                                                                                            <span
                                                                                                class="text-muted-foreground"
                                                                                                >{window.label}
                                                                                                window</span
                                                                                            >
                                                                                            <span
                                                                                                class="tabular-nums {pct >=
                                                                                                90
                                                                                                    ? 'font-medium text-destructive'
                                                                                                    : ''}"
                                                                                                >{Math.round(
                                                                                                    pct,
                                                                                                )}%</span
                                                                                            >
                                                                                        </div>
                                                                                        <div
                                                                                            class="h-1.5 overflow-hidden rounded-full bg-muted-foreground/25"
                                                                                            role="progressbar"
                                                                                            aria-valuenow={Math.round(
                                                                                                pct,
                                                                                            )}
                                                                                            aria-valuemin="0"
                                                                                            aria-valuemax="100"
                                                                                            aria-label="{account.email} {group.label} {window.label} usage"
                                                                                        >
                                                                                            <div
                                                                                                class="h-full rounded-full transition-[width] duration-500 {barColor(
                                                                                                    pct,
                                                                                                )}"
                                                                                                style:width="{pct}%"
                                                                                            ></div>
                                                                                        </div>
                                                                                        {#if countdown(window.resets_at, ticker.sec)}
                                                                                            <div
                                                                                                class="mt-1 text-[0.75rem] text-muted-foreground tabular-nums"
                                                                                            >
                                                                                                {countdown(
                                                                                                    window.resets_at,
                                                                                                    ticker.sec,
                                                                                                )}
                                                                                            </div>
                                                                                        {/if}
                                                                                    </div>
                                                                                {/each}
                                                                            </div>
                                                                        </div>
                                                                    {/each}
                                                                </div>
                                                                {#if quota.quota.observed_at}<p
                                                                        class="mt-2 text-[0.6875rem] text-muted-foreground"
                                                                    >
                                                                        {observedAgo(
                                                                            quota
                                                                                .quota
                                                                                .observed_at,
                                                                            ticker.min,
                                                                        )}
                                                                    </p>{/if}
                                                            {/if}
                                                        </li>
                                                    {/each}
                                                </ul>
                                            {/key}
                                        {/if}
                                        {#if connectors.errors['switch:agy']}
                                            <div
                                                class="mb-3 flex items-center gap-2 text-sm text-destructive"
                                                role="alert"
                                            >
                                                <p class="min-w-0 flex-1">
                                                    {connectors.errors[
                                                        'switch:agy'
                                                    ]}
                                                </p>
                                            </div>
                                        {/if}
                                    </div>
                                {/if}

                                {#if card.manager && card.accounts && path}
                                    {@const provider = card.accounts}
                                    {@const manager = card.manager}
                                    {@const managerInstalled = installed(
                                        manager.id,
                                    )}
                                    {@const accountsRefreshing =
                                        isRefreshingCard(card.id) ||
                                        (Boolean(
                                            connectors.busy[
                                                `accounts:${provider}`
                                            ],
                                        ) &&
                                            (!list ||
                                                list.accounts.length === 0))}
                                    <!-- Appears with the CLI: the accounts area slides in under the header rather than popping in. -->
                                    <div
                                        class="border-t border-border/70 px-4 py-3"
                                        in:slide={{ duration: 220 }}
                                        out:slide={{ duration: 160 }}
                                    >
                                        <div
                                            class="mb-2 flex flex-wrap items-center gap-2"
                                        >
                                            <h4
                                                class="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
                                            >
                                                Accounts
                                            </h4>
                                            {#if managerInstalled}
                                                <span
                                                    class="text-[0.75rem] text-muted-foreground"
                                                    >via {tool(manager.id)
                                                        ?.version ??
                                                        manager.label}</span
                                                >
                                            {/if}
                                            <span class="ml-auto"></span>
                                            {#if managerInstalled}
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-7 gap-1.5 px-2.5 text-sm"
                                                    onclick={() =>
                                                        busyOf(
                                                            `add:${provider}`,
                                                        )
                                                            ? void cancelAccountAdd(
                                                                  provider,
                                                              )
                                                            : void addAccount(
                                                                  provider,
                                                                  card.label,
                                                              )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            busyOf(
                                                                `add:${provider}`,
                                                            )
                                                                ? 'lucideX'
                                                                : 'lucideUserPlus',
                                                        )}
                                                        class="size-3.5"
                                                    />
                                                    {busyOf(`add:${provider}`)
                                                        ? 'Cancel'
                                                        : 'Add account'}
                                                </ZButton>
                                                <ZButton
                                                    zWave={false}
                                                    zType="outline"
                                                    zSize="sm"
                                                    class="h-7 gap-1.5 px-2.5 text-sm"
                                                    disabled={isRefreshingCard(
                                                        card.id,
                                                    )}
                                                    aria-label="Refresh all accounts for {card.label}"
                                                    onclick={() =>
                                                        void refreshCardAccounts(
                                                            card,
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            isRefreshingCard(
                                                                card.id,
                                                            )
                                                                ? 'lucideLoaderCircle'
                                                                : 'lucideRefreshCw',
                                                        )}
                                                        class="size-3.5 {isRefreshingCard(
                                                            card.id,
                                                        )
                                                            ? 'animate-spin'
                                                            : ''}"
                                                    />
                                                    Refresh all accounts
                                                </ZButton>
                                            {/if}
                                        </div>

                                        {#if !managerInstalled}
                                            <div
                                                class="flex items-center gap-3 rounded-lg border border-dashed border-border p-3"
                                            >
                                                <div
                                                    class="min-w-0 flex-1 text-sm text-muted-foreground"
                                                >
                                                    <span
                                                        class="text-foreground"
                                                        >Switch between accounts</span
                                                    >
                                                    needs
                                                    <b>{manager.label}</b>. {manager.why}
                                                    {#if connectors.errors[`install:${manager.id}`]}<div
                                                            class="mt-1 text-destructive"
                                                            role="alert"
                                                        >
                                                            {connectors.errors[
                                                                `install:${manager.id}`
                                                            ]}
                                                        </div>{/if}
                                                    {#each lastLog(manager.id) as line, index (index)}<div
                                                            class="truncate font-mono text-[0.6875rem]"
                                                        >
                                                            {line}
                                                        </div>{/each}
                                                </div>
                                                <ZButton
                                                    zWave={false}
                                                    zSize="sm"
                                                    class="h-8 shrink-0 gap-1.5 px-3 text-sm"
                                                    disabled={Boolean(
                                                        busyOf(
                                                            `install:${manager.id}`,
                                                        ),
                                                    )}
                                                    onclick={() =>
                                                        void install(
                                                            manager.id,
                                                            manager.label,
                                                        )}
                                                >
                                                    <ZIcon
                                                        zType={icon(
                                                            connectors.busy[
                                                                `install:${manager.id}`
                                                            ]
                                                                ? 'lucideLoaderCircle'
                                                                : 'lucideDownload',
                                                        )}
                                                        class="size-3.5 {connectors
                                                            .busy[
                                                            `install:${manager.id}`
                                                        ]
                                                            ? 'animate-spin'
                                                            : ''}"
                                                    /> Install {manager.label}
                                                </ZButton>
                                            </div>
                                        {:else if accountsRefreshing}
                                            <div
                                                class="grid gap-2 sm:grid-cols-2"
                                                aria-label="Loading accounts"
                                                aria-busy="true"
                                            >
                                                {#each [0, 1, 2, 3] as placeholder (placeholder)}
                                                    <div
                                                        class="animate-pulse rounded-lg border border-border p-3 min-h-[96px]"
                                                    >
                                                        <div
                                                            class="h-4 w-2/3 rounded bg-muted"
                                                        ></div>
                                                        <div
                                                            class="mt-3 h-2 w-full rounded bg-muted/70"
                                                        ></div>
                                                        <div
                                                            class="mt-2 h-2 w-4/5 rounded bg-muted/50"
                                                        ></div>
                                                    </div>
                                                {/each}
                                            </div>
                                        {:else if list?.error}
                                            <p
                                                class="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                                                role="alert"
                                            >
                                                {list.error}
                                            </p>
                                        {:else if connectors.errors[`accounts:${provider}`]}
                                            <p
                                                class="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                                                role="alert"
                                            >
                                                {connectors.errors[
                                                    `accounts:${provider}`
                                                ]}
                                            </p>
                                        {:else if !list || list.accounts.length === 0}
                                            <p
                                                class="rounded-lg border border-dashed border-border p-3 text-[0.75rem] text-muted-foreground"
                                            >
                                                {#if list}No saved accounts yet.
                                                    Sign in above, then use “Add
                                                    account” to save it, or add
                                                    another one.{:else}Reading
                                                    accounts<span
                                                        class="loading-dots"
                                                        aria-hidden="true"
                                                        ><span>.</span><span
                                                            >.</span
                                                        ><span>.</span></span
                                                    >{/if}
                                            </p>
                                        {:else}
                                            {#key refreshGeneration[card.id] ?? 0}
                                                <ul
                                                    class="grid gap-2 sm:grid-cols-2"
                                                >
                                                    {#each list.accounts as account, accountIndex (account.id)}
                                                        {@const authRequired =
                                                            needsLogin(account)}
                                                        {@const accountRefreshing =
                                                            refreshing ===
                                                            account.id}
                                                        <li
                                                            class="min-w-0 rounded-lg border p-3 {account.active
                                                                ? 'border-emerald-500/50 bg-emerald-500/5'
                                                                : 'border-border'}"
                                                            in:fly={{
                                                                y: 18,
                                                                duration: 300,
                                                                delay:
                                                                    accountIndex *
                                                                    70,
                                                            }}
                                                        >
                                                            <div
                                                                class="flex items-center gap-2"
                                                            >
                                                                <span
                                                                    class="min-w-0 flex-1"
                                                                >
                                                                    <span
                                                                        class="flex items-center gap-2"
                                                                    >
                                                                        <span
                                                                            class="truncate text-sm font-medium"
                                                                            >{account.alias ??
                                                                                account.email}</span
                                                                        >
                                                                        {#if account.plan}<span
                                                                                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase {planClass(
                                                                                    account.plan,
                                                                                )}"
                                                                                >{account.plan}</span
                                                                            >{/if}
                                                                        {#if account.active}<span
                                                                                class="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                                                                                >IN
                                                                                USE</span
                                                                            >{/if}
                                                                    </span>
                                                                    {#if account.alias}<span
                                                                            class="block truncate text-[0.75rem] text-muted-foreground"
                                                                            >{account.email}</span
                                                                        >{/if}
                                                                </span>
                                                                {#if authRequired}
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="size-6! shrink-0 p-0 text-destructive hover:!border-destructive/60 hover:!bg-destructive/10 hover:!text-destructive"
                                                                        disabled={Boolean(
                                                                            working,
                                                                        )}
                                                                        aria-label="Sign in again for {account.email}"
                                                                        title={connectors
                                                                            .busy[
                                                                            `login:${card.id}`
                                                                        ]
                                                                            ? 'Waiting for sign-in'
                                                                            : 'Sign in again'}
                                                                        onclick={() =>
                                                                            void login(
                                                                                provider,
                                                                                card.label,
                                                                            )}
                                                                    >
                                                                        <ZIcon
                                                                            zType={icon(
                                                                                connectors
                                                                                    .busy[
                                                                                    `login:${card.id}`
                                                                                ]
                                                                                    ? 'lucideLoaderCircle'
                                                                                    : 'lucideLogIn',
                                                                            )}
                                                                            class="size-3 {connectors
                                                                                .busy[
                                                                                `login:${card.id}`
                                                                            ]
                                                                                ? 'animate-spin'
                                                                                : ''}"
                                                                        />
                                                                    </ZButton>
                                                                {/if}
                                                                {#if !account.active && !authRequired}
                                                                    {@const switching =
                                                                        Boolean(
                                                                            connectors.busy[
                                                                                `switch:${provider}`
                                                                            ]?.endsWith(
                                                                                account.email,
                                                                            ),
                                                                        )}
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="size-6! shrink-0 p-0"
                                                                        aria-label="Use {account.email}"
                                                                        title="Use this account"
                                                                        disabled={Boolean(
                                                                            busyOf(
                                                                                `switch:${provider}`,
                                                                            ),
                                                                        )}
                                                                        onclick={() =>
                                                                            void switchAccount(
                                                                                provider,
                                                                                account,
                                                                            )}
                                                                    >
                                                                        <ZIcon
                                                                            zType={icon(
                                                                                switching
                                                                                    ? 'lucideLoaderCircle'
                                                                                    : 'lucideArrowLeftRight',
                                                                            )}
                                                                            class="size-3 {switching
                                                                                ? 'animate-spin'
                                                                                : ''}"
                                                                        />
                                                                    </ZButton>
                                                                {/if}
                                                                {#if !account.active}
                                                                    {@const removing =
                                                                        Boolean(
                                                                            connectors
                                                                                .busy[
                                                                                `remove:${provider}:${account.id}`
                                                                            ],
                                                                        )}
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="size-6! shrink-0 p-0 text-muted-foreground hover:!border-destructive/60 hover:!bg-destructive/10 hover:!text-destructive"
                                                                        aria-label="Remove {account.email}"
                                                                        aria-busy={removing}
                                                                        title="Remove from the list"
                                                                        disabled={removing}
                                                                        onclick={() =>
                                                                            void removeAccount(
                                                                                provider,
                                                                                account,
                                                                            )}
                                                                    >
                                                                        <ZIcon
                                                                            zType={icon(
                                                                                removing
                                                                                    ? 'lucideLoaderCircle'
                                                                                    : 'lucideTrash2',
                                                                            )}
                                                                            class="size-3 {removing
                                                                                ? 'animate-spin'
                                                                                : ''}"
                                                                        />
                                                                    </ZButton>
                                                                {/if}
                                                                <ZButton
                                                                    zWave={false}
                                                                    zType="outline"
                                                                    zSize="sm"
                                                                    class="size-6! shrink-0 p-0"
                                                                    aria-label="Refresh {account.email}"
                                                                    title="Refresh this account"
                                                                    disabled={Boolean(
                                                                        busyOf(
                                                                            `accounts:${provider}`,
                                                                        ),
                                                                    )}
                                                                    onclick={() => {
                                                                        refreshing =
                                                                            account.id;
                                                                        void refreshAccount(
                                                                            provider,
                                                                            account.id,
                                                                        ).finally(
                                                                            () =>
                                                                                (refreshing =
                                                                                    ''),
                                                                        );
                                                                    }}
                                                                >
                                                                    <ZIcon
                                                                        zType={icon(
                                                                            accountRefreshing
                                                                                ? 'lucideLoaderCircle'
                                                                                : 'lucideRefreshCw',
                                                                        )}
                                                                        class="size-3 {accountRefreshing
                                                                            ? 'animate-spin'
                                                                            : ''}"
                                                                    />
                                                                </ZButton>
                                                            </div>
                                                            {#if account.usage.length > 0}
                                                                <div
                                                                    class="mt-2.5 grid gap-y-2.5"
                                                                >
                                                                    {#each account.usage as window (window.label)}
                                                                        {@const pct =
                                                                            shown(
                                                                                window,
                                                                                ticker.sec,
                                                                            )}
                                                                        <div>
                                                                            <div
                                                                                class="mb-1 flex items-baseline justify-between gap-2 text-[0.6875rem]"
                                                                            >
                                                                                <span
                                                                                    class="text-muted-foreground"
                                                                                    >{window.label}
                                                                                    window</span
                                                                                >
                                                                                <span
                                                                                    class="tabular-nums {pct >=
                                                                                    90
                                                                                        ? 'font-medium text-destructive'
                                                                                        : ''}"
                                                                                    >{Math.round(
                                                                                        pct,
                                                                                    )}%</span
                                                                                >
                                                                            </div>
                                                                            <div
                                                                                class="h-1.5 overflow-hidden rounded-full bg-muted-foreground/25"
                                                                                role="progressbar"
                                                                                aria-valuenow={Math.round(
                                                                                    pct,
                                                                                )}
                                                                                aria-valuemin="0"
                                                                                aria-valuemax="100"
                                                                                aria-label="{window.label} usage"
                                                                            >
                                                                                <div
                                                                                    class="h-full rounded-full transition-[width] duration-500 {barColor(
                                                                                        pct,
                                                                                    )}"
                                                                                    style:width="{pct}%"
                                                                                ></div>
                                                                            </div>
                                                                            {#if countdown(window.resets_at, ticker.sec)}
                                                                                <div
                                                                                    class="mt-1 text-[0.75rem] text-muted-foreground tabular-nums"
                                                                                >
                                                                                    {countdown(
                                                                                        window.resets_at,
                                                                                        ticker.sec,
                                                                                    )}
                                                                                </div>
                                                                            {/if}
                                                                        </div>
                                                                    {/each}
                                                                </div>
                                                                {#if stale(account, ticker.min)}<p
                                                                        class="mt-1.5 text-[0.75rem] text-muted-foreground"
                                                                    >
                                                                        Figures
                                                                        are
                                                                        older
                                                                        than 15
                                                                        minutes.
                                                                        Use
                                                                        Refresh.
                                                                    </p>{/if}
                                                                {#if account.status}<p
                                                                        class="mt-1.5 text-[0.75rem] text-muted-foreground"
                                                                        role="status"
                                                                    >
                                                                        {account.status}
                                                                    </p>{/if}
                                                            {:else if account.expired}
                                                                <p
                                                                    class="mt-1.5 text-[0.6875rem] text-destructive"
                                                                    role="alert"
                                                                >
                                                                    Signed out:
                                                                    the login
                                                                    expired
                                                                    (401). Sign
                                                                    in again to
                                                                    use this
                                                                    account; it
                                                                    cannot be
                                                                    switched to
                                                                    until then.
                                                                </p>
                                                            {:else if account.status}
                                                                <p
                                                                    class="mt-1.5 text-[0.75rem] text-muted-foreground"
                                                                >
                                                                    {account.status}
                                                                </p>
                                                            {/if}
                                                            {#if provider === 'codex'}
                                                                {@const resetCredits =
                                                                    account.reset_credits_available}
                                                                {@const resetBusy =
                                                                    Boolean(
                                                                        connectors
                                                                            .busy[
                                                                            `reset:${account.email}`
                                                                        ],
                                                                    )}
                                                                {@const resetError =
                                                                    connectors
                                                                        .errors[
                                                                        `reset:${account.email}`
                                                                    ]}
                                                                <div
                                                                    class="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5 text-[0.6875rem]"
                                                                >
                                                                    <ZIcon
                                                                        zType={icon(
                                                                            'lucideRotateCcw',
                                                                        )}
                                                                        class="size-3 shrink-0 text-muted-foreground"
                                                                    />
                                                                    <span
                                                                        class="min-w-0 flex-1 truncate text-muted-foreground"
                                                                    >
                                                                        {#if resetBusy}Redeeming
                                                                            reset…{:else if resetCredits !== undefined}Available
                                                                            resets:
                                                                            <b
                                                                                class="text-foreground tabular-nums"
                                                                                >{resetCredits}</b
                                                                            >{:else}Reset
                                                                            count
                                                                            unavailable{/if}
                                                                    </span>
                                                                    <ZButton
                                                                        zWave={false}
                                                                        zType="outline"
                                                                        zSize="sm"
                                                                        class="h-6 shrink-0 gap-1 px-2 text-[0.6875rem] {resetBusy
                                                                            ? 'border-primary/40 text-primary'
                                                                            : ''}"
                                                                        aria-busy={resetBusy}
                                                                        disabled={resetCredits ===
                                                                            undefined ||
                                                                            resetCredits <
                                                                                1 ||
                                                                            resetBusy}
                                                                        onclick={() =>
                                                                            (resetAsk =
                                                                                account.email)}
                                                                    >
                                                                        {#if resetBusy}<ZIcon
                                                                                zType={icon(
                                                                                    'lucideLoaderCircle',
                                                                                )}
                                                                                class="size-3 animate-spin"
                                                                            />Resetting…{:else}Reset
                                                                            limit{/if}
                                                                    </ZButton>
                                                                </div>
                                                                {#if resetError}<p
                                                                        class="mt-1 text-[0.6875rem] text-destructive"
                                                                        role="alert"
                                                                    >
                                                                        {resetError}
                                                                    </p>{/if}
                                                            {/if}
                                                        </li>
                                                    {/each}
                                                </ul>
                                            {/key}
                                            {@const removeError =
                                                Object.entries(
                                                    connectors.errors,
                                                ).find(([key]) =>
                                                    key.startsWith(
                                                        `remove:${provider}:`,
                                                    ),
                                                )?.[1]}
                                            {#if connectors.errors[`switch:${provider}`] || removeError}
                                                <p
                                                    class="mt-2 text-sm text-destructive"
                                                    role="alert"
                                                >
                                                    {connectors.errors[
                                                        `switch:${provider}`
                                                    ] ?? removeError}
                                                </p>
                                            {/if}
                                            <p
                                                class="mt-2 text-[0.75rem] text-muted-foreground"
                                            >
                                                A chat that is already running
                                                keeps its account; the next
                                                message uses the new one.
                                            </p>
                                        {/if}
                                    </div>
                                {/if}
                            </section>
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</div>
