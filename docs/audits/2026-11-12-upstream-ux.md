# 2026-11-12 上游熔断、横幅与报错口径的移除（B19–B21）

本页记录这一轮改动的来源、验证与未覆盖项。改动在 0.6.6 提交，没有发布到 npm 或插件商店。

## 1. 起因

用户看到 shell 左上角「1 个上游不可用」的红色横幅与「约 46s 后重试」，以及对话窗里的 `503 "acp-proxy failure: connect-timeout <host> (circuit open, next probe +46s)"`。两样都是 bili 自己的熔断与健康上报产生的，不是 DSH 的提示。用户要求：不要熔断（交给 DSH 重试）、横幅整个删掉、报错翻译成中文、不做探测。

## 2. 改动

- B19（`scripts/patch-bili-build.mjs` 第 19 节）：删掉 `CIRCUIT_OPEN_AFTER` 起的熔断整块、`/__bili/upstreams` 路由与四处调用点（提前失败、成功清理、失败记账、拼进 `handleAcpStatus`）。保留失败分类、`describeUpstreamFailure`、`isFailFastUpstreamKind` 与只进诊断的 alerts。
- B20（`scripts/patch-bili-client.mjs`，新增）：删掉客户端 `UPSTREAM_POLL_MS`、`parseUpstreamHealth`、`upstreamBanner`、`shell.overlay` 注入与四个 `upstreams_*` 词条（中英），`probe_error` 改成中文说明。
- B21（`scripts/patch-bili-build.mjs` 第 21 节）：`buildProxyFailureResponse` 的 error 走新的 `__biliFailureTextZh`，413 保留、其余 502，去掉 retry-after 头与 `circuitOpen`/`retryAfterSeconds` 字段；流内联错误同样中文化；日志保持英文。

## 3. 验证

- `node scripts/install.mjs --build --out /tmp/bili-out`：视图检查 → 图像卡 → `check-upstream-ux.mjs` → `smoke.mjs`（3 例）全绿，客户端 bundle 打出 `upstream banner: removed`、`probe_error: worded for the reader`。
- 产物复查：`lib/client.js` 中 `bili-upstreams`、`upstreams_down_one`、`shell.overlay` 计数为 0；`vendor/billion-context/dist/index.js` 中 `CIRCUIT_OPEN_AFTER`、`/__bili/upstreams`、`circuit open` 计数为 0，`__biliFailureTextZh` 存在。
- `scripts/check-upstream-ux.mjs` 实跑 `__biliFailureTextZh`，覆盖连接超时、拒绝连接、本机取消、未知类型、请求体过大、以及“错误上没有上游标记”等分支。
- 重建一致：从 HEAD 的 dist 重跑 `node scripts/install.mjs --build`，`lib/client.js`、`vendor/billion-context/dist/index.js`、`dsh.bundle.patch.yml` 与 `--build --out` 临时目录里的结果字节一致，`patchBuild` 标识相同。
- 提交前复查：`check-wrapper.mjs` 第 289 行的路径断言在 macOS 上因 `/var → /private/var` 恒红（`git archive HEAD` 的干净副本同样失败，属既有环境问题），已改用 `realpathSync` 比较两侧真实路径；修好后整套 `check-wrapper.mjs` 全绿。

## 4. 未覆盖

- 真实 DSH 页面里是否还残留横幅、插件安装后是否随重启生效，需要装到 profile 并重启后人工确认。
- 真实网关上的重试次数与退避由 DSH 决定，本轮没有测量连通性恢复时间。
- 本机只验证了构建、检查脚本与冒烟；真实网关上的重试次数与退避由 DSH 决定，仍未测量。