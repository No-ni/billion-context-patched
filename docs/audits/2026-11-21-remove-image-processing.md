# 删除自加图片处理（0.7.5）

日期：2026-11-21
范围：`bili-context-patch` 0.7.4 → 0.7.5
用户指令：删除本插件自行添加的全部图片处理功能，只保留 DSH 原生图片预算参数注入。

## 结论

B12–B15、B17 的图像行为以及 IMG-01–IMG-09、IMG-11 已删除；B16 收窄为五项 DSH 原生预算键登记，B17 收窄为五项数字的配置卡；IMG-10/IMG-10a 保留。上游 `imageRescale` 链路未改，不安装 jimp，也不改上游常量。没有安装或重启用户插件，没有提交、推送或发布。

## 来源与重建

- 固定上游：`548e396022b9391e28a3c9061560be297779b8e8`（billion-context 0.1.216，kernel 0.0.198）。
- npm 上的 0.1.216 包由 `6a641f378` 构建，与固定提交不一致，不能作为基线；本轮从该提交的 GitHub 源码构建干净 `dist`，再用 0.7.5 补丁器重打。
- 干净基线先验证为 `dist/index.js` 6,338,411 B、md5 `2f0d41284ac91738b85cfcf088ab22c7`；打补丁后 `dist/index.js` 6,379,314 B、md5 `9563fd2e143cab77a0050127fcd26dcf`，`dist/agent/dsh-native.js` 2,512,799 B、md5 `654f3658c908addd55bfe6fc657cc373`，均通过 `node --check`。
- `dist/build-info.json` 保持 `{"commit":"548e396"}`；重新运行补丁器仍得到相同字节（幂等由 `check-upstream-ux` 的迁移用例和 `check-wrapper` 的构建元数据用例覆盖）。

## 删除内容

- 版本 0.7.4 的 B12：已看过的图片折叠为占位说明、按 ref 取回原图。
- B13：首次上送按 `imageRetentionMaxDim` 调 sips / PowerShell / ImageMagick 压缩。
- B14：在两类压缩提示尾部注入恒定图像约定。
- B15：成功回执、`biliImageReceipt`、工具/JSON 后续发送和透明重放的图片改写。
- B17 的行为开关：折叠总开关、当前回合豁免、长边上限、图像约定；卡片脚本、监听器和词条同步收窄。
- 文件：`patches/image-retention.block.js`、`image-convention.block.js`、`image-egress.block.js`；`scripts/check-image-retention.mjs`、`check-host-image-fallback.mjs`。
- 配置键登记：`imageRetention`、`imageRetentionKeepLastUser`、`imageRetentionMaxDim`、`imagePrompt`、`imageRescaleMaxDim` 不再出现在代理与 native 的 `KNOWN_TOP_LEVEL_KEYS`；旧配置文件里的这些键不再生效，预算卡“恢复默认”会顺手删除。
- 归因/回执辅助：删除 `biliRetention*` 和 aux 图片 egress 路径；保留 B1 的明文请求头所有权修复（retry 与辅助发送重置明文头并重签），它解决的是压缩请求头复用，不是图片处理。

## 保留内容

- B16 只登记 `maxRequestImages`、`imageOffloadCountQuantum`、`requestImageMaxBytes`、`requestImagePixelBudget`、`maxRequestImageBytes` 五项；真正未知键仍告警且去重。
- B17 卡片只保留五项预算数字：每图请求目标、单请求总上限、像素预算、最多图片数、每批退役数；保存仍用原 `PUT /__bili/config`，恢复默认写回五项默认值。
- IMG-10 的 DeepSeek API Key / account 路由持久化与 IMG-10a 的 `llm-pi-ai` provider projection 不变；`installImageBudgetDefaults` 与 `lib/defaults.js` 的预算逻辑保留。
- `lib/index.js` 改用 `bili.biliConfigPath` / `bili.readBiliConfig`；`scripts/patch-bili-agent.mjs` 只导出通用读取器，并拒绝仍含 `readBiliImageConfig` 的旧 native 构建，避免把 0.7.4 的宿主恢复逻辑带回来。

## 验证

- `node scripts/install.mjs --build` 成功，重写 `lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml` 和根 `package.json` 的 `patchBuild`。
- `node scripts/check-all.mjs --offline`：13 个脚本全部通过；`check-e2e-mock` 23 项通过、0 跳过、gateway HTTP 43 次 / WS 5 次，临时 SQLite 与 localhost 端口已清理。
- `check-image-card.mjs` 覆盖五项默认、边界、坏配置禁用、保存与恢复默认，并断言折叠/尺寸/约定控件不存在；`check-upstream-ux.mjs` 只接受五项键，旧原生构建被拒绝；`check-image-budget.mjs` 14 项通过。
- `git diff --check` 无空白错误。

## 边界与未完成项

- 未在真实 DSH、真实模型或真实网关中验证；浏览器里的图片卡保存/重载仍需人工确认。
- 用户配置目录里的旧键清理需要写 `~/.config` 的授权，本轮未执行；插件启动后这些键不会生效。
- 调查中提出的 A3–A5 归因规则调整未纳入本轮：现有证据只定位到“失败请求 usage 被当成 ttlRepay / seam 对可疑行告警 / 折叠还款未计量”的症状，失败样本的判定边界和可回归断言尚未形成规范；本轮不凭猜测改上游归因。该事项应作为独立任务，先补可复现样本和预期值，再改补丁。
