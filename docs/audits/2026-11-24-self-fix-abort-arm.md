# 自修复审计：客户端关闭语义与失败 arm 估算（B25 / B26）

日期：2026-11-24。用户要求：先查上游是否已修，有则采用上游，没有则自修并登记，供后续合并参考；完成后版本号不变，做好测试检查（m00410）。

本轮不改版本，仍是 0.8.0；只改补丁器、mock 网关、e2e 与文档，未提交、未推送、未安装到真实 profile。

## 1. 现象与证据

两处误判都在同一份本机日志里可复核。样本是 2026-11-24 的 `~/.local/state/billion-context/bili.log` 与 DSH 会话事件流；细节见 e2e 用例与下表。

### 1.1 B25：终止帧后的客户端关闭被记成中途 abort

- 全天 862 行 `client aborted mid-stream`，其中 858 行的前 4 行内已有 `[plugin] [acp-usage] input=… cached=…`——usage 已结算，内容已收全，不是断流。
- 真正的断流信号 `truncation signal path` 全天只出现 1 次（19:15 网络故障，DNS/连接超时）。
- 旧会话 `session-3065162e` 415 次请求里有 262 次 abort（63%），但会话事件流中 416 个 `step/start`↔`step/end` 全部配对、415 条 `assistant/message` 全部落盘；5 次 `llm/retry` 全部属于 19:16 的真故障 step。
- 副作用：`absorbAbortedTurnGrowth` 把 `nudge.lastPerMessageNudgeTokens` 抬到最新 meter（实测 21:45:49 `growth=0/67500 (ref=72824…)`、21:46:11 `ref=76615`，累计 `growth debt +7569 → 29457 over 15 absorb(s)`），growth 门被架空；当天真正注入的是 14 次 `INJECT-ESC`（70–71%）+ 8 次 `INJECT T1`（77–83%），即 `0.7×262,500=183,750` 的 ESC 门在起作用。

机制：DSH 客户端读到终止帧就断开；`res.on("close")` 触发 `clientAbort.abort()`，上游读失败进入 catch；catch 只看 `res.destroyed||res.writableEnded`，把已完成的回合记成 abort。第二层原因：OpenAI 风格 SSE 只在 `[DONE]` 置 `sawTerminal`，`finish_reason` 帧只置 `isTerminal`（Google 路径两者都置），所以客户端在 `finish_reason` 帧后立刻挂断时，终止证据还没建立。首版只改 catch，e2e 立刻以 `sawTerminal` 仍为 false 失败，随后补上 `finish_reason` 判定。

### 1.2 B26：失败 arm 的估算按字符计数

- `outboundPayloadBreakdown` 的 `armEstimate=Math.max(textEstimate,estimateCoreMessagesUpper(msgs))+overheadEstimate+imageTokens`，而 `estimateCoreMessagesUpper` 返回字符数。
- 实测：19:16:01 `armed emergency shrink with local estimate 659983 tokens`，同时段真实上下文约 217K（同值见 `[#4805] membership probe … payloadUpper=659983`）；同类 19:11:50 545323、19:11:51 325128、19:15:13 335438。真实 usage 到达后才会清掉这个假基线，期间诊断与 `acp_status` 都按假值显示。
- 影响范围：只影响压缩时机与诊断信号，不改变对话内容正确性；但会把 `lastInputTokens` 抬到不可能的值，进而影响后续预检判断。

## 2. 上游核查（有则采用，无则自修）

- 上游 `master` = `3afa91562`（2026-11-24T10:33:52Z）；`compare/8cdad29…master` ahead_by=10，10 个提交没有一条涉及这两处（含 `cd2929d06 fix(budget): scale emergencyNudge escalation threshold with maxContextLimitPct`，属另一个问题）。
- `src/plugin.ts:4156` 与 `:5243` 仍是裸 `if (session) noteAbortedTurn(session);`，没有终止判定；`src/server.ts:3705` 仍是 `const armEstimate = Math.max(textEstimate, estimateCoreMessagesUpper(msgs)) + overheadEstimate + imageTokens;`；`src/preflight.ts:624` 的 `estimateCoreMessagesUpper` 仍返回 `chars`。
- 上游相关报告仍未合并：issue #4059 / PR #4062（终止帧后不再报 truncation）、issue #7201（压缩计量按字符计）、PR #5501（只拒绝 estimate 级 arm，不换口径）。上游自带的 `tests/issue5293-abort-nudge.test.ts` 与 `tests/issue5415-absorb-debt.test.ts` 覆盖的是真 abort 路径，必须继续通过。
- 结论：上游未修，转自修；登记见 [SELF-FIXES.md](../SELF-FIXES.md)。

## 3. 修复内容

补丁器 `scripts/patch-bili-build.mjs` 新增三步（都带 already patched 幂等分支，锚点数量不符即抛错）：

- 步骤 24（B25）：catch 分类改为 `if(sawTerminal){log("debug","client closed after terminal")}else{log2?.("client aborted mid-stream");if(session)noteAbortedTurn(session)}`；两处记账点与一处只记日志的 commandcode 路径都覆盖。
- 步骤 25（B26）：`armEstimate` 的字符上界改为 `Math.ceil(estimateCoreMessagesUpper(msgs)/3)` 后参与比较。依据：CJK 由 `defaultCountTokens` 精确计价并已由 `textEstimate` 承载，非 CJK 密集 agent 文本最密约 3 chars/token；实测 659,983/3≈220K，与真实 217K 对齐。
- 步骤 26（B25 第二半）：`processOpenai` 在 `finish_reason` 非空时与 `processGoogle` 一样置 `sawTerminal`，让 `finish_reason` 帧成为终止证据。

测试替身：`scripts/fixtures/e2e-mock/gateway.mjs` 的 plan 新增 `{kind:"hold", beforeTerminal?, ms}`，在终止帧（或非终止 delta）之后保持连接，复现「终止帧已在线上、客户端先挂断」的真实时序。

e2e 新增 `clientCloseChecks()`：

1. 终止帧后关闭 → 出现 `client closed after terminal`，不出现 abort，不触发 growth 吸收，`[stream-trace]` 仍记录关闭。
2. 终止帧前关闭 → 仍记 `client aborted mid-stream`，不记终止（B25 反向控制）。
3. 三次 500 → 日志里的失败 arm 估算落在 token 空间：171,017 个核心字符 → 60,092 tokens（小于字符数一半、且不小于 `ceil(chars/3)`）。

## 4. 验证结果

- `node --check scripts/patch-bili-build.mjs`、`node --check vendor/billion-context/dist/index.js` 通过。
- 补丁器在干净产物上重打，产物与 `git show HEAD:vendor/billion-context/dist/index.js` 打补丁后的字节完全一致（`cmp` 相同）：干净产物 md5 `24457ebf3b1c6fd4c21f327f94cb169c` → 补丁产物 md5 `eb84833171395fb86dca2ba83039af76`；二次运行仍报 already patched 且 md5 不变。产物内 `client closed after terminal` 3 处、`Math.ceil(estimateCoreMessagesUpper(msgs)/3)` 1 处。
- `node scripts/check-e2e-mock.mjs` 通过 35 项（含新增 3 项），失败重试路径与原有 `aborted-turn` 真 abort 覆盖不变。
- 首轮失败记录（保留作为第二层根因的证据）：只改 catch 时，用例 1 断言失败并打印 `[info] … [e2e-close-after-terminal] client aborted mid-stream`；补上步骤 26 后通过。

## 5. 未覆盖与边界

- 真实 DSH 客户端（Electron/Web）的挂断时序只用本地 mock 复现，未在真实宿主上复测；真实网关的 usage 结算与 `finish_reason` 形态按上游 `/v1/chat/completions` 与 `/v1/responses` 代码路径推断，native/WS 路径不在本轮改动范围。
- B25 只改变「已完成回合」的分类与 nudge 基准；真 abort 的 `noteAbortedTurn`/`absorbAbortedTurnGrowth` 行为保持，仍由上游 `tests/issue5293`/`issue5415` 与本地 e2e 的反向控制共同覆盖。
- B26 的 `/3` 是字符到 token 的保守上界，不是精确 tokenizer；极端的非 CJK、非英文（如高密度代码或二进制转义文本）仍可能低估，但不会再出现约 3 倍的放大。
- 未在真实 profile 上安装或重启；未提交、未推送、未发布。
