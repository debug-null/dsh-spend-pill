/**
 * Host half of the cost-pill bundle.
 *
 * Registers one session projection (`tokenCost`) that prices durable provider
 * usage the way DeepSeek actually bills it: every settled assistant attempt is
 * priced with the model's official list price for the period it ran in
 * (peak or off-peak), so a Turn that crosses the peak boundary or a Session
 * that switches models still adds up correctly. The browser half renders the
 * value; this half never touches the UI.
 *
 * Prices: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

export const inject = ['sessionProjections'];

const PER_MILLION = 1000000;

/**
 * Official DeepSeek list prices, CNY per 1,000,000 tokens.
 * Peak hours are Beijing time (UTC+8), Monday–Friday 09:00–12:00 and
 * 14:00–18:00; every other hour bills at half the peak rate. Chinese public
 * holidays also bill off-peak but have no fixed weekday rule, so they are
 * estimated at the weekday rate here.
 */
const MODEL_PRICES = {
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
};

/** Legacy ids the provider still accepts and bills at the Flash price. */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** Price fallback for a model this local bundle does not describe. */
const FALLBACK_MODEL = 'deepseek-flash';

const TOKEN_KEYS = [
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
];

const COST_KEYS = ['inputCny', 'cacheReadCny', 'cacheWriteCny', 'outputCny'];

const count = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const round = (value) => Math.round(value * PER_MILLION) / PER_MILLION;

function emptyTokens() {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
}

function emptyCosts() {
  return { inputCny: 0, cacheReadCny: 0, cacheWriteCny: 0, outputCny: 0 };
}

function emptyTotals() {
  return {
    cny: 0,
    peakCny: 0,
    offPeakCny: 0,
    tokens: emptyTokens(),
    costs: emptyCosts(),
    models: {},
    fallback: false,
  };
}

function emptyState() {
  return { model: null, totals: emptyTotals(), last: null };
}

/** Peak window in Beijing time; UTC+8 has no DST, so the shift is exact. */
function isPeakTime(time) {
  if (!Number.isFinite(time)) return false;
  const beijing = new Date(time + 8 * 3600 * 1000);
  const weekday = beijing.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

function ratesFor(modelId) {
  const canonical = MODEL_ALIASES[modelId] ?? modelId;
  const rates = MODEL_PRICES[canonical];
  return rates === undefined
    ? { ...MODEL_PRICES[FALLBACK_MODEL], fallback: true }
    : rates;
}

/**
 * Usage of one settled attempt: the durable field when present, otherwise the
 * last `usage` chunk of the same settlement's compact stream.
 */
function usageOf(event) {
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  if (data.usage !== undefined) return data.usage;
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (
      record !== null &&
      typeof record === 'object' &&
      record.type === 'chunk' &&
      record.chunk !== null &&
      typeof record.chunk === 'object' &&
      record.chunk.type === 'usage'
    ) {
      return record.chunk.usage;
    }
  }
  return undefined;
}

/** The same four buckets the shipped `tokenUsage` projection folds. */
function bucketsOf(usage) {
  return {
    uncachedInputTokens: count(usage.inputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    outputTokens: count(usage.outputTokens),
  };
}

function sameBuckets(left, right) {
  return TOKEN_KEYS.every((key) => left[key] === right[key]);
}

/** Price one attempt at the model and period that applied when it settled. */
function contributionFor(model, buckets, time) {
  const provider = model === null ? 'unknown' : model.provider;
  const modelId = model === null ? 'unknown' : model.model;
  const rates = ratesFor(modelId);
  const peak = isPeakTime(time);
  const price = peak ? rates.peak : rates.offPeak;
  const costs = {
    inputCny: (buckets.uncachedInputTokens * price.cacheMiss) / PER_MILLION,
    cacheReadCny: (buckets.cacheReadTokens * price.cacheHit) / PER_MILLION,
    cacheWriteCny: 0,
    outputCny: (buckets.outputTokens * price.output) / PER_MILLION,
  };
  const cny = costs.inputCny + costs.cacheReadCny + costs.outputCny;
  return {
    cny,
    peakCny: peak ? cny : 0,
    offPeakCny: peak ? 0 : cny,
    tokens: buckets,
    costs,
    modelKey: provider + '/' + modelId,
    provider,
    modelId,
    fallback: rates.fallback === true,
  };
}

/** Add (`sign = 1`) or replace-away (`sign = -1`) one attempt's contribution. */
function applyContribution(totals, contribution, sign) {
  const tokens = { ...totals.tokens };
  for (const key of TOKEN_KEYS) {
    tokens[key] = Math.max(0, tokens[key] + sign * contribution.tokens[key]);
  }
  const costs = { ...totals.costs };
  for (const key of COST_KEYS) {
    costs[key] = Math.max(0, costs[key] + sign * contribution.costs[key]);
  }
  const models = { ...totals.models };
  const previous = models[contribution.modelKey];
  const entryTokens = previous === undefined ? emptyTokens() : { ...previous.tokens };
  for (const key of TOKEN_KEYS) {
    entryTokens[key] = Math.max(0, entryTokens[key] + sign * contribution.tokens[key]);
  }
  models[contribution.modelKey] = {
    provider: contribution.provider,
    model: contribution.modelId,
    cny: Math.max(0, (previous === undefined ? 0 : previous.cny) + sign * contribution.cny),
    tokens: entryTokens,
  };
  return {
    cny: Math.max(0, totals.cny + sign * contribution.cny),
    peakCny: Math.max(0, totals.peakCny + sign * contribution.peakCny),
    offPeakCny: Math.max(0, totals.offPeakCny + sign * contribution.offPeakCny),
    tokens,
    costs,
    models,
    fallback: totals.fallback || (sign > 0 && contribution.fallback),
  };
}

/**
 * Fold one committed Session event. Mirrors the `tokenUsage` replacement rule:
 * a newer settlement of the same Turn and Step replaces the previous sample,
 * and `llm/retry-started` closes the slot so a retried attempt bills again.
 */
function fold(state, event) {
  if (event === null || typeof event !== 'object') return state;

  if (event.type === 'request/header') {
    const header = event.data === undefined ? undefined : event.data.header;
    const config = header === undefined ? undefined : header.config;
    if (config === null || typeof config !== 'object') return state;
    const provider = typeof config.provider === 'string' ? config.provider : '';
    const model = typeof config.model === 'string' ? config.model : '';
    if (provider === '' || model === '') return state;
    if (
      state.model !== null &&
      state.model.provider === provider &&
      state.model.model === model
    ) {
      return state;
    }
    return { ...state, model: { provider, model } };
  }

  if (event.type === 'llm/retry-started') {
    const data = event.data === undefined ? {} : event.data;
    if (state.last !== null && state.last.turn === data.turn && state.last.step === data.step) {
      return { ...state, last: null };
    }
    return state;
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;

  const usage = usageOf(event);
  if (usage === undefined) return state;

  const data = event.data === undefined ? {} : event.data;
  const turn = data.turn;
  const step = data.step;
  const buckets = bucketsOf(usage);
  const previous =
    state.last !== null && state.last.turn === turn && state.last.step === step
      ? state.last
      : null;
  if (previous !== null && sameBuckets(previous.buckets, buckets)) return state;

  const contribution = contributionFor(state.model, buckets, event.time);
  const base =
    previous === null ? state.totals : applyContribution(state.totals, previous.contribution, -1);
  const totals = applyContribution(base, contribution, 1);
  return { ...state, totals, last: { turn, step, buckets, contribution } };
}

/**
 * The projection registry expects schema objects with `parse()`. This linked
 * local bundle cannot resolve a `zod` instance from its own package root, so it
 * supplies the minimum the registry calls: states are accepted as stored (a
 * non-object falls back to an empty state) and the view is already built only
 * from finite numbers.
 */
const stateSchema = {
  parse(value) {
    if (
      value === null ||
      typeof value !== 'object' ||
      value.totals === null ||
      typeof value.totals !== 'object'
    ) {
      return emptyState();
    }
    return value;
  },
};

const viewSchema = { parse: (value) => value };

const view = (state) => {
  const totals = state.totals;
  const tokens = { ...totals.tokens };
  const costs = {};
  for (const key of COST_KEYS) costs[key] = round(totals.costs[key]);
  const models = Object.values(totals.models)
    .filter(
      (entry) =>
        entry.cny > 0 || TOKEN_KEYS.some((tokenKey) => entry.tokens[tokenKey] > 0),
    )
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      cny: round(entry.cny),
      tokens: { ...entry.tokens },
    }));
  return {
    cny: round(totals.cny),
    peakCny: round(totals.peakCny),
    offPeakCny: round(totals.offPeakCny),
    tokens,
    costs,
    models,
    fallback: totals.fallback === true,
  };
};

const tokenCostProjection = {
  key: 'tokenCost',
  stateVersion: 1,
  stateSchema,
  init: () => emptyState(),
  apply: fold,
  wire: { viewSchema, view },
};

export function apply(ctx) {
  ctx.effect(
    () => ctx.sessionProjections.register(tokenCostProjection),
    'dsh-cost-pill: token cost projection',
  );
}
