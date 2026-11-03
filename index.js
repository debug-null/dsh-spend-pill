/**
 * Host half of the cost-pill bundle.
 *
 * Registers one session projection (`tokenCost`) that prices durable provider
 * usage the way DeepSeek actually bills it: every settled assistant attempt is
 * priced with the model's official list price for the period that attempt was
 * dispatched in (peak or off-peak, with the 2026 public-holiday calendar), and
 * a compaction summary's own model call is added beside those attempts. A Turn
 * that crosses the peak boundary or a Session that switches models still adds
 * up. The browser half renders the value; this half never touches the UI.
 *
 * The pricing fold lives in ./lib/cost.js so it can be unit-tested without a
 * Harness. The row's `config` may override prices, aliases, the fallback model
 * and the holiday list; see the README.
 *
 * Prices: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

import { createProjection } from './lib/cost.js';

export const inject = ['sessionProjections'];

export function apply(ctx, config) {
  const projection = createProjection(config);
  ctx.effect(
    () => ctx.sessionProjections.register(projection),
    'dsh-spend-pill: token cost projection',
  );
}
