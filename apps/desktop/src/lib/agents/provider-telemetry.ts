/** Bounded, process-local provider turn metrics. Stores only provider ids and numeric outcomes. */
export type ProviderMetric = {
    provider: string;
    samples: number[];
    successes: number;
    errors: number;
    lastSampleAt: number;
};

export type TerminalOutcome = 'success' | 'error';

const MAX_PROVIDERS = 64;
const MAX_SAMPLES = 50;
const MAX_TERMINALS = 512;
export const PROVIDER_METRIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const metrics = new Map<string, ProviderMetric>();
const terminalIds = new Set<string>();

/** Records one completed turn; repeated terminal events with the same identity count once. */
export function recordProviderTurn(
    provider: string,
    terminalId: string,
    durationMs: number,
    outcome: TerminalOutcome,
    now = Date.now(),
): boolean {
    if (
        !provider ||
        !terminalId ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
    )
        return false;
    const identity = `${provider}\u0000${terminalId}`;
    if (terminalIds.has(identity)) return false;
    terminalIds.add(identity);
    if (terminalIds.size > MAX_TERMINALS)
        terminalIds.delete(terminalIds.values().next().value!);

    let metric = metrics.get(provider);
    if (!metric) {
        if (metrics.size >= MAX_PROVIDERS)
            metrics.delete(metrics.keys().next().value!);
        metric = {
            provider,
            samples: [],
            successes: 0,
            errors: 0,
            lastSampleAt: now,
        };
        metrics.set(provider, metric);
    }
    metric.samples.push(durationMs);
    if (metric.samples.length > MAX_SAMPLES) metric.samples.shift();
    if (outcome === 'success') metric.successes++;
    else metric.errors++;
    metric.lastSampleAt = now;
    return true;
}

/** Returns only fresh samples; stale or unknown providers have no observed latency. */
export function providerLatency(
    provider: string,
    now = Date.now(),
): number | undefined {
    const metric = metrics.get(provider);
    if (
        !metric?.samples.length ||
        metric.successes < metric.errors ||
        now - metric.lastSampleAt > PROVIDER_METRIC_MAX_AGE_MS ||
        now < metric.lastSampleAt
    )
        return undefined;
    return (
        metric.samples.reduce((sum, sample) => sum + sample, 0) /
        metric.samples.length
    );
}

/** Sorts only slots with fresh observations, leaving unobserved routes at their configured positions. */
export function orderProvidersByObservedLatency<T extends { provider: string }>(
    routes: T[],
    now = Date.now(),
): T[] {
    const slots: number[] = [];
    const observed: { route: T; latency: number }[] = [];
    routes.forEach((route, index) => {
        const latency = providerLatency(route.provider, now);
        if (latency !== undefined) {
            slots.push(index);
            observed.push({ route, latency });
        }
    });
    observed.sort((a, b) => a.latency - b.latency);
    const result = [...routes];
    slots.forEach((index, slot) => (result[index] = observed[slot].route));
    return result;
}

/** Test-only readout of numeric metrics; no messages, models, or credentials are retained. */
export function providerMetricSnapshot(
    provider: string,
): ProviderMetric | undefined {
    const metric = metrics.get(provider);
    return metric ? { ...metric, samples: [...metric.samples] } : undefined;
}

/** Test isolation. */
export function resetProviderTelemetry(): void {
    metrics.clear();
    terminalIds.clear();
}
