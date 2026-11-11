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
  assert.equal(view.models[0].provider, 'openrouter');
  assert.equal(view.models[0].model, 'some-third-party-model');
  assert.equal(view.models[0].cny, 2);
  assert.equal(view.models[0].fallback, true);
  assert.equal(view.models[0].periods[0].period, 'peak');
  assert.equal(view.models[0].periods[0].costs.inputCny, 2);
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
  assert.equal(empty.view.fallbackModel, 'deepseek-flash');
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(333_333, 7)),
  ]);
  assert.equal(view.cny, 0.666722);
});

test('stateVersion moves when the fold semantics change', () => {
  const version = createProjection().stateVersion;
  assert.ok(version >= 4 && version < 1_000_004);
});

test('a makeup Saturday stays off-peak: official peak is Monday-Friday', () => {
  // 国办发明电〔2025〕7号: 2026-02-14（周六）上班. DeepSeek bills 周一至周五 only.
  assert.equal(isPeakTime(beijing(2026, 2, 14, 10, 0)), false);
  assert.equal(isPeakTime(beijing(2026, 10, 10, 15, 0)), false);
});

test('reasoning tokens are not billed twice; they already sit inside output', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, {
      ...usage(0, 1_000_000),
      reasoningTokens: 800_000,
    }),
  ]);
  assert.equal(view.tokens.outputTokens, 1_000_000);
  assert.equal(view.cny, 8);
});

test('cache-write tokens are counted and priced at zero', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(10), 1, 1, usage(0, 0, 0, 1_000_000)),
  ]);
  assert.equal(view.tokens.cacheWriteTokens, 1_000_000);
  assert.equal(view.costs.cacheWriteCny, 0);
  assert.equal(view.cny, 0);
});

test('a later sample of the same attempt keeps the original request period', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(11, 50)),
    messageEvent(TUESDAY(11, 55), 1, 1, usage(0, 1_000_000)),
    messageEvent(TUESDAY(12, 10), 1, 1, usage(0, 2_000_000)),
  ]);
  assert.equal(view.tokens.outputTokens, 2_000_000);
  assert.equal(view.peakCny, 16);
  assert.equal(view.offPeakCny, 0);
});

test('a retry that starts in peak stays peak when generation settles after noon', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(11, 40)),
    messageEvent(TUESDAY(11, 45), 1, 1, usage(0, 1_000_000)),
    { type: 'llm/retry-started', time: TUESDAY(11, 58), data: { turn: 1, step: 1 } },
    messageEvent(TUESDAY(12, 20), 1, 1, usage(0, 1_000_000)),
  ]);
  assert.equal(view.tokens.outputTokens, 2_000_000);
  assert.equal(view.peakCny, 16);
  assert.equal(view.offPeakCny, 0);
});

test('a step that inherits the header is priced at stream start, not settlement', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(9, 40), 1, 1, usage(0, 1_000_000)),
    {
      type: 'assistant/message',
      time: TUESDAY(12, 30),
      data: {
        turn: 1,
        step: 2,
        stream: [
          { type: 'chunk', time: TUESDAY(12, 5), chunk: { type: 'usage', usage: usage(0, 1_000_000) } },
          { type: 'text-chunks', time0: TUESDAY(11, 40), dt: [], texts: ['x'] },
        ],
      },
    },
  ]);
  assert.equal(view.tokens.outputTokens, 2_000_000);
  assert.equal(view.peakCny, 16);
  assert.equal(view.offPeakCny, 0);
});

test('an armed header beats a later stream, and a consumed header is not reused', () => {
  const projection = createProjection();
  const armed = run(projection, [
    headerEvent(TUESDAY(11, 59)),
    {
      type: 'assistant/message',
      time: TUESDAY(12, 40),
      data: {
        turn: 1,
        step: 1,
        usage: usage(0, 1_000_000),
        stream: [{ type: 'text-chunks', time0: TUESDAY(12, 5), dt: [], texts: ['x'] }],
      },
    },
  ]);
  assert.equal(armed.view.peakCny, 8);
  assert.equal(armed.view.offPeakCny, 0);

  const consumed = run(projection, [
    headerEvent(TUESDAY(11, 50)),
    messageEvent(TUESDAY(11, 55), 1, 1, usage(0, 1_000_000)),
    messageEvent(TUESDAY(12, 30), 1, 2, usage(0, 1_000_000)),
  ]);
  assert.equal(consumed.view.peakCny, 8);
  assert.equal(consumed.view.offPeakCny, 4);
});

test('step/start is the clock only when the attempt has no dispatch time and no stream', () => {
  const projection = createProjection();
  const fromStep = run(projection, [
    headerEvent(TUESDAY(9, 0)),
    messageEvent(TUESDAY(9, 10), 1, 1, usage(0, 1_000_000)),
    { type: 'step/start', time: TUESDAY(11, 50), data: { turn: 1, step: 2 } },
    messageEvent(TUESDAY(12, 20), 1, 2, usage(0, 1_000_000)),
  ]);
  assert.equal(fromStep.view.peakCny, 16);
  assert.equal(fromStep.view.offPeakCny, 0);

  const headerWins = run(projection, [
    { type: 'step/start', time: TUESDAY(8, 30), data: { turn: 1, step: 1 } },
    headerEvent(TUESDAY(9, 5)),
    messageEvent(TUESDAY(9, 10), 1, 1, usage(0, 1_000_000)),
  ]);
  assert.equal(headerWins.view.peakCny, 8);
  assert.equal(headerWins.view.offPeakCny, 0);

  const streamWins = run(projection, [
    { type: 'step/start', time: TUESDAY(8, 30), data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      time: TUESDAY(9, 20),
      data: {
        turn: 1,
        step: 1,
        usage: usage(0, 1_000_000),
        stream: [{ type: 'reasoning-chunks', time0: TUESDAY(9, 10), dt: [10], texts: ['a', 'b'] }],
      },
    },
  ]);
  assert.equal(streamWins.view.peakCny, 8);
  assert.equal(streamWins.view.offPeakCny, 0);
  assert.equal(streamWins.view.fallback, true);
});

test('compaction summary usage is added and is not replaced by the step', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'deepseek-flash'),
    messageEvent(TUESDAY(10), 1, 1, usage(0, 1_000_000)),
    {
      type: 'compaction/summary',
      time: TUESDAY(12, 30),
      data: {
        provider: 'deepseek-account',
        model: 'deepseek-v4-pro',
        usage: usage(0, 1_000_000),
      },
    },
    messageEvent(TUESDAY(10, 5), 1, 1, usage(0, 2_000_000)),
    { type: 'compaction/summary', time: TUESDAY(12, 40), data: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } },
  ]);
  assert.equal(view.peakCny, 16);
  assert.equal(view.offPeakCny, 13.5);
  assert.equal(view.cny, 29.5);
  assert.equal(view.models.length, 2);
  assert.equal(view.fallback, false);
});

test('alias chains resolve through legacy ids instead of the fallback model', () => {
  const projection = createProjection({
    aliases: { 'my-old': 'deepseek-v4-flash' },
    fallbackModel: 'deepseek-v4-pro',
  });
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'my-old', 'deepseek-account'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
  ]);
  assert.equal(view.cny, 2);
  assert.equal(view.fallback, false);
  assert.equal(view.fallbackModel, 'deepseek-v4-pro');
  assert.equal(view.models[0].model, 'my-old');
});

test('an alias cycle falls back instead of looping', () => {
  const projection = createProjection({ aliases: { a: 'b', b: 'a' } });
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'a', 'local'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
  ]);
  assert.equal(view.cny, 2);
  assert.equal(view.fallback, true);
});

test('replacing the only fallback attempt clears the fallback flag', () => {
  const projection = createProjection();
  const replaced = run(projection, [
    headerEvent(TUESDAY(9, 30), 'unknown-model', 'other'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
    headerEvent(TUESDAY(10, 1), 'deepseek-flash'),
    messageEvent(TUESDAY(10, 2), 1, 1, usage(0, 1_000_000)),
  ]);
  assert.equal(replaced.view.cny, 8);
  assert.equal(replaced.view.fallback, false);
  assert.equal(replaced.view.models.length, 1);
  assert.equal(replaced.view.models[0].model, 'deepseek-flash');

  const kept = run(projection, [
    headerEvent(TUESDAY(9, 30), 'unknown-model', 'other'),
    messageEvent(TUESDAY(10), 1, 1, usage(1_000_000, 0)),
    headerEvent(TUESDAY(10, 1), 'deepseek-flash'),
    messageEvent(TUESDAY(10, 2), 1, 2, usage(0, 1_000_000)),
  ]);
  assert.equal(kept.view.fallback, true);
  assert.equal(kept.view.cny, 10);
});

test('an unsettled header does not price a later step', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    { type: 'step/start', time: TUESDAY(11, 50), data: { turn: 1, step: 1 } },
    headerEvent(TUESDAY(11, 55)),
    { type: 'step/start', time: TUESDAY(12, 10), data: { turn: 1, step: 2 } },
    messageEvent(TUESDAY(12, 20), 1, 2, usage(0, 1_000_000)),
  ]);
  assert.equal(view.peakCny, 0);
  assert.equal(view.offPeakCny, 4);
});

test('an unsettled retry clock does not price the next step', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(9, 40), 1, 1, usage(0, 1_000_000)),
    { type: 'llm/retry-started', time: TUESDAY(11, 59), data: { turn: 1, step: 1 } },
    messageEvent(TUESDAY(12, 20), 1, 2, usage(0, 1_000_000)),
  ]);
  assert.equal(view.peakCny, 8);
  assert.equal(view.offPeakCny, 4);
});

test('a header logged inside the open step still prices that step', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    { type: 'step/start', time: TUESDAY(8, 30), data: { turn: 1, step: 1 } },
    headerEvent(TUESDAY(9, 5)),
    messageEvent(TUESDAY(9, 20), 1, 1, usage(0, 1_000_000)),
  ]);
  assert.equal(view.peakCny, 8);
  assert.equal(view.offPeakCny, 0);
});

test('a finished compaction does not lend its start time to the next summary', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    { type: 'compaction/start', time: TUESDAY(11, 50), data: { turn: 1 } },
    {
      type: 'compaction/summary',
      time: TUESDAY(11, 55),
      data: { provider: 'deepseek-account', model: 'deepseek-flash', usage: usage(0, 1_000_000) },
    },
    { type: 'compaction/end', time: TUESDAY(11, 56), data: { turn: 1 } },
    {
      type: 'compaction/summary',
      time: TUESDAY(12, 20),
      data: { provider: 'deepseek-account', model: 'deepseek-flash', usage: usage(0, 1_000_000) },
    },
  ]);
  assert.equal(view.peakCny, 8);
  assert.equal(view.offPeakCny, 4);
});

test('compaction/start is the summary clock when the call finishes after the boundary', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    {
      type: 'compaction/start',
      time: TUESDAY(11, 50),
      data: { turn: 1 },
    },
    {
      type: 'compaction/summary',
      time: TUESDAY(12, 20),
      data: {
        provider: 'deepseek-account',
        model: 'deepseek-v4-pro',
        usage: usage(0, 1_000_000),
      },
    },
  ]);
  assert.equal(view.peakCny, 27);
  assert.equal(view.offPeakCny, 0);
});

test('a few cache-hit tokens stay visible at the off-peak flash rate', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(SATURDAY(10)),
    messageEvent(SATURDAY(10, 1), 1, 1, usage(0, 0, 10)),
  ]);
  assert.equal(view.cny, 0.0000002);
  assert.equal(view.costs.cacheReadCny, 0.0000002);
});

test('an internal clock update keeps the published view reference', () => {
  const projection = createProjection();
  const billed = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    messageEvent(TUESDAY(9, 40), 1, 1, usage(0, 1_000_000)),
  ]);
  const next = projection.apply(billed.state, {
    type: 'step/start',
    time: TUESDAY(9, 50),
    data: { turn: 1, step: 2 },
  });
  assert.equal(projection.wire.view(billed.state), projection.wire.view(next));
  assert.equal(projection.wire.view(next).cny, 8);
});

test('the view splits each model into the periods that were actually billed', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30), 'deepseek-flash'),
    messageEvent(TUESDAY(10), 1, 1, usage(0, 1_000_000)),
    headerEvent(TUESDAY(12, 30), 'deepseek-flash'),
    messageEvent(TUESDAY(12, 40), 1, 2, usage(1_000_000, 0, 1_000_000)),
  ]);
  assert.equal(view.models.length, 1);
  assert.equal(view.models[0].fallback, false);
  assert.deepEqual(
    view.models[0].periods.map((period) => period.period),
    ['peak', 'offPeak'],
  );
  const peak = view.models[0].periods[0];
  const offPeak = view.models[0].periods[1];
  assert.equal(peak.cny, 8);
  assert.equal(peak.tokens.outputTokens, 1_000_000);
  assert.equal(peak.costs.outputCny, 8);
  assert.equal(offPeak.cny, 1.02);
  assert.equal(offPeak.tokens.uncachedInputTokens, 1_000_000);
  assert.equal(offPeak.tokens.cacheReadTokens, 1_000_000);
  assert.equal(offPeak.costs.inputCny, 1);
  assert.equal(offPeak.costs.cacheReadCny, 0.02);
});

test('assistant/attempt bills the last stream usage sample', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    {
      type: 'assistant/attempt',
      time: TUESDAY(10),
      data: {
        turn: 1,
        step: 1,
        usage: usage(0, 9_000_000),
        stream: [
          { type: 'chunk', time: TUESDAY(9, 40), chunk: { type: 'usage', usage: usage(0, 1_000_000) } },
        ],
      },
    },
  ]);
  assert.equal(view.tokens.outputTokens, 1_000_000);
  assert.equal(view.cny, 8);
});

test('events without a turn and step are each billed, and null usage does not wipe', () => {
  const projection = createProjection();
  const { view } = run(projection, [
    headerEvent(TUESDAY(9, 30)),
    { type: 'assistant/message', time: TUESDAY(10), data: { usage: usage(0, 1_000_000) } },
    { type: 'assistant/message', time: TUESDAY(10, 1), data: { usage: usage(0, 1_000_000) } },
    messageEvent(TUESDAY(10, 2), 1, 1, usage(0, 1_000_000)),
    { type: 'assistant/message', time: TUESDAY(10, 3), data: { turn: 1, step: 1, usage: null } },
  ]);
  assert.equal(view.tokens.outputTokens, 3_000_000);
  assert.equal(view.cny, 24);
});
