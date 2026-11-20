# 2026-11-19：同一提醒重复折叠与 0.7.2 本机更新

## 根因

完整会话报告记载一次 T1 提醒后发生两次模型折叠。两次分别回收约 70K 与 15K token，cache hit 分别降至 28.5% 与 33.3%；报告将两次都归入同一条约 100K 的 T1 提醒。debug 日志在 17:28:19.276 记录一次 T1 注入，17:28:29.344 和 17:28:37.207 分别记录两次独立的模型 `compress` 请求，范围依次为 `m00001–m00150` 与 `m00151–m00257`。

根因是本地提醒 gate 的 transient credit 在提醒注入时设为 20 个模型回合，但模型工具 `applyConfiguredCompression` 首次成功创建 block 后没有消费该机会。于是模型在同一提醒 generation 中仍能再次显式调用 `compress`，第二次创建新摘要并再次改写有效请求前缀。报告中 17:25 的缓存接缝早于这两次折叠，不能归因于 B23；本次修复不声称解决上游缓存丢失。

窗口预检使用 `preflightCompress` 的自动压缩路径，并非本次重复模型工具调用的来源；B23 仅包装模型显式工具调用。

## 修复

B23 为每次实际注入的提醒分配递增 generation，并在 `applyConfiguredCompression` 外层跟踪该 generation 的在途调用与完成状态。只有调用开始时提醒 credit 仍有效，才认领未消费的 generation。零 block 或异常结果释放锁并允许重试；只要创建至少一个 block（包含 partial 结果）就消费 credit，并拒绝同一 generation 后续重复调用。新提醒开启新 generation。旧异步调用的完成与 finally 逻辑按 generation 所有权更新状态，不能消费新提醒的 credit 或清除新提醒的锁。已消费状态保留至新提醒；过期但未消费的提醒不认领后续独立折叠。

## 验证

- 首次 mock E2E 暴露的是 fixture 不满足提醒前置条件，不是生产 gate 回归：首个请求没有 usage 锚点，后续 mock gateway 又固定回报 `input=256`，因此真实 usage growth 始终为 0。没有降低 `minGrowthFloor=20000` 或改动生产提醒逻辑；专用 `NUDGE_GATE_USAGE_BASELINE` fixture 现在先建立 usage 样本，再按实际转发 body 大小递增回报 mock 输入 token。测试按真实两阶段顺序完成初次 T1 和新增长后的第二次 T1。
- `node scripts/install.mjs --build`：通过；生成可安装构建并通过内置 smoke、视图、图片、预检、存储、编码等检查。Node `v24.19.0`。
- `node scripts/check-e2e-mock.mjs`：通过 26 项，跳过 0；mock gateway HTTP 65 次、WS 5 次。B23 覆盖真实 T1 注入、零 block 后保留机会、第二次提醒注入、partial 调用创建 block、并发调用仅一个成功，以及成功后重复调用拒绝。纯 wrapper 竞态回归覆盖零 block 后同 generation 成功重试、异常释放锁/可重试、旧 generation 完成不能清除新提醒锁，以及过期提醒不认领独立折叠。`check-preflight.mjs` 的 21 项回归继续通过，自动预检不经模型工具 gate。
- `node scripts/check-all.mjs --offline`：15 个检查入口全部通过，包括 wrapper 和再次运行的 mock E2E（26 项、跳过 0）；输出明确标注真实 DSH/模型和 host integration 不属于本次离线结论。
- E2E 脚本确认候选子进程退出、localhost socket 关闭、隔离文件删除；随后检查系统临时目录，没有残留 `bili-e2e-mock-*` 或本轮构建临时目录。`git diff --check` 通过。

## 0.7.2 本机安装

目标 profile：`/Users/senno/.dsh/profiles/desktop`。`node scripts/install.mjs --profile /Users/senno/.dsh/profiles/desktop` 成功。源码与 profile 包均为 `0.7.2`，`patchBuild.id=18002a3e593bafb37e9dfe51d39363852e177d488ed565613b16b052f38cba9d`，`createdAt=2026-11-19T12:58:05.427Z`。源码及 profile 的 bili bundle SHA-256 均为 `03d5bc0a3c114953bb3923f8a1c2ada9f78668fa60584fd8b2729028c59fc919`；native bundle 均为 `36d163f9e57bf9f3ae35ee489aaf77ba31b427cdf9c43cff4e1c7c1af2b5d4ae`；`lib/client.js` 均为 `4aa48272fb0b6284a9e40c4764667026dc778b4518decae36d1fe2b4e07c60a0`；`lib/index.js` 均为 `a05447af04e11804025b17f59950c3800c787d36493f362ca75e73ec1c2befd5`。安装 bundle 确认包含 B23 generation wrapper 和此前 0.7.1 图片引用修复。

安装前后 profile `cordis.patch.yml` SHA-256 均为 `0cd6b06070fa20e04d0985d57e1188842377de683ff9789bf6af9f0101aed516`；profile `package.json` SHA-256 均为 `3f363aa989c55e547eddb5f7d19e862bd18a874315b1b7b98fc2a39c28d0b391`，provider 选择、图片预算和 profile wiring 未变。

PID `37383` 在本轮开始前已运行，安装后仍为同一进程并监听 `127.0.0.1:18798`；本轮没有重启或接管。它的内存继续运行旧加载版本；DSH 下次正常重启后才会加载 profile 中的 0.7.2。

本轮不提交、推送、打标签或公开发布；真实 DSH 重启后的模型行为和外部网关缓存命中仍不属于离线验证结论。
