import assert from 'node:assert/strict';
import test from 'node:test';
import {
    orderProvidersByObservedLatency,
    providerLatency,
    providerMetricSnapshot,
    PROVIDER_METRIC_MAX_AGE_MS,
    recordProviderTurn,
    resetProviderTelemetry,
} from './provider-telemetry.ts';

test('aggregates completed provider turn latency and outcomes', () => {
    resetProviderTelemetry();
    assert.equal(recordProviderTurn('alpha', 't1', 100, 'success', 1000), true);
    assert.equal(recordProviderTurn('alpha', 't2', 300, 'error', 2000), true);
    assert.deepEqual(providerMetricSnapshot('alpha'), {
        provider: 'alpha',
        samples: [100, 300],
        successes: 1,
        errors: 1,
        lastSampleAt: 2000,
    });
    assert.equal(providerLatency('alpha', 2000), 200);
});

test('keeps configured slots for unknown and stale providers during fast ordering', () => {
    resetProviderTelemetry();
    const routes = ['slow', 'unknown-a', 'fast', 'unknown-b', 'stale'].map(
        (provider) => ({ provider }),
    );
    recordProviderTurn('slow', 't1', 900, 'success', 1000);
    recordProviderTurn('fast', 't2', 100, 'success', 1000);
    recordProviderTurn('stale', 't3', 50, 'success', 1000);
    assert.deepEqual(
        orderProvidersByObservedLatency(
            routes,
            1000 + PROVIDER_METRIC_MAX_AGE_MS + 1,
        ),
        routes,
    );
    assert.deepEqual(
        orderProvidersByObservedLatency(routes, 1000).map(
            (route) => route.provider,
        ),
        ['stale', 'unknown-a', 'fast', 'unknown-b', 'slow'],
    );
    assert.equal(providerLatency('missing', 2000), undefined);
});

test('deduplicates repeated terminal events by provider and turn identity', () => {
    resetProviderTelemetry();
    assert.equal(
        recordProviderTurn('alpha', 'turn-1', 100, 'success', 1000),
        true,
    );
    assert.equal(
        recordProviderTurn('alpha', 'turn-1', 500, 'error', 2000),
        false,
    );
    assert.deepEqual(providerMetricSnapshot('alpha'), {
        provider: 'alpha',
        samples: [100],
        successes: 1,
        errors: 0,
        lastSampleAt: 1000,
    });
});

test('does not rank a provider with more errors than successes as fast', () => {
    resetProviderTelemetry();
    const routes = ['unhealthy', 'unknown', 'healthy'].map((provider) => ({
        provider,
    }));
    recordProviderTurn('unhealthy', 'e1', 10, 'error', 1000);
    recordProviderTurn('unhealthy', 'e2', 20, 'error', 1001);
    recordProviderTurn('healthy', 's1', 500, 'success', 1000);

    assert.deepEqual(
        orderProvidersByObservedLatency(routes, 1001).map(
            (route) => route.provider,
        ),
        ['unhealthy', 'unknown', 'healthy'],
    );
    assert.equal(providerLatency('unhealthy', 1001), undefined);
});
