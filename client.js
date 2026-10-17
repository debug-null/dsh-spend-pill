/**
 * Browser half of the cost-pill bundle.
 *
 * Registers one ambient entry in `conversation.composer.dock`, the slot the
 * shipped Activity/Usage pills already occupy under the composer card. The
 * entry shows the Session's billed cost in CNY and opens a click dialog with
 * the token and peak/off-peak breakdown.
 *
 * All figures come from this bundle's own Host projection (`tokenCost`), which
 * prices each settled attempt with the official DeepSeek list price for the
 * model and period it ran in. The client does not fold events itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-pill',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const NS = 'cost-pill';
    const STYLE_TAG_ID = '@local/dsh-cost-pill/CostPill.css';
    const PANEL_MARGIN = 12;
    const PANEL_GAP = 8;
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    const zh = {
      'cost.pill.label': '≈ {amount}',
      'cost.pill.aria': '本次会话费用 {amount}，点击查看明细',
      'cost.dialog.title': '会话费用',
      'cost.row.input': '未缓存输入',
      'cost.row.cacheRead': '缓存命中输入',
      'cost.row.cacheWrite': '缓存写入',
      'cost.row.output': '输出',
      'cost.row.peak': '高峰时段',
      'cost.row.offPeak': '空闲时段',
      'cost.detail.value': '{tokens} tokens · {cost}',
      'cost.note.pricing': '价格来自 DeepSeek 开放平台官方价目（元/百万 tokens），按每次请求发生时段计价。',
      'cost.note.peak': '高峰时段：北京时间工作日 9:00–12:00、14:00–18:00，法定节假日按空闲价；空闲价为高峰价的一半。',
      'cost.note.fallback': '部分模型无内置价格，按 deepseek-flash 价格估算。',
    };

    const en = {
      'cost.pill.label': '≈ {amount}',
      'cost.pill.aria': 'Estimated session cost {amount}; click for details',
      'cost.dialog.title': 'Session cost',
      'cost.row.input': 'Uncached input',
      'cost.row.cacheRead': 'Cache-hit input',
      'cost.row.cacheWrite': 'Cache write',
      'cost.row.output': 'Output',
      'cost.row.peak': 'Peak period',
      'cost.row.offPeak': 'Off-peak period',
      'cost.detail.value': '{tokens} tokens · {cost}',
      'cost.note.pricing': 'Prices follow the official DeepSeek list (CNY per 1M tokens), billed at the period of each request.',
      'cost.note.peak': 'Peak: Beijing time, weekdays 09:00–12:00 and 14:00–18:00, excluding public holidays; off-peak bills at half the peak rate.',
      'cost.note.fallback': 'Models without a built-in price are estimated at the deepseek-flash price.',
    };

    const CSS = [
      '.dshcost_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dshcost_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;',
      'line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;',
      'padding:1px 8px;display:inline-flex}',
      '.dshcost_pill svg{flex:none;width:14px;height:14px}',
      'button.dshcost_pill{cursor:pointer}',
      'button.dshcost_pill:hover,button.dshcost_pill[aria-expanded=true]{',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshcost_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dshcost_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);',
      'background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);',
      'max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
      'box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);',
      'cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
      '.dshcost_title{color:var(--dsw-alias-label-primary);justify-content:space-between;',
      'gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.dshcost_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dshcost_titleValue{font-variant-numeric:tabular-nums}',
      '.dshcost_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.dshcost_titleLabel svg{flex:none;width:14px;height:14px}',
      '.dshcost_details{color:var(--dsw-alias-label-tertiary);',
      'grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
      '.dshcost_details dt,.dshcost_details dd{min-width:0;margin:0}',
      '.dshcost_details dd{color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;text-align:right}',
      '.dshcost_note{color:var(--dsw-alias-label-tertiary);margin-top:10px;font-size:11px;',
      'line-height:16px}',
    ].join('');

    function formatCny(value, forceDigits) {
      const abs = Math.abs(value);
      const digits =
        forceDigits !== undefined ? forceDigits : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
      return value.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    }

    function formatTokens(value) {
      return Math.round(value).toLocaleString();
    }

    function coinIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', {
          d: 'M4.2 2.4h7.6a.9.9 0 0 1 .9.9v10.1a.45.45 0 0 1-.7.38l-1.55-1.05-1.6 1.05a.45.45 0 0 1-.5 0l-1.6-1.05-1.55 1.05a.45.45 0 0 1-.7-.38V3.3a.9.9 0 0 1 .9-.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M6.2 5.8h3.6M6.2 8.2h3.6',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
        }),
      );
    }

    function detailRow(label, value, key) {
      return h(React.Fragment, { key }, h('dt', null, label), h('dd', null, value));
    }

    function tokenDetail(t, tokens, cny) {
      return t('cost.detail.value', {
        tokens: formatTokens(tokens),
        cost: '¥' + formatCny(cny, 4),
      });
    }

    function dialogBody(cost, t) {
      const rows = [];
      for (const entry of cost.models) {
        rows.push(
          detailRow(
            entry.provider + ' / ' + entry.model,
            '¥' + formatCny(entry.cny, 4),
            'model-' + entry.provider + '-' + entry.model,
          ),
        );
      }
      if (cost.tokens.uncachedInputTokens > 0) {
        rows.push(
          detailRow(
            t('cost.row.input'),
            tokenDetail(t, cost.tokens.uncachedInputTokens, cost.costs.inputCny),
            'input',
          ),
        );
      }
      if (cost.tokens.cacheReadTokens > 0) {
        rows.push(
          detailRow(
            t('cost.row.cacheRead'),
            tokenDetail(t, cost.tokens.cacheReadTokens, cost.costs.cacheReadCny),
            'cache-read',
          ),
        );
      }
      if (cost.tokens.cacheWriteTokens > 0) {
        rows.push(
          detailRow(
            t('cost.row.cacheWrite'),
            tokenDetail(t, cost.tokens.cacheWriteTokens, cost.costs.cacheWriteCny),
            'cache-write',
          ),
        );
      }
      if (cost.tokens.outputTokens > 0) {
        rows.push(
          detailRow(
            t('cost.row.output'),
            tokenDetail(t, cost.tokens.outputTokens, cost.costs.outputCny),
            'output',
          ),
        );
      }
      if (cost.peakCny > 0) {
        rows.push(detailRow(t('cost.row.peak'), '¥' + formatCny(cost.peakCny, 4), 'peak'));
      }
      if (cost.offPeakCny > 0) {
        rows.push(
          detailRow(t('cost.row.offPeak'), '¥' + formatCny(cost.offPeakCny, 4), 'off-peak'),
        );
      }
      return h('dl', { className: 'dshcost_details' }, rows);
    }

    /**
     * Billed session cost (CNY) with a click dialog. The shipped usage pill
     * covers tokens; this one covers what those tokens cost.
     */
    function CostPill({ useProjection, t }) {
      const cost = useProjection('tokenCost');
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const [pos, setPos] = React.useState(null);

      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return;
        }
        const anchor = rootRef.current;
        const panel = panelRef.current;
        if (anchor === null || panel === null) return;
        const trigger = anchor.getBoundingClientRect();
        const box = panel.getBoundingClientRect();
        const maxLeft = Math.max(
          PANEL_MARGIN,
          window.innerWidth - box.width - PANEL_MARGIN,
        );
        const left = Math.min(
          Math.max(PANEL_MARGIN, trigger.left + trigger.width / 2 - box.width / 2),
          maxLeft,
        );
        let top = trigger.top - box.height - PANEL_GAP;
        if (top < PANEL_MARGIN) {
          top = Math.min(
            trigger.bottom + PANEL_GAP,
            Math.max(PANEL_MARGIN, window.innerHeight - box.height - PANEL_MARGIN),
          );
        }
        setPos({ left, top });
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Node) {
            if (rootRef.current !== null && rootRef.current.contains(target)) return;
            if (panelRef.current !== null && panelRef.current.contains(target)) return;
          }
          setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      const totalTokens =
        cost === undefined
          ? 0
          : cost.tokens.uncachedInputTokens +
            cost.tokens.cacheReadTokens +
            cost.tokens.cacheWriteTokens +
            cost.tokens.outputTokens;
      if (cost === undefined || cost === null || (cost.cny <= 0 && totalTokens === 0)) {
        return null;
      }

      const amount = '¥' + formatCny(cost.cny);
      return h(
        'span',
        { className: 'dshcost_anchor', 'data-composer-stat': 'cost', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dshcost_pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': t('cost.pill.aria', { amount }),
            onClick: () => {
              setOpen(!open);
            },
          },
          coinIcon(),
          h('span', { className: 'dshcost_label', children: t('cost.pill.label', { amount }) }),
        ),
        open
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  ref: panelRef,
                  className: 'dshcost_panel',
                  role: 'dialog',
                  'aria-label': t('cost.dialog.title'),
                  style: pos === null ? MEASURE_STYLE : pos,
                },
                h(
                  'div',
                  { className: 'dshcost_title' },
                  h(
                    'span',
                    { className: 'dshcost_titleLabel' },
                    coinIcon(),
                    t('cost.dialog.title'),
                  ),
                  h(
                    'span',
                    { className: 'dshcost_titleValue' },
                    '¥' + formatCny(cost.cny, 4),
                  ),
                ),
                h('div', { className: 'dshcost_titleRule', 'aria-hidden': true }),
                dialogBody(cost, t),
                h('div', { className: 'dshcost_note' }, t('cost.note.pricing')),
                h('div', { className: 'dshcost_note' }, t('cost.note.peak')),
                cost.fallback
                  ? h('div', { className: 'dshcost_note' }, t('cost.note.fallback'))
                  : null,
              ),
              document.body,
            )
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) {
            return () => {};
          }
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-cost-pill';
          tag.dataset.pluginCss = STYLE_TAG_ID;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'dsh-cost-pill: styles');

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cost-pill: dictionaries');

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'cost',
              order: 2,
              locale: NS,
            },
            CostPill,
          ),
        );
      },
    };
  },
});
