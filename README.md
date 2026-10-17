# dsh-cost-pill

A DeepSeek Harness (DSH) Web GUI plugin that shows what the current session has cost so far, in
CNY, right in the composer dock row — next to the shipped activity and token-usage pills.

English | [中文说明](#中文说明)

## What it does

- Adds one pill under the input box: `≈ ¥1.07` for the current session.
- Click it to open a breakdown dialog: model, uncached input / cache-hit input / cache-write /
  output tokens with their amounts, the peak-period subtotal, the off-peak-period subtotal and the
  total. Close it with Escape or a click outside.
- Prices every settled assistant attempt with the **official DeepSeek CNY list price for the model
  and the period that attempt ran in**, so a session that switches models, or a turn that crosses
  the 12:00 / 14:00 / 18:00 peak boundary, still adds up correctly.
- Makes no network requests and stores nothing: the figures are derived from the session's own
  provider-reported token usage.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.1 < 0.3.0` (the `dsh` entry in `engines`), Web GUI profile.
- No API key, account login or configuration.

## Install

From the Web GUI: **Settings → Plugins → install** `dsh-cost-pill`, or use the plugin manager's
"add bundle" with the package directory.

From the CLI, into a profile:

```sh
dsh plugin --profile desktop add dsh-cost-pill
```

The bundle declares a host row (`tokenCost` session projection) and a browser half (the pill), so
both are loaded by the normal profile composition. Reload the Web GUI page after installing.

## Pricing

Official list prices in CNY per 1,000,000 tokens
([DeepSeek API docs](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)):

| Model | Period | Cache hit | Cache miss | Output |
| --- | --- | ---: | ---: | ---: |
| `deepseek-flash` | peak | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | off-peak | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | peak | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | off-peak | ¥0.15 | ¥4.5 | ¥13.5 |

Peak hours are Beijing time (UTC+8), Monday–Friday 09:00–12:00 and 14:00–18:00; everything else,
including weekends, bills off-peak at half the peak rate. Chinese public holidays also bill
off-peak but have no fixed weekday rule, so the plugin estimates them at the weekday rate.

Models the plugin does not know (third-party providers, future ids) are estimated at the
`deepseek-flash` price and the dialog says so.

## Notes

- The figures are estimates from provider-reported usage, not an invoice; the account balance is
  not shown (that is a separate concern).
- The legacy model ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are priced as
  `deepseek-flash`, as the provider does.
- The pill is hidden until the session has some billed usage.

## Development

The package is the bundle: `package.json` declares `dsh.bundle.patch` and the `dsh.client` browser
half, `cordis.patch.yml` inserts the host row, `index.js` registers the `tokenCost` session
projection, and `client.js` registers the pill in `conversation.composer.dock`.

Install a working copy into a profile for development with the plugin manager's bundle install
pointed at this directory; the linked package is picked up by the profile's HMR on the next
recomposition.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

在 DeepSeek Harness（DSH）Web 输入框下方显示**本次会话已花费的人民币金额**，位置就在系统自带的
「轮次/步数」「缓存命中/Token 用量」两个 pill 旁边。

- 平时显示 `≈ ¥1.07`，**点击**弹出明细：模型、未缓存输入 / 缓存命中输入 / 缓存写入 / 输出的 token
  数与金额，高峰时段小计、空闲时段小计和合计；按 Esc 或点击弹层外关闭。
- 按**每次请求结算时的模型和时段**计价：会话中途切换模型、或一轮跨越 12:00 / 14:00 / 18:00 的峰谷
  边界，都能正确累加。
- 不联网、不保存任何数据，金额由会话自身的 provider 上报 token 用量推导。

### 安装

Web 界面：**设置 → 插件 → 安装** `dsh-cost-pill`；或命令行：

```sh
dsh plugin --profile desktop add dsh-cost-pill
```

安装后刷新 Web 页面即可。

### 价格

官方价目（人民币 / 百万 tokens，见
[DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）：`deepseek-flash`
高峰时段缓存命中 ¥0.04、未命中 ¥2、输出 ¥8；空闲时段减半。`deepseek-v4-pro` 高峰 ¥0.30 / ¥9 /
¥27，空闲减半。高峰时段为北京时间工作日 9:00–12:00、14:00–18:00；周末与法定节假日按空闲价。
法定节假日没有固定星期规律，插件按工作日规则估算。未内置价格的模型按 `deepseek-flash` 价估算，并在
弹层中提示。

### 说明

金额是按 provider 上报用量估算的参考值，不是账单；账户余额不在本插件范围内。
