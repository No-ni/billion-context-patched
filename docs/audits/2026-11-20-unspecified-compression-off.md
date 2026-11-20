# 2026-11-20：未指定渠道默认压缩关闭

## 结论

B1 的默认策略有误：当请求没有 `x-accel-compress` 指令时，helper 将空指令交给全局 `upstream.encoding`，导致未配置渠道也继承 `gzip`。现在只有明确的 `gzip`、`br` 或 `on` 才允许压缩；缺失、空值和未知指令一律按 `off` 处理。`on` 仍单独表示采用全局算法。

## 根因与影响范围

渠道配置里，`deepseek-official` 的 `enabled: false` 会明确生成 `off`；`ylinkimi` 和 `test` 的 `encoding: auto` 会明确选择 `br`。未配置 `deepseek-account` 时没有发送压缩指令，旧 helper 因而落到全局 `gzip`，中转站返回 HTTP 400。

修复只调整 B1 对未指定/无效压缩指令的解析。I4 对 `www.didudidu.asia` 与 `154.219.111.56` 的默认启用和 `encoding: auto` 规则不变；显式 `off`、`gzip`、`br` 与 `on` 的行为不变。没有读取或修改用户 profile，也未安装或重启 DSH。

## 迁移与验证

旧版 B1 helper 仅在函数体与 0.7.2 已知版本逐字一致时自动迁移；其它 helper 偏差仍失败，避免把不匹配的构建静默改写。迁移测试确认已知 helper 可更新，重复运行后文件字节不变。

- `node scripts/install.mjs --build`：候选包构建成功，所有生成物位于仓库内。
- `node scripts/check-all.mjs --offline`：15 个检查入口全部通过。出站编码检查 47 项、116 次 localhost 请求；对象头、`Headers`、tuple 三种形态在全局 gzip 下均覆盖缺失、空值和未知指令。mock E2E 26 项通过、跳过 0，HTTP 65 次、WS 5 次。
- 构建也验证现有 `gzip`、`br`、`off`、`on` 路径、压缩阈值、重复发送和回执行为；wrapper 检查覆盖 I4 两个中转主机的 `auto` 默认规则与显式配置保留。
- 本轮没有运行 host integration、真实 DSH、真实模型或外部网关检查；测试中的网关仅为 localhost mock。没有安装或重启用户 profile。

`origin` 已有 `v0.7.2` 标签，指向修复前基线 `55de884`，不能覆盖该标签。用户确认按 `v0.7.3` 发布；`node scripts/release.mjs 0.7.3` 已准备候选并再次通过全部 15 个离线检查入口。

功能提交 `39a73c0` 的首次 GitHub 检查中，macOS Node 24 的 wrapper 检查因子进程 localhost `fetch` 报 `TypeError: fetch failed` 失败，日志没有保留底层连接原因。按同一提交重跑后，macOS Node 24、Ubuntu Node 22/24、Windows Node 24 四个 job 全部通过（run `44693848583`，attempt 2）；没有为该次失败改动代码。版本候选提交的跨平台检查仍待完成，本审计不将其写成已发布状态。
