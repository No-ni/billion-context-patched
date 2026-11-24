# 自修复记录

本文件登记「上游主线尚未修复、由本仓库自行修复」的行为，与 [SPEC.md](SPEC.md) 的稳定条款一一对应。合并、rebase、替换 vendor 或升级上游之前必须先读本文，逐条判断上游是否已经修复：

- **上游已提供等价实现**：删除对应的补丁步骤（锚点被上游改动时补丁器会直接失败，不会静默跳过），在 [MAINTENANCE.md](MAINTENANCE.md) 中把实现位置改为上游来源，并把下表对应行标为「已被上游 \`<提交>\` 替代」。保留审计记录，不删除本文。
- **上游仍未修复**：保留补丁步骤，按「合并时复核」列在候选构建上重新验证，并把新的上游基线写进本页。

固定上游基线：ranxianglei/billion-context `master` = `3afa91562`（2026-11-24T10:33:52Z，manifest 0.1.216，kernel 0.0.208）。核查材料：`gh api repos/ranxianglei/billion-context/compare/8cdad29529b625c7222554a482a65063a8dc525b...master`、上游 `src/` 与 `tests/` 的当前内容。

| 编号 | 条款 | 症状 | 根因（上游位置，2026-11-24 基线） | 本地修复 | 上游状态 | 合并时复核 |
| --- | --- | --- | --- | --- | --- | --- |
| SF-01 | B25 | DSH 客户端拿到终止帧后立即断开，bili 把这类正常收尾记成 `client aborted mid-stream`，并对已完成的回合执行 `noteAbortedTurn` → `absorbAbortedTurnGrowth` 把 nudge 的 growth 参考点抬到最新 meter，growth 门长期为 0，提醒只剩 0.7 的 ESC 门在触发 | `src/plugin.ts` 的 catch 只用连接状态判断：`if(res.destroyed\|\|res.writableEnded){…;if(session)noteAbortedTurn(session);…}`（基线 :4156、:5243 两处）；另外 OpenAI 风格 SSE 只在 `[DONE]` 置 `sawTerminal`，`finish_reason` 帧只置 `isTerminal`（compare 中 `processOpenai` 与 `processGoogle` 不对称），客户端恰好在 `finish_reason` 帧后挂断时终止证据缺失 | 补丁步骤 24（catch 以 `sawTerminal` 分类，真 abort 仍记 `noteAbortedTurn`）+ 步骤 26（OpenAI `finish_reason` 帧同时置 `sawTerminal`，与 Google 路径对齐） | 未修。基线 master 两处仍是裸 `noteAbortedTurn`，无终止判定；相关 issue #4059 与 PR #4062（终止帧之后不再报 truncation）仍未合并 | 用下方命令确认两处 catch 已带终止判定、`processOpenai` 与 `processGoogle` 对称；上游若改用它自己的判定，删除步骤 24/26 并把 e2e 断言改为上游日志 |
| SF-02 | B26 | 上游/网络失败时 `armFailureShrink` 用字符数当作 token 数武装应急缩窗，约 3 倍放大（实测 659,983 vs 真实 217K），`lastInputTokens` 被抬到不可能的值，诊断与后续预检都按假基线工作 | `src/server.ts` 的 `outboundPayloadBreakdown`：`const armEstimate=Math.max(textEstimate,estimateCoreMessagesUpper(msgs))+overheadEstimate+imageTokens;`，而 `estimateCoreMessagesUpper` 在 `src/preflight.ts` 返回的是 `chars` 字符数（不是 token） | 补丁步骤 25：`Math.ceil(estimateCoreMessagesUpper(msgs)/3)`，把字符质量换算回 token 上界；CJK 由 `defaultCountTokens` 精确计价并已由 `textEstimate` 承载 | 未修。同一口径问题见上游 issue #7201（首个请求的压缩计量按字符计）；PR #5501 只是拒绝 estimate 级 arm，没有换口径 | 用下方命令确认 `armEstimate` 仍以字符为界且未自带 token 换算；上游若改为 token 口径或增加证据等级，删除步骤 25 并核对 `armFailureShrink` 的门槛语义 |
| SF-03 | B26 附属 | 自修复的测试替身（mock 网关的 `hold` 计划）只用于本地 e2e，不改变产品行为 | — | `scripts/fixtures/e2e-mock/gateway.mjs` 的 `hold` 步骤 + `scripts/check-e2e-mock.mjs` 的 `clientCloseChecks()` 三个用例 | 不适用 | 上游 e2e 若覆盖同类场景，优先复用上游用例并删除本地替身 |

## 复核命令

在候选上游检出里执行（路径相对上游仓库根目录）：

```sh
# SF-01：两处 catch 是否仍无条件记 abort；OpenAI 路径是否仍只在 [DONE] 置终止
grep -n 'client aborted mid-stream' src/plugin.ts
grep -n 'noteAbortedTurn' src/plugin.ts
grep -n 'sawTerminal=true' src/plugin.ts

# SF-02：失败 arm 的估算口径
grep -n 'const armEstimate' src/server.ts
grep -n 'function estimateCoreMessagesUpper' -A 6 src/preflight.ts

# 两个修复点的最终行为（在打补丁后的产物上）
grep -c 'client closed after terminal' dist/index.js
grep -c 'Math.ceil(estimateCoreMessagesUpper(msgs)/3)' dist/index.js
```

判定标准：SF-01 需要「catch 里先判断终止事件再决定是否 `noteAbortedTurn`」且「OpenAI `finish_reason` 帧被视为终止」两点同时成立；只满足其一仍会漏判（本次修复第一版就是只改了 catch，e2e 立即暴露 `sawTerminal` 仍为 false）。SF-02 需要 `armEstimate` 的字符质量以 token 上界参与比较，不能只是把字符数直接当成 token。

## 与补丁器的关系

两个修复都由 `scripts/patch-bili-build.mjs` 的步骤 24–26 重打；上游移动了锚点会直接报错退出，不会生成半成品。`node scripts/check-e2e-mock.mjs` 的 `clientCloseChecks()` 在最终构建上验证三类行为：终止帧后关闭不记 abort、终止帧前关闭仍记 abort、失败 arm 的估算落在 token 空间。审计与实测证据见 [2026-11-24 自修复审计](audits/2026-11-24-self-fix-abort-arm.md)。
