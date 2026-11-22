# 失效图片预算备份清理与卸载保护（IMG-10a，2026-11-22）

## 现象

用户在模型设置页看到四个自己从未配置过的 provider：`amazon-bedrock`、`ant-ling`、`anthropic`、`azure`。它们各只有插件写入的三项预算键，没有 `apiKeyEnv`、`baseURL` 或 `models`。

## 来源与时间线

| 证据 | 内容 |
| --- | --- |
| `cordis.patch.yml.bak-20261119-before-run-code-fix`、`...bak-20261120-before-deepseek-account-compress-off` | `llm-pi-ai.providers` 下只有 `ylinkimi`、`test`，四个空档案尚不存在 |
| `~/.dsh/logs/desktop-next.log` 2026-11-21T17:40:27Z / 18:11:57Z / 19:06:48Z / 19:44:44Z | 四次 `settings namespace "llm-pi-ai" changed since it was read (expected revision 0, now 1)` → `(1, now 2)` → `(2, now 3)` → `(3, now 4)` |
| `provider-data.generated.ts` | catalog 字母序前四个正是上述四个 id |
| `store.ts:253` | `configured` 由“user 层存在该 provider 路径”判定 |

结论：0.7.5 修复前那版构建的 `flush()` 每次只读一次 `describe()`，第一条写入成功后其余路由共用过期 revision，冲突整轮放弃；每次设置事件只推进一个 provider，四个事件留下四个空档案。修复后的构建只填写已建档 profile（`defaults.js` 的 `authored === undefined` 分支），不会再新建。

用户在设置里删除四个档案后，暴露出两个后续问题。

## 问题一：备份条目不会随档案删除

`billion-context.json.image-budget-backup.json` 的条目在启动时读入 `applied`，`flush()` 每轮把整张表写回文件；已经删除的 provider 没有任何逻辑清理，`restore()` 也只会跳过它。结果是死路径永久留在备份文件里。

修法：`flush()` 每轮开始调用 `prunePiImageBackups(applied, rows)`，对照当前快照删掉 `providers.<id>` 已不存在的条目，仅在确有变化时写回。清理只作用于插件自己的备份表，不碰 settings 里的档案本身，也不会重建被删除的 profile。

## 问题二：宿主销毁顺序导致卸载钩子抛错

`desktop-next.log` 2026-11-22T06:34:23.673Z（旧进程关机，pid 18364）：

```text
TypeError: Cannot read properties of undefined (reading 'describe')
    at restore (file:///…/plugins/bili-context-patch/lib/defaults.js:284:30)
```

行号对应安装前的旧模块，说明该缺陷早于本轮改动。原因是 DSH 先销毁 settings 服务，再执行插件 `scope.effect` 的销毁回调；`restore()` 直接取 `scope.get("settings").describe()` 得到 `undefined`。

修法：`restore()` 在取到空服务时直接返回，外层 `try/catch` 兜住销毁期的读取异常并只记一条 warn。服务仍可用时（热卸载、禁用插件）行为不变。

## 验证

`node scripts/check-image-budget.mjs` → 19 项通过（原 16 项）。新增三项：

1. 预置一条 `ghost` provider 的备份，首轮写入后断言文件里不再出现它。
2. 给 `keep`/`gone` 写预算后删除 `gone` 并触发 `settings/document-updated`，断言备份只剩 `keep`。
3. 删除 mock 的 settings 服务后执行销毁，断言不抛错、无 warning、备份文件保留。

反向验证（临时改坏 `lib/defaults.js` 后复跑，再恢复）：

| 反向改动 | 结果 |
| --- | --- |
| 去掉 `prunePiImageBackups` 调用 | exit 1，`a dead backup entry must be pruned` |
| 去掉 `if (!settings) return;` | exit 1，`teardown must not report an error once the settings service is gone` |

`node scripts/check-all.mjs --offline` 全部入口通过（见下文交付记录）。

## 边界

- 备份清理不删除 settings 档案；四个空档案由用户在设置页删除。
- 关机时跳过恢复不会回滚已写入的预算值——这是宿主销毁顺序决定的，不是新行为。
- 本轮仍为 0.7.5，不升版；离线验证后安装到本机 DSH profile，重启由用户执行。
