# 2026-11-22：PI 图片预算逐路由写入

## 结论

IMG-10a 的写入在真实环境里只落到了第一个 provider。`flush()` 每次只读一次 `settings.describe()`，而同属 `llm-pi-ai` 命名空间的多条 provider profile 共用一个 revision；第一条写入成功后其余全部 `SETTINGS_CONFLICT`，冲突计数整轮累加并立刻抛错，整轮放弃。修复后每次写入都重新读取快照，冲突只重试当前路由；同时只填写用户已建档的 profile，避免把 30 余个未配置的 catalog provider 一次性建成「已配置」。

## 现场证据

被复核的实机会话为 `session-38607dba-bfc1-4b39-9623-0dbe02413886`（cwd `/Users/senno/Documents/deepseek-harness/default-workspace`），72 次请求全部完成、无重试，provider 为 `test`（`llm-pi-ai`，`openai-completions`），模型 `deepseek-v4.1-flash`。

| 证据 | 内容 |
| --- | --- |
| `~/.dsh/logs/desktop-next.log` 01:40:27.878 | `settings namespace "llm-pi-ai" changed since it was read (expected revision 0, now 1)` |
| 同文件 02:11:57.657 | `settings namespace "llm-pi-ai" changed since it was read (expected revision 1, now 2)` |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | `providers` 下只有 `amazon-bedrock`、`ant-ling` 各三项预算键；`test`、`ylinkimi` 没有任何一项 |
| `~/.config/billion-context/billion-context.json.image-budget-backup.json` | 只有上述两条 entry，mtime 02:11:57 |
| 生效值 | `test` 用 DSH 默认 `requestImageMaxBytes=1048576`、`requestImagePixelBudget=4194304`，并保留用户自填 `maxRequestImageBytes=33554432` |
| 对照 | 宿主 `llm-deepseek` / `llm-deepseek-account` 的 `maxImagesPerRequest: 20`、`imageOffloadCountQuantum: 10` 已写入，说明写入链路本身可用 |

两次日志相隔约 31 分钟，各自只推进一个 provider：命名空间级冲突把「一次 flush 写全部路由」变成了「一次事件写一个 provider」。

## 根因

`lib/defaults.js` 的 `flush()` 在 `while` 外层取一次 `rows`，之后对每条路由 `await settings.mutate(row.ns, ops, row.revision)`。`settings.describe()` 返回的是快照，`mutate` 用实时 revision 校验（`packages/settings/settings/src/index.ts` 的 `SettingsConflictError`，「expected revision N, now M」），因此同一命名空间第二次写入必然冲突。旧代码在冲突时把 `conflicts` 加一并在超过 3 次后抛错，而这个计数器跨路由累加：`llm-pi-ai` 目录里的路由远多于 4 条，第一轮就撞线抛出，剩余路由只能等下一条 `settings/document-updated`。

`restore()` 本来就是每次重新 `settings.describe()` 后取 `row.revision`，所以卸载路径没有这个问题；缺陷只出现在安装/更新路径。

## 修复

1. 写入后重新读取快照。`flush()` 用 `let rows`，每次 `mutate` 成功或发生冲突后重新 `describe()`；冲突时进入内层 `for (;;)` 重试**当前**路由，只有连续冲突超过 3 次才抛错。同一命名空间的多条路由可以在一次 `flush` 内写完。
2. 只为已建档的 profile 写入。`piImageBudgetOps` 在 `row.user.providers[provider]` 不存在时返回空操作。`llm-pi-ai` 的可配置路由目录是「全部内置 catalog provider + 已声明路由」（`packages/llm/llm-pi-ai/src/index.ts` 的 `directoryEntries`），DSH 自测断言该目录大于 30 条；而模型设置页把「`value` 上存在该 provider 路径」当作 `configured`（`packages/client/ui-settings-models/src/client/store.ts:253`），替没人配置的 provider 建档会把它们全部显示为已配置。用户之后新增 provider 时，`settings/document-updated` 会再触发一次 `flush` 补上。

两项都不改变写入的键与数值：`requestImageMaxBytes=153600`、`requestImagePixelBudget=1440000`、`maxRequestImageBytes=2097152`，以及卸载时只恢复插件实际写入且期间未被用户改动的字段。

## 验证

- `node scripts/check-image-budget.mjs`：16 项通过。集成场景改为 `llm-pi-ai` 同一命名空间下五条 provider 路由，`describe()` 返回快照、`mutate` 对过期 revision 抛 `SETTINGS_CONFLICT`、每次写入使 revision +1；断言五条 profile 全部拿到三项预算、原生两路由随后更新、卸载后五条 profile 只剩原有字段。
- 反向验证：把 `flush()` 换回旧实现后，同一场景以真机同款报错 `settings namespace "llm-pi-ai" changed since it was read (expected revision 1, now 2)` 超时失败，确认新检查能挡住该缺陷。
- 新增单元检查：未配置 catalog 路由不写入（`anthropic`、`openai`、`groq`）、坏 profile 失败关闭、PI 默认值要求已建档 profile。
- `node scripts/check-all.mjs --offline`：13 个检查入口全部通过（116 项 OK）。其中 `image budget: 16 checks passed`、`maintenance: 46 B/W/I/IMG stable IDs, 28 documents, 133 local links OK`、`views: 30`、`preflight: 21`、`storage: 19`、`e2e mock: 23`（HTTP 43、WS 5）。

## 边界

- 本轮只改仓库内源码、检查与文档，没有安装或重启真实 DSH，也没有提交、推送、打标签或发布；真机上两份遗留的 `amazon-bedrock`、`ant-ling` 空档案未清理，需要时可在模型设置里删除或由卸载恢复逻辑移除其三项键。
- 未运行 host integration、真实 DSH、真实模型或外部网关检查；集成场景使用的是进程内 mock settings 服务。
