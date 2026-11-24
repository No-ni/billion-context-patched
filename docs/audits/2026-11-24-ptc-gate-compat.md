# PTC preset 启动兼容性修复

## 症状与根因

DSH 0.2.2-rc.5 加载 bili-context-patch 0.8.0 时，`bili-compaction-gate` 报 `cannot get property "agentPresets" without inject`。该异常发生在闸门提供 `biliBasicCompactionPolicy` 之前，导致 `preset-standard`、`preset-ptc`、`preset-minimal` 和 `preset-cordis` 全部停在 `pending`。

新版 Cordis 把 `agentPresets` 的运行时读取限制在 `inject()` 上下文。旧版 gate 直接读取可追踪属性并把“不可用”误当成异常，阻断了闸门的其余初始化。

## 修复

`scripts/patch-bili-compaction-gate.mjs` 将可选的 `presetRegistryOf()` 查找包在 `try/catch` 中。运行时覆盖不可注入时只跳过覆盖，压缩策略服务仍由 gate 正常注册。`scripts/install.mjs` 在构建和安装时统一应用这个幂等补丁，仓库与当前 profile 的 vendored gate 已同步。

## 引入点与同类审计

问题由 `8f20218`（2026-11-24 合并上游 `8cdad295`，billion-context 0.8.0）带入。该提交把 gate 从仅处理 `internal/config` 扩展为运行时包装 preset registry，新增 `presetRegistryOf(ctx)` 和 `installRuntimePresetCoverage(ctx)`；其中 `presetRegistryOf` 在进入 `inject()` 前直接读取 `ctx.agentPresets`。此前 `548e396` 版本没有这条访问路径，组合层 `dsh.bundle.patch.yml` 和本地安装器也没有删除 PTC 配置。

对当前插件的源码、补丁块、生成的 host/client 产物和 vendored agent 做了 `ctx.<property>`、`agentPresets`、`inject()` 相关扫描。除上述上游 gate 外，运行时代码中的宿主服务读取均位于显式 `ctx.inject(...)` 回调或使用 `ctx.get(...)` 的兼容路径，未发现另一处同型的 inject-only 属性直接读取。`lib/index.js` 中的 `ctx.fiber`、`ctx.logger` 和 `ctx.get(...)` 属于包装层公开上下文访问，不是本次 Cordis traceable service 约束涉及的 `agentPresets` 路径。

新增 `scripts/check-compaction-gate.mjs` 并接入 `check-all.mjs --offline`。检查用会抛出 `agentPresets` getter 的上下文复现 DSH 0.2.2-rc.5 行为，断言 gate 仍注册 `biliBasicCompactionPolicy`，并在可注入 registry 时断言 preset 覆盖仍生效。

## 验证

- `node scripts/install.mjs --build` 通过 views、image-card、image-budget、upstream UX、preflight、storage、smoke、outbound-encoding 全部检查。
- `node scripts/install.mjs --profile /Users/senno/.dsh/profiles/desktop` 完成当前 profile 安装。
- 重启 DSH 后，2026-11-24 14:59:33 的启动记录显示 `plugins.summary` 为 `active: 187, pending: 0, failed: 0`，同一启动不再出现 `without inject`；PTC preset 已从 pending 队列恢复。
- `node scripts/check-compaction-gate.mjs` 通过 inject-only getter 回归检查；该检查已纳入离线总入口。
- 本轮再次尝试 host 门禁时，发现本机可定位的 npm 缓存目录是 `@deepseek-ai/dsh` 0.1.0-rc.7 / Cordis 4.0.1，并在加载加速器时因 `z.dict(...).volatile` 缺失提前失败；它不是审计所需的 DSH 0.2.2-rc.5 host modules，因此本轮不把该次 host 结果计为通过。此前审计记录的 0.2.2-rc.5 host 检查证据仍保留，但本轮未能从本机重跑。
- 随后在隔离目录 `/tmp/dsh-host-rc5.bX1G9E` 按 CI 同一命令安装 `@deepseek-ai/dsh@0.2.2-rc.5`，核对 DSH 0.2.2-rc.5、Cordis 4.1.0、Zod 4.6.7 后重新运行 `node scripts/check-all.mjs --host --host-modules /tmp/dsh-host-rc5.bX1G9E/node_modules`，`check-runtime` 与 `check-ledger-runtime` 均通过。host 入口现在会先拒绝错误 DSH 版本，避免旧缓存以深层 Zod 错误失败。
