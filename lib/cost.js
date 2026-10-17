/**
 * Pure pricing fold for the `tokenCost` session projection.
 *
 * Ported out of the plugin entry so it can be unit-tested without a Harness:
 * this module imports nothing and touches neither `ctx` nor the DOM. The
 * projection factory takes the plugin's Config (see README) and returns the
 * definition the session-projection registry expects.
 *
 * Prices: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

const PER_MILLION = 1000000;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** Official DeepSeek list prices, CNY per 1,000,000 tokens. */
export const DEFAULT_PRICES = {
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
export const DEFAULT_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** Price fallback for a model the effective price table does not describe. */
export const DEFAULT_FALLBACK = 'deepseek-flash';

/**
 * Chinese public holidays for 2026, as Beijing calendar dates
 * (国办发明电〔2025〕7号). Weekends are already off-peak; only the weekday
 * entries matter, but the full holiday range is listed so the set can be
 * checked against the notice. Extend it through the plugin Config when the
 * next year's notice is published.
 */
export const DEFAULT_HOLIDAYS = [
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  // Spring Festival, 2026-02-15 .. 2026-02-23
  '2026-02-15',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  '2026-02-23',
  // Qingming, 2026-04-04 .. 2026-04-06
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  // Labour Day, 2026-05-01 .. 2026-05-05
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  '2026-05-04',
  '2026-05-05',
  // Dragon Boat, 2026-06-19 .. 2026-06-21
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  // Mid-Autumn, 2026-09-25 .. 2026-09-27
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  // National Day, 2026-10-01 .. 2026-10-07
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
];

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

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

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

export function emptyState() {
  return { model: null, requestTime: null, totals: emptyTotals(), last: null };
}

/** Beijing calendar date (`YYYY-MM-DD`) of one epoch-millisecond instant. */
export function beijingDateKey(time) {
  if (!Number.isFinite(time)) return '';
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Whether one instant bills at the peak rate: Beijing time, Monday–Friday,
 * 09:00–12:00 or 14:00–18:00, and not a public holiday.
 */
export function isPeakTime(time, holidays = DEFAULT_HOLIDAYS) {
  if (!Number.isFinite(time)) return false;
  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays);
  const beijing = new Date(time + BEIJING_OFFSET_MS);
  const weekday = beijing.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = beijing.getUTCHours();
  const inWindow = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  if (!inWindow) return false;
  return !holidaySet.has(beijingDateKey(time));
}

function normalizeRates(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const cacheHit = count(value.cacheHit);
  const cacheMiss = count(value.cacheMiss);
  const output = count(value.output);
  if (cacheHit === 0 && cacheMiss === 0 && output === 0) return undefined;
  return { cacheHit, cacheMiss, output };
}

function normalizeModelPrices(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const peak = normalizeRates(value.peak);
  const offPeak = normalizeRates(value.offPeak);
  if (peak === undefined || offPeak === undefined) return undefined;
  return { peak, offPeak };
}

function stableHash(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Merge the plugin Config over the built-in price table.
 * @param {unknown} raw - the row's `config` object (may be undefined).
 * @returns normalized settings used by the fold and by `stateVersion`.
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const prices = { ...DEFAULT_PRICES };
  if (config.prices !== null && typeof config.prices === 'object') {
    for (const [model, value] of Object.entries(config.prices)) {
      const normalized = normalizeModelPrices(value);
      if (normalized !== undefined) prices[model] = normalized;
    }
  }
  const aliases = { ...DEFAULT_ALIASES };
  if (config.aliases !== null && typeof config.aliases === 'object') {
    for (const [from, to] of Object.entries(config.aliases)) {
      if (typeof to === 'string' && to !== '') aliases[from] = to;
    }
  }
  const configuredFallback =
    typeof config.fallbackModel === 'string' && prices[config.fallbackModel] !== undefined
      ? config.fallbackModel
      : DEFAULT_FALLBACK;
  const holidays = Array.isArray(config.holidays)
    ? config.holidays.filter((value) => typeof value === 'string' && DATE_KEY.test(value))
    : DEFAULT_HOLIDAYS;
  return { prices, aliases, fallbackModel: configuredFallback, holidays };
}

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

function ratesFor(settings, modelId) {
  const canonical = settings.aliases[modelId] ?? modelId;
  const rates = settings.prices[canonical];
  if (rates !== undefined) return { rates, fallback: false };
  return { rates: settings.prices[settings.fallbackModel], fallback: true };
}

function contributionFor(settings, holidays, model, buckets, time) {
  const provider = model === null ? 'unknown' : model.provider;
  const modelId = model === null ? 'unknown' : model.model;
  const { rates, fallback } = ratesFor(settings, modelId);
  const peak = isPeakTime(time, holidays);
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
    fallback,
  };
}

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
 * Build the projection definition for one plugin Config.
 *
 * `stateVersion` folds a stable hash of the effective price table, aliases,
 * fallback and holiday set, so editing prices invalidates persisted
 * checkpoints instead of leaving them priced with the old table.
 */
export function createProjection(rawConfig) {
  const settings = normalizeConfig(rawConfig);
  const holidaySet = new Set(settings.holidays);
  const stateVersion =
    2 +
    (stableHash({
      prices: settings.prices,
      aliases: settings.aliases,
      fallbackModel: settings.fallbackModel,
      holidays: [...settings.holidays].sort(),
    }) %
      1000000);

  function fold(state, event) {
    if (event === null || typeof event !== 'object') return state;

    if (event.type === 'request/header') {
      const header = event.data === undefined ? undefined : event.data.header;
      const config = header === undefined ? undefined : header.config;
      if (config === null || typeof config !== 'object') return state;
      const provider = typeof config.provider === 'string' ? config.provider : '';
      const model = typeof config.model === 'string' ? config.model : '';
      if (provider === '' || model === '') return state;
      const sameModel =
        state.model !== null &&
        state.model.provider === provider &&
        state.model.model === model;
      const requestTime = Number.isFinite(event.time) ? event.time : null;
      if (sameModel && requestTime === state.requestTime) return state;
      return { ...state, model: { provider, model }, requestTime };
    }

    if (event.type === 'llm/retry-started') {
      const data = event.data === undefined ? {} : event.data;
      if (
        state.last !== null &&
        state.last.turn === data.turn &&
        state.last.step === data.step
      ) {
        return { ...state, last: null };
      }
      return state;
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
      return state;
    }

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

    const peakTime = state.requestTime === null ? event.time : state.requestTime;
    const contribution = contributionFor(
      settings,
      holidaySet,
      state.model,
      buckets,
      peakTime,
    );
    const base =
      previous === null
        ? state.totals
        : applyContribution(state.totals, previous.contribution, -1);
    const totals = applyContribution(base, contribution, 1);
    return {
      ...state,
      requestTime: null,
      totals,
      last: { turn, step, buckets, contribution },
    };
  }

  const view = (state) => {
    const totals = state.totals;
    const tokens = { ...totals.tokens };
    const costs = {};
    for (const key of COST_KEYS) costs[key] = round(totals.costs[key]);
    const models = Object.values(totals.models)
      .filter(
        (entry) => entry.cny > 0 || TOKEN_KEYS.some((key) => entry.tokens[key] > 0),
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

  /**
   * The registry expects schema objects with `parse()`. A linked local bundle
   * cannot resolve `zod` from its own package root, so this supplies the
   * minimum the registry calls: accept stored state unless it is not an
   * object, and never re-validate the already numeric view.
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

  return {
    key: 'tokenCost',
    stateVersion,
    stateSchema,
    init: () => emptyState(),
    apply: fold,
    wire: { viewSchema, view },
  };
}
