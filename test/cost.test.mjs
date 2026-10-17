import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HOLIDAYS,
  beijingDateKey,
  createProjection,
  isPeakTime,
  normalizeConfig,
} from '../lib/cost.js';

/** Epoch milliseconds of one Beijing wall-clock instant. */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

const TUESDAY = (hour, minute = 0) => beijing(2026, 10, 13, hour, minute);
const SATURDAY = (hour, minute = 0) => beijing(2026, 10, 17, hour, minute);

function headerEvent(time, model = 'deepseek-flash', provider = 'deepseek-account') {
  return {
    type: 'request/header',
    time,
    data: { header: { config: { provider, model } } },
  };
}

function messageEvent(time, turn, step, usage) {
  return { type: 'assistant/message', time, data: { turn, step, usage } };
}

function usage(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function run(projection, events) {
  let state = projection.init();
  for (const event of events) state = projection.apply(state, event);
  return { state, view: projection.wire.view(state) };
}

const FLASH = 'deepseek-flash';

test('peak window is Beijing weekday 09:00-12:00 and 14:00-18:00', () => {
  assert.equal(isPeakTime(TUESDAY(9, 0)), true);
  assert.equal(isPeakTime(TUESDAY(11, 59)), true);
  assert.equal(isPeakTime(TUESDAY(12, 0)), false);
  assert.equal(isPeakTime(TUESDAY(14, 0)), true);
  assert.equal(isPeakTime(TUESDAY(17, 59)), true);
  assert.equal(isPeakTime(TUESDAY(18, 0)), false);
  assert.equal(isPeakTime(SATURDAY(10, 0)), false);
});

test('public holidays bill off-peak even on a weekday', () => {
  assert.equal(isPeakTime(beijing(2026, 10, 1, 10, 0)), false);
  assert.equal(isPeakTime(beijing(2026, 2, 16, 10, 0)), false);
  assert.equal(DEFAULT_HOLIDAYS.includes('2026-10-01'), true);
  assert.equal(beijingDateKey(beijing(2026, 10, 1, 0, 30)), '2026-10-01');
});

test('config can replace the holiday calendar', () => {
  const holidays = normalizeConfig({ holidays: ['2026-10-13'] }).holidays;
  assert.deepEqual(holidays, ['2026-10-13']);
  assert.equal(isPeakTime(TUESDAY(10), new Set(holidays)), false);
});

test('peak attempt prices cache-miss input and output at the peak rates', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 1_000_000)),
  ]);
  assert.equal(view.tokens.uncachedInputTokens, 1_000_000);
  assert.equal(view.tokens.outputTokens, 1_000_000);
  assert.equal(view.cny, 10); // 1M * ¥2 + 1M * ¥8, per million
  assert.equal(view.peakCny, 10);
  assert.equal(view.offPeakCny, 0);
  assert.equal(view.fallback, false);
});

test('cache reads bill at the cache-hit rate', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(0, 0, 1_000_000)),
  ]);
  assert.equal(view.cny, 0.04);
  assert.equal(view.tokens.cacheReadTokens, 1_000_000);
});

test('the request time decides the period, not the settlement time', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(11, 59)),
    messageEvent(TUESDAY(12, 31), 1, 1, usage(1_000_000, 1_000_000)),
  ]);
  assert.equal(view.peakCny, 10);
  assert.equal(view.offPeakCny, 0);
});

test('holiday sessions bill at the off-peak half price', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(beijing(2026, 10, 1, 10, 0)),
    messageEvent(beijing(2026, 10, 1, 10, 30), 1, 1, usage(1_000_000, 1_000_000)),
  ]);
  assert.equal(view.cny, 5); // off-peak: ¥1 input + ¥4 output
  assert.equal(view.peakCny, 0);
  assert.equal(view.offPeakCny, 5);
});

test('a later settlement of the same Turn and Step replaces the earlier sample', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
    messageEvent(TUESDAY(10), 1, 1, usage(0, 1_000_000)),
  ]);
  assert.equal(view.tokens.uncachedInputTokens, 0);
  assert.equal(view.tokens.outputTokens, 1_000_000);
  assert.equal(view.cny, 8);
});

test('a retried attempt bills again', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(0, 1_000_000)),
    { type: 'llm/retry-started', time: TUESDAY(10, 1), data: { turn: 1, step: 1 } },
    messageEvent(TUESDAY(10, 2), 1, 1, usage(0, 2_000_000)),
  ]);
  assert.equal(view.tokens.outputTokens, 3_000_000);
  assert.equal(view.cny, 24);
});

test('an unknown model falls back to the flash price and is flagged', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'some-third-party-model', 'openrouter'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
  ]);
  assert.equal(view.cny, 2);
  assert.equal(view.fallback, true);
  assert.deepEqual(view.models[0], {
    provider: 'openrouter',
    model: 'some-third-party-model',
    cny: 2,
    tokens: {
      uncachedInputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  });
});

test('legacy Flash ids price as deepseek-flash', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'deepseek-v4-flash'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
  ]);
  assert.equal(view.cny, 2);
  assert.equal(view.fallback, false);
});

test('Config prices override and extend the built-in table', () => {
  const projection = createProjection({
    prices: {
      'my-model': {
        peak: { cacheHit: 1, cacheMiss: 10, output: 20 },
        offPeak: { cacheHit: 0.5, cacheMiss: 5, output: 10 },
      },
    },
    fallbackModel: FLASH,
  });
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'my-model', 'local'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 1_000_000)),
  ]);
  assert.equal(view.cny, 30);
});

test('stateVersion follows the effective pricing configuration', () => {
  const base = createProjection();
  assert.equal(base.stateVersion, createProjection({}).stateVersion);
  const priced = createProjection({
    prices: {
      'my-model': {
        peak: { cacheHit: 1, cacheMiss: 1, output: 1 },
        offPeak: { cacheHit: 1, cacheMiss: 1, output: 1 },
      },
    },
  });
  const holiday = createProjection({ holidays: ['2026-12-31'] });
  assert.notEqual(base.stateVersion, priced.stateVersion);
  assert.notEqual(base.stateVersion, holiday.stateVersion);
  assert.ok(Number.isSafeInteger(base.stateVersion) && base.stateVersion > 0);
});

test('view rounds to six decimals and reports totals only once billed', () => {
  const projection = createProjection();
  const empty = run(projection, []);
  assert.equal(empty.view.cny, 0);
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(333_333, 7)),
  ]);
  assert.equal(view.cny, 0.666722);
});
