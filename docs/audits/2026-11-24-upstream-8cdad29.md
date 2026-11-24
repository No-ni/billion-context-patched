# 2026-11-24 上游 8cdad29 合并审计

合并审计记录，按 [SPEC 第 7 节](../SPEC.md#7-每次合并的强制核对流程) 填写。历史状态，不冒充当前实现。

## 来源 / 合并范围

- 上游 [billion-context](https://github.com/ranxianglei/billion-context) 固定提交从 `548e396022b9391e28a3c9061560be297779b8e8`（kernel 0.0.198）换到 `8cdad29529b625c7222554a482a65063a8dc525b`（kernel 0.0.208）。两者之间 663 个提交、88 次 PR 合并；manifest 仍为 0.1.216，npm `latest` 未变，仍不能以标签判断基线。
- 分支 `merge/upstream-8cdad29`，起点 `06c6ea1`（B24 流写入轨迹）。
- 方式：干净固定源码重建（独立 git init + `git fetch --depth 1` 该提交 + `npm ci` + `npm run build`），产物与 npm 包 `billion-context@0.0.1318-master.8cdad29` 逐字节相同（dist/index.js sha256 前缀 c2ce15cd89589838，6565571 字节；dsh-native.js 711329b8；dsh-native-client.js a3f762e8；dsh-compaction-gate.js df4c9020），然后用三个补丁器重打；不是复制旧补丁产物。
- 可复现性：把同一干净 `dist/index.js` 交给 `scripts/patch-bili-build.mjs` 重打两次，两次与仓库 `vendor/billion-context/dist/index.js` 的 sha256 完全一致（`21233605926b870adaab85c74a51f25e6bb2dfee74190f1c7a2ab4b84313ec21`）；第二次运行 31 处输出 "already patched"，幂等成立。

## 补丁重钉（锚点失效 7 处）

1. B18/B23 nudge gate 写入：上游给 `t.unpromptedGate` 追加 `postComPressTail:stamp2.postComPressTail===true`。
2. B23 gate 读取：`return{...}` 追加 `postComPressTail:g2.postComPressTail===true`。
3. B22 预检入口签名：末尾由 `instanceId){` 变为 `instanceId,v1Meta){`。
4. B22/B21 预检状态：上游改为 `const status=f2?.kind==="upstream"&&f2.status===429?503:502;`；见下节决策。
5. B21 Responses 完成帧：`response.output_text.delta` 新增 `content_index:0`。
6. B21/IMG-13 转发 413：上游删除 `stage:"forward"` 与 `message:fuseMessage`，只剩 `err2.message` 与 `code:"egress_window_fuse"` 的 countMessage。
7. B16/IMG-10a native 配置读取守卫：`readFileSync2(path31,\"utf8\")` 漂移为 `readFileSync3(path65,...)`，改为按 `function loadConfigFile` 定位别名函数。

## 上游等价替代 / 需求变更依据

| 项 | 上游变化 | 判定与依据 |
| --- | --- | --- |
| 本地估算 413 | #7537 取消按本地估算拒收，只有 `statedWall>0`（上游已证明的窗口）才 failFast(413)，其余转发一次由上游仲裁 | 采纳。SPEC B22 的"重建后仍不合格时保留原有拒绝与大小保护"由证据门控 413 满足；`check-preflight.mjs` 增加 `arm` 选项区分"已证明/未证明"，mock E2E 的不可约 payload 改为断言"只转发一次、由上游作答" |
| 429 → 503 | 上游新增 `f2.status===429?503:502` | **拒绝**。docs/SPEC.md:152（B19）明写不得返回 503 或 retry-after；补丁器继续强制 `const status=502;`，check 断言 429→502/retryable true |
| 统一 KV 会话顺序载体 | 上游删除 `hydrateOrderUnified` 与 `session-order/v1` | 随上游。e2e 的 `hasKvMigration` 改为只要求 `hydratePluginConversationsUnified` 与 `hydrateAffinityUnified`；storage 断言删除 session-order |
| 损坏 KV 行策略 | #7156：信封仍是恢复来源；conversation 载体按 #5753 用信封重写坏行，affinity 载体的解析错误中止本次 hydration、行保持原样 | 随上游。e2e 的 `assertMalformedKvHandling` 断言两种载体各自的真实行为，不再期待"修好所有载体"；affinity 复合文件被重写时只断言旧链条（sessionId/tailHash）仍在 |
| `/compact` 命令 | #7154 在 `dsh.bundle.patch.yml` 新增 `command-compact disabled: true` | 随上游保留。`scripts/install.mjs` 的 `stripInserts` 只删插入行，生成的根 `dsh.bundle.patch.yml` 第 55–56 行仍含该行 |
| compress 只剩 line-form / emergency digest 默认关 / ingest 成本带默认 0 / 429 governor 默认关 / #7190 preset 压缩 disabled | 上游内部默认调整 | 本仓库无对应定制，无冲突；SPEC B1–B24 未就这些默认值作要求 |
| B18 提醒默认 80000 | 上游仍为 50000 | 保留我们的补丁（用户明确要求的例外，SPEC B18） |

## 条款核对（47 个功能 ID）

**B1–B17、W1–W7、I1–I5、IMG-01–IMG-13：已核对，无行为变化**。依据：三个补丁器在同一干净上游上逐步骤命中，锚点失效项全部重钉（见上），最终产物与 `check-all --offline` 全部通过；B12–B15、B17 的删除项（IMG-01–09、IMG-11）未复活，`check-image-budget.mjs` 24 项、`check-image-card.mjs` 全绿。

**B18–B24 逐项：**

| ID | 结果 | 证据 |
| --- | --- | --- |
| B18 | 重钉（gate 形状变化） | `check-views.mjs` 默认值与估算/真实用量断言通过；产物仍为 80000 |
| B19 | 保留 | `check-upstream-ux.mjs` 的 B19 字符串断言通过；mock E2E 的失败循环新增"每次失败都必须到达上游"计数断言（≥4），本地熔断会被抓住 |
| B20 | 保留 | `check-upstream-ux.mjs` 现在强制校验 `lib/client.js`（要求 client 路径，不再静默跳过），B20 断言通过 |
| B21 | 重钉（完成帧 content_index、转发 413 字段删除） | `check-upstream-ux.mjs`、`check-preflight.mjs` 的六类中文文案与 413/502 断言通过；429→502 由 SPEC B19 强制 |
| B22 | 重钉 + 语义采纳（#7537） | `check-preflight.mjs` 21 项（含二次校正四种结束状态、持久化计数）；mock E2E 的 SQLite 读失败后保存/重渲染 |
| B23 | 重钉（gate 读写形状） | mock E2E 的 T1 注入、零 block 重试、partial 成功拒绝、跨轮锁、跨 generation 并发全部通过 |
| B24 | 保留 | mock E2E 在真实请求上读取 `[stream-trace]` 三行；产物内步骤 25 idempotent |

## 缓存钥匙：PCK-01–PCK-05

- PCK-01（默认开启及配置优先级）：`check-views.mjs` 与 `check-wrapper.mjs` 通过；本机未以显式 enabled 代替默认检查。
- PCK-02（尊重显式选择）：mock E2E 的 `PCK-02 disabled and auto routing stop the proxy from adding a key it did not get` 为三种模式各自起进程：`disabled` 不注入 `prompt_cache_key`，`auto`/`enabled` 在本插件车道注入（relay-affinity 规则，只有 disabled 才 drop）。
- PCK-03（设置页与运行时一致）：`check-image-card.mjs` 页面解析与假 DOM 通过。
- PCK-04（可重复应用）：本次重打两次逐字节一致（见上）。
- PCK-05（验收证据）：本文件即证据，未覆盖项见末尾。

## 历史故障回归 / 等价覆盖依据

- B22 的 SQLite 读失败→保存→重渲染：mock E2E "a one-shot SQLite transcript read miss recovers…" 通过，请求计数不重复。
- B23 重复折叠：mock E2E 的 nudge 组通过。
- B10 的画面完整性与 seam 最小值：`check-views.mjs` 现在从产物读取 `MIN_SEAM_RUN`（值为 2 时断言通过），不再由检查自带常量冒充。
- IMG-12/IMG-13：`check-image-budget.mjs` 24 项与 mock E2E 的三条 413 折叠用例通过；IMG-13 的失败回滚三条仍未断言（待修复偏差）。

## 验证与结果

- `node scripts/install.mjs --build`：exit 0，smoke 全绿（views/preflight/storage/outbound-encoding/image-card/image-budget/upstream-ux/smoke）。
- `node scripts/check-all.mjs --offline`：**offline checks passed (14 scripts)**；其中 mock E2E 31 项、skipped=0（把"跳过"改为断言后不再允许静默跳过）；新增 `check-image-restore.mjs` 执行产物内的还原缓存上限。
- 检查工具链改动：`check-views.mjs` 与 `check-preflight.mjs` 的 vm 上下文补齐上游新增 helper（`moduleKnobs`、`measuredOutbound`/`responsesPreflightMeter`、`NON_MODEL_TOP_LEVEL_KEYS`、SSE 行结束 helper）；缺 helper 时直接报错而不是"缺测试变量"。
- 未运行：`check-runtime.mjs`、`check-ledger-runtime.mjs` 需要 `--host-modules`。本机尝试用 `/Applications/DSH NEXT.app/Contents/Resources/app.asar.unpacked/node_modules` 运行 `check-runtime.mjs --host-modules`，失败于 `ENOENT … @deepseek-ai/cordis/package.json`（该目录只有 native 附件，没有 DSH 包），因此这两项仍未运行；真实 DSH、真实模型与真实网关同样未验证。

## 未覆盖项 / 待修复偏差

1. 已补齐（本轮）：PCK-02 三模式（e2e）、IMG-13 折叠失败回滚（e2e 断言 `stats.requests` 恢复、无残留 block、诊断日志）、IMG-12 的 96 片/64 MiB/64 会话/256 MiB 全局上限与开关（`check-image-restore.mjs`）。
2. 仍未断言：IMG-10a 的 `.corrupt-<时间戳>` 备份改名与写失败/删除失败分支；B10 的 shadow lane 定向用例。
3. `.github/workflows/check.yml` 与 `release.yml` 只跑 `--offline`，host 检查在 CI 从不执行；`check-all.mjs` 只看退出码、子进程无 timeout。
4. `check-views.mjs` 的默认 80k 仍以 4 条 `source.includes` 为主证据；`split(...).length-1` 式调用点计数仍在两处。
5. 真实页面横幅、真实 DSH 退避、真实网关重试次数均需人工/集成验证。
