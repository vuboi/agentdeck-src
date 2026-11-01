// Tokens a reply used and what they cost. The CLI reports tokens as it goes; its exact cost only at the end,
// so a running reply first uses the refreshed provider catalog, then the fallback list prices below (USD per million tokens).

import { getPref, setPref } from '../../app/platform/prefs';
import { inTauri } from '../../app/platform/history';
import { baseModel } from '../../agents/credit-model';

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

type Price = { input: number; output: number; cacheRead: number };
type PriceEntry = Price | (() => Price);
type RemotePrice = { input: number; output: number; cacheRead?: number };
/** Fallback API list prices in USD per million tokens for models absent from the refreshed provider catalog. */
const MODEL_PRICE_TABLE: Record<string, PriceEntry> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2 },
  'gpt-6.1-terra': { input: 1, output: 5, cacheRead: 0.05 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02 },
  'gemini-4-argon': () =>
    Date.now() >= Date.UTC(2026, 11, 1)
      ? { input: 4, output: 20, cacheRead: 0.2 }
      : { input: 2, output: 10, cacheRead: 0.1 },
  'gemini-flash-latest': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  // DeepSeek's current peak-hour rates; off-peak billing is lower and time-dependent.
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.03 },
  'deepseek-v4.1-flash': { input: 0.3, output: 1.2, cacheRead: 0.03 },
  'deepseek-v4.1-flash-1017': { input: 0.3, output: 1.2, cacheRead: 0.03 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.03 },
  'deepseek-chat': { input: 0.3, output: 1.2, cacheRead: 0.03 },
  'deepseek-reasoner': { input: 0.3, output: 1.2, cacheRead: 0.03 },
  'deepseek-v4-flash-0731': { input: 0.44, output: 1.32, cacheRead: 0.044 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.132 },
  'deepseek-v4-pro-0813': { input: 1.32, output: 3.96, cacheRead: 0.132 },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19 },
  'kimi-k2.6': { input: 0.95, output: 4, cacheRead: 0.16 },
  'kimi-k2.5': { input: 0.574, output: 3.011, cacheRead: 0.1 },
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'glm-5': { input: 1, output: 3.2, cacheRead: 0.2 },
  'glm-4.7': { input: 0.6, output: 2.2, cacheRead: 0.11 },
  'glm-4.6': { input: 0.6, output: 2.2, cacheRead: 0.11 },
  'glm-4.7-flash': { input: 0, output: 0, cacheRead: 0 },
  'minimax-m2.5': { input: 0.304, output: 1.213, cacheRead: 0.061 },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.016 },
  'qwen3.8-max': { input: 2, output: 6, cacheRead: 0.25 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04 },
  // Qwen's first qwen3-coder-plus tier is CNY 4/16/0.8 per million tokens; converted at ~7.2 CNY/USD.
  'qwen3-coder-plus': { input: 0.56, output: 2.22, cacheRead: 0.11 },
  'opencode/big-pickle': { input: 0, output: 0, cacheRead: 0 },
};

// Prices the user typed for models that have none above (Codex, Gemini, local ones...): kept in prefs, read once at
// start, and used for every reply, past ones included (the dashboard works a cost out again when the reply had none).
const PRICES_KEY = 'usage.prices';
const custom: Record<string, Price> = {};
const REMOTE_PRICES_KEY = 'usage.remote-prices';
const REMOTE_PRICE_TTL = 24 * 60 * 60 * 1000;
const REMOTE_RETRY_DELAY = 10 * 60 * 1000;
const remote: Record<string, RemotePrice> = {};
const priceListeners = new Set<() => void>();
let remoteFetch: Promise<void> | undefined;
let remoteFetchAttemptedAt = 0;

const notifyPriceListeners = () => {
  for (const listener of priceListeners) listener();
};

if (typeof window !== 'undefined') {
  void getPref<Record<string, Price>>(PRICES_KEY).then((saved) => {
    if (saved) Object.assign(custom, saved);
    notifyPriceListeners();
  });
  void getPref<{ savedAt: number; prices: Record<string, RemotePrice> }>(REMOTE_PRICES_KEY).then((saved) => {
    if (!saved || Date.now() - saved.savedAt > REMOTE_PRICE_TTL) return;
    Object.assign(remote, saved.prices);
    notifyPriceListeners();
  });
}
/** Calls `listener` when a price is set or loaded; returns how to stop. */
export function onPrices(listener: () => void) {
  priceListeners.add(listener);
  return () => void priceListeners.delete(listener);
}
/** The price per million tokens of a model: the built-in one, else the one the user typed. */
/** A free model (OpenCode's `…-free`, a provider's free tier): it costs nothing, so its replies count as $0. */
export const isFreeModel = (model: string | undefined) => Boolean(model && /(?:^|[-_:/ ])free(?:$|[-_:/ ])/i.test(model));
const FREE: Price = { input: 0, output: 0, cacheRead: 0 };
/** A model with no list price, estimated from the tier its name says: the small, fast ones (flash, mini, lite…) at the
 *  small-model rate. Only an estimate (shown with ≈), and a typed price wins over it. */
const SMALL_TIER = /(?:flash|mini|lite|nano|haiku|luna|small)/i;
const SMALL_PRICE: Price = { input: 0.1, output: 0.5, cacheRead: 0.01 };
/** Any other model without a list price: a mid-size rate, so every reply has a cost estimate (shown with ≈). */
const MID_PRICE: Price = { input: 1, output: 5, cacheRead: 0.1 };
const normalizedSlug = (model: string) => {
  const withoutProvider = model.split('::').pop() ?? model;
  const withoutRoute = withoutProvider.split('/').pop() ?? withoutProvider;
  return withoutRoute.split(':')[0].replace(/\./g, '-').toLowerCase();
};

const providerRank = (model: string, candidate: string) => {
  const slug = normalizedSlug(model);
  const preferred = slug.startsWith('claude-')
    ? 'anthropic/'
    : slug.startsWith('gpt-')
      ? 'openai/'
      : slug.startsWith('gemini-')
        ? 'google/'
        : slug.startsWith('deepseek-')
          ? 'deepseek/'
          : slug.startsWith('kimi-')
            ? 'moonshotai/'
            : slug.startsWith('glm-')
              ? 'z-ai/'
              : slug.startsWith('qwen')
                ? 'qwen/'
                : slug.startsWith('minimax-')
                  ? 'minimax/'
                  : '';
  return preferred && candidate.startsWith(preferred) ? 0 : 1;
};

const tableEntry = (model: string): PriceEntry | undefined => {
  const key = model.toLowerCase();
  return (
    MODEL_PRICE_TABLE[key] ??
    Object.entries(MODEL_PRICE_TABLE).find(([id]) => key.endsWith(`/${id}`) || key.endsWith(`:${id}`) || key.endsWith(`@${id}`))?.[1]
  );
};

const tablePrice = (model: string): Price | undefined => {
  const entry = tableEntry(model);
  return entry ? (typeof entry === 'function' ? entry() : entry) : undefined;
};

const remotePrice = (model: string): Price | undefined => {
  const key = model.toLowerCase();
  const exact = remote[key];
  const match =
    exact ??
    Object.entries(remote)
      .filter(([id]) => normalizedSlug(id) === normalizedSlug(model))
      .sort(([left], [right]) => providerRank(model, left) - providerRank(model, right))[0]?.[1];
  if (!match) return undefined;
  const fallback = tablePrice(model);
  return {
    input: match.input,
    output: match.output,
    cacheRead: match.cacheRead ?? fallback?.cacheRead ?? 0,
  };
};

const refreshRemotePrices = () => {
  if (typeof window === 'undefined' || !inTauri()) return;
  if (remoteFetch || Date.now() - remoteFetchAttemptedAt < REMOTE_RETRY_DELAY) return;
  remoteFetchAttemptedAt = Date.now();
  remoteFetch = import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<Array<{ model: string; input: number; output: number; cacheRead?: number }>>('model_price_catalog'))
    .then((rows) => {
      for (const row of rows) {
        if (!row.model || !Number.isFinite(row.input) || !Number.isFinite(row.output)) continue;
        remote[row.model.toLowerCase()] = {
          input: row.input,
          output: row.output,
          cacheRead: Number.isFinite(row.cacheRead) ? row.cacheRead : undefined,
        };
      }
      void setPref(REMOTE_PRICES_KEY, { savedAt: Date.now(), prices: { ...remote } });
      notifyPriceListeners();
    })
    .catch(() => undefined)
    .finally(() => {
      remoteFetch = undefined;
    });
};

const listed = (model: string): Price => {
  if (isFreeModel(model)) return FREE;
  return tablePrice(model) ?? (SMALL_TIER.test(model) ? SMALL_PRICE : MID_PRICE);
};
// A `credit:` model is the same model billed to the API credit: it costs what that model costs.
export const priceOf = (model: string | undefined): Price | undefined => {
  if (!model) return undefined;
  const base = baseModel(model);
  if (isFreeModel(base)) return FREE;
  const price = custom[model] ?? custom[base] ?? remotePrice(base);
  if (price) return price;
  refreshRemotePrices();
  return listed(base);
};
/** Saves a price for a model (`null` removes it). */
export function setModelPrice(model: string, price: Price | null) {
  if (price) custom[model] = price;
  else delete custom[model];
  setPref(PRICES_KEY, { ...custom });
  notifyPriceListeners();
}
export type { Price };

/** Estimated cost in USD, or null when the model's price is unknown. Cache writes cost 1.25x input. */
export function estimateCost(tokens: Tokens, model: string | undefined): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const perM = (count: number, rate: number) => (count / 1_000_000) * rate;
  return perM(tokens.input, price.input) + perM(tokens.cacheWrite, price.input * 1.25) + perM(tokens.cacheRead, price.cacheRead) + perM(tokens.output, price.output);
}

/** 950, 12.3k, 1.2M */
export function shortCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export const usd = (value: number) => (value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`);

/** All tokens the reply moved: what it read (fresh and cached) and what it wrote. */
export const totalTokens = (tokens: Tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

/** What each kind of token cost, in USD (null when the model's price is unknown). */
export function costParts(tokens: Tokens, model: string | undefined) {
  const price = priceOf(model);
  if (!price) return null;
  const perM = (count: number, rate: number) => (count / 1_000_000) * rate;
  return {
    input: perM(tokens.input, price.input),
    cacheRead: perM(tokens.cacheRead, price.cacheRead),
    cacheWrite: perM(tokens.cacheWrite, price.input * 1.25),
    output: perM(tokens.output, price.output),
  };
}

/** One finished reply, as kept for the usage dashboard. `cost` is the CLI's exact figure when it gave one. */
export type UsageRecord = {
  at: string;
  sessionId: string;
  agent: string;
  model?: string;
  projectId?: string;
  ms?: number;
  tokens: Tokens;
  cost: number | null;
  estimated: boolean;
};

const LOG_KEY = 'usage.log';
const listeners = new Set<() => void>();
/** Calls `listener` whenever a reply is added to the log; returns how to stop. */
export function onUsage(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const LOG_LIMIT = 20000;
let writing: Promise<void> = Promise.resolve();

/** Appends a reply to the usage log (IndexedDB), one write at a time. */
export function recordUsage(record: UsageRecord) {
  writing = writing.then(async () => {
    const log = (await getPref<UsageRecord[]>(LOG_KEY)) ?? [];
    log.push(record);
    setPref(LOG_KEY, log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log);
    for (const listener of listeners) listener();
    // One failed write (or a listener that throws) must not leave the chain rejected: every later record was skipped.
  }).catch(() => undefined);
}

export const usageLog = async () => (await getPref<UsageRecord[]>(LOG_KEY)) ?? [];
