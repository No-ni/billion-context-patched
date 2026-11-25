# 2026-11-25：折叠后首轮锚定与退化路径丢标签

## 现象

用户报告某真实会话（`session-f88c1e89-d440-42b6-8a92-db14bd41cbd9`，114 次请求、17.9M 输入 token、命中 95.6%）有两处异常：

1. 第一次压缩启动后上下文没有降下来；
2. 之后出现两次缓存接缝（命中 15.6% 与 9.8%）。

## 证据

bili 会话报告（`/__bili/session-report?session=…`）的逐请求轨迹：

| # | 时间 | input | cached | hit | 备注 |
| --- | --- | --- | --- | --- | --- |
| 77 | 17:38:08 | 233K | 230K | 98.8% | nudge 注入，折叠前最后一轮 |
| 78 | 17:38:52 | 234K | 21K | 9.1% | 折叠已提交，出站仍未折叠 |
| 79 | 17:38:52 | 237K | 234K | 98.5% | 同上 |
| 80 | 17:39:54 | 144K | 23K | 15.6% | 折叠终于生效（237K→144K） |
| 105 | 17:47:16 | 191K | 19K | 9.8% | 入站 system 段 88,466→92,898 字节 |

`bili.log` 关键行：

```
17:38:28 [persist] ledger-aligned refs … kept=1 restamped=150 rehomed=86 blocked=3 superseded=236 (#4316 PR3/3)
17:38:28 [persist] remapped 8 token-snapshot entries onto ledger-aligned refs (#4599)
17:38:28 [snapshot-render] legacy fallback (block-unanchored)
17:38:28 [snapshot-recovery] re-prepared once after block-unanchored; rendered=false
17:38:28 [fold-reconcile] 14 covered id(s) retired by expected host behavior (…)
17:38:28 [acp-drift] fold coverage mismatch: 82/83 covered message id(s) present in resent history — 1 covered id(s) missing
17:38:28 request: 167 msgs, inbound=748.6KiB, outbound=756.3KiB   ← 未折叠
17:38:52 request: 169 msgs, inbound=758.8KiB, outbound=766.6KiB   ← 仍未折叠
17:39:44 [snapshot-render] active: outbound prefix now rendered from the unified transcript (issue #3756)
17:39:44 request: 173 msgs, inbound=765.0KiB, outbound=475.4KiB   ← 折叠生效
```

整场会话没有 `slow-ingest`，所以 B9 注释里"提交早于 ingest 落行"的解释不适用于本次：被覆盖的消息就在重发历史里（`82/83 present`），失配的是**统一记录行上的 id 与块记录 id 的空间**。`remintCoveredLiveIds` 依赖上一轮的 `state.lastPassIds` 才重铸被覆盖消息的编号，因此提交当轮必然空集，第二条请求仍未对齐。

## 根因

`loadTranscriptBase` 给块找行只有一条判据：`block.effectiveMessageIds` 与 `rows[i].msgId` 严格相等。折叠提交同时重写引用/账本映射，导致该判据在 1–2 轮内必然为空；唯一块失配就直接 `block-unanchored`，渲染退化为客户端原始历史。退化路径上 `renderWithSnapshot` 拿不到引用（`byRaw` 里没有客户端原始 id），ACP 标签整体消失，前缀从第一条消息起改写，缓存全量重算——这就是 17:38 那笔 213K 白付。第三轮 `remintCoveredLiveIds` 对齐后才渲染成功，于是又付了正常的 122K 折叠重建。

## 修法

`scripts/patch-bili-build.mjs` 新增步骤 9b（SPEC B27）：

- id 匹配为空时，用块自带的 `startSeq`/`endSeq` 区间匹配行；`parseRow` 令 `msg.ledgerSeq = seq + 1`，因此同时试 `seq+1` 与 `seq` 两种偏移，取与被覆盖消息数最接近且连续的一组；
- 命中数低于 `max(1, expected/2)` 或高于 `expected*2+16` 时不可信，保持原有 `block-unanchored` 降级；
- id 比较补上 `baseIdOf`（剥 `#` 后缀），与 `syncBlocks`/`isCovered` 口径一致；
- 成功时输出 `[snapshot-render] seq-anchor <blockId> rows=… expected=… offset=…`。

`assembleView`、B9 的最新块跳过、B10 的完整性证明、B23 的每条提醒一次折叠均未改动。

## 验证

- `node scripts/patch-bili-build.mjs`：步骤 9b 在既有产物上就地升级并幂等（重复运行输出 `seq-anchor: already patched`），`node --check vendor/billion-context/dist/index.js` 通过。
- 重打幂等：连续两次 `node scripts/patch-bili-build.mjs` 后 `vendor/billion-context/dist/index.js` 的 SHA-256 均为 `725ad07bbfb0512c3cb321235cccbfc81f57dbd55ac293f9e57a36380bf64d88`（字节一致）。
- `node scripts/check-all.mjs --offline`：15 个脚本全部通过，mock E2E 35 项、跳过 0；host 集成、真实 DSH、真实模型与网关不在本次运行范围。
- `node scripts/check-views.mjs`：33 项通过，其中新增三项——
  - `a freshly folded block anchors on its coverage interval`：块 id 全部失配、区间有效时仍渲染摘要并剔除被覆盖消息；
  - `an uncorroborated coverage interval keeps the refusal`：区间覆盖 40 行而记录只有 1 条时仍返回 `block-unanchored`；
  - `a ref suffix on the block ids does not break the id anchor`：`a#1` 按 base 口径锚定。

## 未覆盖与遗留

- 真实 DSH、真实模型与真实网关的缓存命中未在本轮验证；mock E2E 只证明"折叠后第一条请求就发出摘要"的既有断言仍通过。
- 通用退化路径（`store-unavailable`/`transcript-empty`/`chain-not-started`）仍会丢 ACP 标签、仍会付一次全量重建。本轮没有改成"复用上一轮出站字节"：那会把与当前引用表不一致的旧 ref 发给模型，与 B10「无法证明完整性时走原有降级/拒绝流程」冲突，需要单独决策与规范变更。
- 17:47 那处接缝与模块无关：入站 `system_len` 从 88,466 涨到 92,898 字节（+4,432），是宿主侧重写系统提示；需要开 `body-dump` 比对两份请求体才能定位到具体章节。
