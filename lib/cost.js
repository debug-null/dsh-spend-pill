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

// Official cache-hit prices go down to ¥0.02 / 1,000,000 tokens. Six decimal
// places round a 10-token hit (¥0.0000002) to zero.
const ROUND_SCALE = 100_000_000;
const round = (value) => Math.round(value * ROUND_SCALE) / ROUND_SCALE;

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

function emptyPeriod() {
  return { cny: 0, tokens: emptyTokens(), costs: emptyCosts() };
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
  return {
    model: null,
    // Clock of the request/header or llm/retry-started that has not settled.
    // `turn`/`step` are null when the marker arrived before any step/start;
    // that unbound marker prices only the next settlement.
    dispatch: null,
    // step/start of the open step. Used only when that same step settles
    // without a dispatch marker and without an embedded stream timestamp.
    stepClock: null,
    // compaction/start. The summary call is not a loop step, so it keeps its
    // own clock instead of borrowing the surrounding request.
    compactionTime: null,
    totals: emptyTotals(),
    last: null,
    // Stable client snapshot. Internal clock updates must keep this reference.
    published: null,
  };
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
  // A surface settlement carries its usage beside the stream. An attempt has
  // no usage field; the sample is the last usage chunk. Reading a stray
  // `usage` off an attempt would bill a value the host meter ignores.
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage;
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
  if (usage === null || typeof usage !== 'object') return emptyTokens();
  // Harness counts are disjoint: inputTokens is cache-miss input only.
  // reasoningTokens are already included in outputTokens. DeepSeek does not
  // bill cache writes (Anthropic-format cache_creation_input_tokens is always
  // 0), so cacheWriteTokens are tracked and priced at 0 below.
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

/**
 * Follow alias chains, including legacy ids that are themselves aliases
 * (`my-old` → `deepseek-v4-flash` → `deepseek-flash`). Cycles stop at the
 * first repeated id and then fall through to the fallback price.
 */
function canonicalModelId(settings, modelId) {
  const seen = new Set();
  let current = modelId;
  while (typeof current === 'string' && !seen.has(current)) {
    const next = settings.aliases[current];
    if (typeof next !== 'string' || next === '') return current;
    seen.add(current);
    current = next;
  }
  return typeof current === 'string' ? current : modelId;
}

function ratesFor(settings, modelId) {
  const canonical = canonicalModelId(settings, modelId);
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
    // No official cache-write rate. See bucketsOf.
    cacheWriteCny: 0,
    outputCny: (buckets.outputTokens * price.output) / PER_MILLION,
  };
  const cny = costs.inputCny + costs.cacheReadCny + costs.outputCny;
  return {
    cny,
    peak,
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

function shiftMap(current, delta, keys, sign) {
  const next = { ...current };
  for (const key of keys) {
    const base = typeof next[key] === 'number' && Number.isFinite(next[key]) ? next[key] : 0;
    const amount = delta[key];
    const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
    next[key] = Math.max(0, base + sign * value);
  }
  return next;
}

function shiftPeriod(period, contribution, sign) {
  return {
    cny: Math.max(0, period.cny + sign * contribution.cny),
    tokens: shiftMap(period.tokens, contribution.tokens, TOKEN_KEYS, sign),
    costs: shiftMap(period.costs, contribution.costs, COST_KEYS, sign),
  };
}

function applyContribution(totals, contribution, sign) {
  const periodKey = contribution.peak ? 'peak' : 'offPeak';
  const models = { ...totals.models };
  const previous = models[contribution.modelKey];
  const entry = {
    provider: contribution.provider,
    model: contribution.modelId,
    cny: Math.max(0, (previous === undefined ? 0 : previous.cny) + sign * contribution.cny),
    tokens: shiftMap(
      previous === undefined ? emptyTokens() : previous.tokens,
      contribution.tokens,
      TOKEN_KEYS,
      sign,
    ),
    fallback: contribution.fallback,
    peak: previous === undefined || previous.peak === undefined ? emptyPeriod() : previous.peak,
    offPeak:
      previous === undefined || previous.offPeak === undefined ? emptyPeriod() : previous.offPeak,
  };
  entry[periodKey] = shiftPeriod(entry[periodKey], contribution, sign);
  models[contribution.modelKey] = entry;
  return {
    cny: Math.max(0, totals.cny + sign * contribution.cny),
    peakCny: Math.max(0, totals.peakCny + sign * contribution.peakCny),
    offPeakCny: Math.max(0, totals.offPeakCny + sign * contribution.offPeakCny),
    tokens: shiftMap(totals.tokens, contribution.tokens, TOKEN_KEYS, sign),
    costs: shiftMap(totals.costs, contribution.costs, COST_KEYS, sign),
    models,
    // Recomputed from what is still billed. A replaced fallback attempt must
    // not leave the session flagged after its tokens are gone.
    fallback: sessionFallback(models),
  };
}

function entryBillable(entry) {
  return entry.cny > 0 || TOKEN_KEYS.some((key) => entry.tokens[key] > 0);
}

function sessionFallback(models) {
  return Object.values(models).some((entry) => entry.fallback === true && entryBillable(entry));
}

function hasTokens(buckets) {
  return TOKEN_KEYS.some((key) => buckets[key] > 0);
}

/** First provider-byte time embedded in a v2 assistant stream, if any. */
function earliestStreamTime(event) {
  const data = event.data;
  if (data === null || typeof data !== 'object' || !Array.isArray(data.stream)) return null;
  let earliest = null;
  for (const record of data.stream) {
    if (record === null || typeof record !== 'object') continue;
    const time = Number.isFinite(record.time0)
      ? record.time0
      : Number.isFinite(record.time)
        ? record.time
        : null;
    if (time === null || time <= 0) continue;
    if (earliest === null || time < earliest) earliest = time;
  }
  return earliest;
}

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sameIdentity(clock, identity) {
  return (
    clock !== null &&
    identity !== null &&
    clock.turn === identity.turn &&
    clock.step === identity.step
  );
}

function clocksEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.turn === right.turn && left.step === right.step && left.time === right.time;
}

/**
 * A bound marker prices only its own turn/step. An unbound marker (logged
 * before any step/start) prices the next settlement, then the fold clears it.
 */
function dispatchApplies(dispatch, identity) {
  if (dispatch === null || finiteTime(dispatch.time) === null) return false;
  if (dispatch.turn === null || dispatch.step === null) return true;
  return sameIdentity(dispatch, identity);
}

/**
 * When this attempt's tokens are billed.
 *
 * A replacement keeps the clock chosen for the first sample. Otherwise prefer
 * a dispatch marker that belongs to this attempt (`request/header` or
 * `llm/retry-started`), then the first stream timestamp — later steps in a
 * series do not repeat the header, and the settlement event's own time is
 * after generation finishes — then this step's `step/start`, then the event
 * time. A marker armed for a different step is ignored.
 */
function attemptClock(state, event, previous, identity) {
  if (previous !== null && Number.isFinite(previous.requestTime)) return previous.requestTime;
  if (dispatchApplies(state.dispatch, identity)) return state.dispatch.time;
  const streamTime = earliestStreamTime(event);
  if (streamTime !== null) return streamTime;
  if (sameIdentity(state.stepClock, identity) && Number.isFinite(state.stepClock.time)) {
    return state.stepClock.time;
  }
  return event.time;
}

function attemptIdentity(turn, step) {
  return Number.isInteger(turn) && Number.isInteger(step) ? { turn, step } : null;
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
  // Base 4: dispatch clocks are scoped to the attempt that armed them,
  // compaction uses its start time, and each model keeps peak/off-peak
  // buckets. Config still mixes in below so an edited price table invalidates
  // checkpoints on its own.
  const stateVersion =
    4 +
    (stableHash({
      prices: settings.prices,
      aliases: settings.aliases,
      fallbackModel: settings.fallbackModel,
      holidays: [...settings.holidays].sort(),
    }) %
      1000000);

  function publish(state, totals) {
    return { ...state, totals, published: projectView(totals) };
  }

  function projectView(totals) {
    const costs = {};
    for (const key of COST_KEYS) costs[key] = round(totals.costs[key]);
    const models = Object.values(totals.models)
      .filter((entry) => entry.cny > 0 || TOKEN_KEYS.some((key) => entry.tokens[key] > 0))
      .map((entry) => {
        const periods = [];
        for (const name of ['peak', 'offPeak']) {
          const period = entry[name];
          if (period === undefined) continue;
          if (period.cny <= 0 && !hasTokens(period.tokens)) continue;
          const periodCosts = {};
          for (const key of COST_KEYS) periodCosts[key] = round(period.costs[key]);
          periods.push({
            period: name,
            cny: round(period.cny),
            tokens: { ...period.tokens },
            costs: periodCosts,
          });
        }
        return {
          provider: entry.provider,
          model: entry.model,
          cny: round(entry.cny),
          fallback: entry.fallback === true,
          tokens: { ...entry.tokens },
          periods,
        };
      });
    return {
      cny: round(totals.cny),
      peakCny: round(totals.peakCny),
      offPeakCny: round(totals.offPeakCny),
      tokens: { ...totals.tokens },
      costs,
      models,
      fallback: totals.fallback === true,
      fallbackModel: settings.fallbackModel,
    };
  }

  function fold(state, event) {
    if (event === null || typeof event !== 'object') return state;

    if (event.type === 'step/start') {
      const data = event.data;
      const identity =
        data !== null && typeof data === 'object'
          ? attemptIdentity(data.turn, data.step)
          : null;
      const time = finiteTime(event.time);
      if (identity === null || time === null) return state;
      const stepClock = { turn: identity.turn, step: identity.step, time };
      // A marker armed for another step must not price this one. An unbound
      // marker logged before the step is the session's old header, not this
      // request, so a new step drops it too.
      const dispatch = sameIdentity(state.dispatch, identity) ? state.dispatch : null;
      if (clocksEqual(state.stepClock, stepClock) && state.dispatch === dispatch) return state;
      return { ...state, stepClock, dispatch };
    }

    if (event.type === 'compaction/start') {
      const time = finiteTime(event.time);
      if (time === null || state.compactionTime === time) return state;
      return { ...state, compactionTime: time };
    }

    if (event.type === 'compaction/end') {
      if (state.compactionTime === null) return state;
      return { ...state, compactionTime: null };
    }

    if (event.type === 'request/header') {
      const header = event.data === undefined ? undefined : event.data.header;
      const config = header === undefined || header === null ? undefined : header.config;
      if (config === null || typeof config !== 'object') return state;
      const provider = typeof config.provider === 'string' ? config.provider : '';
      const model = typeof config.model === 'string' ? config.model : '';
      if (provider === '' || model === '') return state;
      const sameModel =
        state.model !== null &&
        state.model.provider === provider &&
        state.model.model === model;
      // Logged inside the step, immediately before dispatch. Later unchanged
      // steps inherit the model and do not append another header.
      const time = finiteTime(event.time);
      const carried = state.dispatch === null ? null : finiteTime(state.dispatch.time);
      const dispatchTime = time === null ? carried : time;
      const dispatch =
        dispatchTime === null
          ? null
          : {
              turn: state.stepClock === null ? null : state.stepClock.turn,
              step: state.stepClock === null ? null : state.stepClock.step,
              time: dispatchTime,
            };
      if (sameModel && clocksEqual(state.dispatch, dispatch)) return state;
      return { ...state, model: { provider, model }, dispatch };
    }

    if (event.type === 'llm/retry-started') {
      const data = event.data === undefined || event.data === null ? {} : event.data;
      const identity = attemptIdentity(data.turn, data.step);
      const time = finiteTime(event.time);
      const carried = state.dispatch === null ? null : finiteTime(state.dispatch.time);
      const dispatchTime = time === null ? carried : time;
      const dispatch =
        dispatchTime === null
          ? null
          : {
              turn: identity === null ? null : identity.turn,
              step: identity === null ? null : identity.step,
              time: dispatchTime,
            };
      const clearLast = sameIdentity(state.last, identity);
      if (!clearLast && clocksEqual(state.dispatch, dispatch)) return state;
      return { ...state, last: clearLast ? null : state.last, dispatch };
    }

    // A summarizer call is not a loop step. Its usage must accumulate on its
    // own and must not occupy the (turn, step) replacement slot.
    if (event.type === 'compaction/summary') {
      const data = event.data;
      const billedAt = finiteTime(state.compactionTime) ?? event.time;
      const cleared = state.compactionTime === null ? state : { ...state, compactionTime: null };
      if (data === null || typeof data !== 'object' || data.usage === null || typeof data.usage !== 'object') {
        return cleared;
      }
      const buckets = bucketsOf(data.usage);
      if (!hasTokens(buckets)) return cleared;
      const model = {
        provider: typeof data.provider === 'string' && data.provider !== '' ? data.provider : 'unknown',
        model: typeof data.model === 'string' && data.model !== '' ? data.model : 'unknown',
      };
      const contribution = contributionFor(settings, holidaySet, model, buckets, billedAt);
      return publish(cleared, applyContribution(state.totals, contribution, 1));
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
      return state;
    }

    const usage = usageOf(event);
    if (usage === undefined || usage === null || typeof usage !== 'object') return state;

    const data = event.data === undefined || event.data === null ? {} : event.data;
    const identity = attemptIdentity(data.turn, data.step);
    const buckets = bucketsOf(usage);
    const previous =
      identity !== null &&
      state.last !== null &&
      state.last.turn === identity.turn &&
      state.last.step === identity.step
        ? state.last
        : null;
    if (previous !== null && sameBuckets(previous.buckets, buckets)) return state;

    const requestTime = attemptClock(state, event, previous, identity);
    const contribution = contributionFor(
      settings,
      holidaySet,
      state.model,
      buckets,
      requestTime,
    );
    const base =
      previous === null
        ? state.totals
        : applyContribution(state.totals, previous.contribution, -1);
    const totals = applyContribution(base, contribution, 1);
    return {
      ...publish({ ...state, dispatch: null, stepClock: null }, totals),
      last:
        identity === null
          ? state.last
          : {
              turn: identity.turn,
              step: identity.step,
              buckets,
              contribution,
              requestTime: Number.isFinite(requestTime) ? requestTime : null,
            },
    };
  }

  const view = (state) =>
    state.published !== null && typeof state.published === 'object'
      ? state.published
      : projectView(state.totals);

  /**
   * The registry expects schema objects with `parse()`. A linked local bundle
   * cannot resolve `zod` from its own package root, so this supplies the
   * minimum the registry calls: accept stored state unless it is not an
   * object, and never re-validate the already numeric view.
   */
  function fresh() {
    const state = emptyState();
    state.published = projectView(state.totals);
    return state;
  }

  const stateSchema = {
    parse(value) {
      if (
        value === null ||
        typeof value !== 'object' ||
        value.totals === null ||
        typeof value.totals !== 'object' ||
        value.totals.tokens === null ||
        typeof value.totals.tokens !== 'object'
      ) {
        return fresh();
      }
      if (value.published !== null && typeof value.published === 'object') return value;
      return { ...value, published: projectView(value.totals) };
    },
  };
  const viewSchema = { parse: (value) => value };

  return {
    key: 'tokenCost',
    stateVersion,
    stateSchema,
    init: fresh,
    apply: fold,
    wire: { viewSchema, view },
  };
}
