# 维护与接手指南

独立修改及验收要求的唯一清单是 [SPEC.md](SPEC.md)。本文只记录来源、环境、实现与检查映射及维护操作；实现理由和历史见 [PATCHES.md](PATCHES.md)，用户变化见 [CHANGELOG.md](../CHANGELOG.md)，交付步骤见 [RELEASING.md](RELEASING.md)。代码偏离 SPEC 时须修复偏差，不能只改说明。

全部路径和命令相对于本仓库根目录；不依赖外层工作区、旧检出或聊天记录。

## 1. 两个来源分别锁定

| 来源 | 当前版本 / 提交 | 本仓库的关系 |
| --- | --- | --- |
| [billion-context](https://github.com/ranxianglei/billion-context) | manifest 0.1.216，固定主线提交 `8cdad29529b625c7222554a482a65063a8dc525b`，kernel 0.0.208 | 从固定干净源码重新构建，复制插件使用的七个上游产物；对代理 `dist/index.js` 重打 B1–B24 及 WAL 头修复，native agent 修正 WS 权威请求头并同步图片配置键，client 在合并前移除横幅；层和清单随同一基线复制。不是仅采用 v0.1.216 标签 |
| [dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator) | 2.3.0，`e8c30af1f2b5cffa6749d032f0f296e17d4e26d0` | 来源未升级；2026-11-12 在 lib/index.js、lib/ledger.js 加本地账本生命周期与依赖寻址补丁，其余文件保留基线。补丁由 scripts/patch-accelerator.mjs 重打，客户端仍只改三个字面量 |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1，ISC | 从 2026-11-11 审计的 DSH settings 随附版本复制 Node runtime，仅清除 Document.js 一处行末空格；CLI 与运行期共用解析器，来源范围见 `vendor/yaml/SOURCE.md` |
| [zod](https://github.com/colinhacks/zod) | 4.4.3，MIT | 原加速器清单里的嵌套依赖不会由根包装包自动安装。自带 Node ESM runtime，账本显式用相对路径导入，管理器与 CLI 均不依赖原版或 profile 残留；范围见 vendor/zod/SOURCE.md |

bili 的短提交记在 `vendor/billion-context/dist/build-info.json`。本轮从干净固定源码执行 `npm ci` 和 `npm run build`，复制插件使用的七个上游产物；代理/native/client 的差异均通过对应补丁器产生，外部输入不被 installer 改写。当前来源、适配、检查与边界见 [8cdad29 合并审计](audits/2026-11-24-upstream-8cdad29.md)；上一来源证据保留在 [0.7.0 上游整合审计](audits/2026-11-18-upstream-0.7.0.md) 与 [0.6.9 主线整合审计](audits/2026-11-15-upstream-integration.md)。不宣称跨机器二进制完全可复现；相同 manifest 版本可能对应不同主线提交，必须核对完整来源。

## 2. 实现与检查映射

行为、默认值和拒绝条件只在 SPEC 维护；下表按稳定 ID 定位实现和验证。B1–B24 的代理改动由 `scripts/patch-bili-build.mjs` 重打，B20 的客户端改动由 `scripts/patch-bili-client.mjs` 在构建时施加。`scripts/patch-bili-agent.mjs` 在完整 native factory 中修正 B7/W5 所需的 WS 会话身份请求头，并补齐 B16 的五项图片预算键与 IMG-12 的 `imageRestoreHostOffload` 开关登记。

### bili：B1–B24

| ID | 实现位置 | 检查与覆盖边界 |
| --- | --- | --- |
| B1 | 步骤 1；`patches/outbound-encoding.block.js`、明文头投影和重发入口 | `smoke.mjs`、`check-outbound-encoding.mjs` 的真实本地传输、缺失/无效指令默认 off、显式算法、重复编码、请求头所有权、回执与旧 helper 迁移；mock E2E 检查实际代理回执；网关需真机 |
| B2 | 步骤 2；`__biliPluginLaneSnapshot` | 标记与 live/shadow 开关联动需真机 |
| B3 | 步骤 3；`__biliForkTranscriptSource` | `check-e2e-mock.mjs` 的真实代理 fork、保存和重启；DSH 操作仍需真机 |
| B4 | 步骤 4，最终函数体由步骤 10 提供 | `check-views.mjs`；B2/B3 联动需真机 |
| B5 | 步骤 5；`__biliDumpBody` | 标记控制的实际写盘需人工验证 |
| B6 | 步骤 6；`__biliForkPck` | `check-views.mjs`；实际盖钥匙与缓存命中需真实网关 |
| B7 | 步骤 7；`patches/fork-timestamps.block.js`、真实 stamping node、sync/fold clone 与存储字段白名单 | `check-views.mjs` 的多轮裸输入、父高水位、首见、开关、孙 fork、克隆与 JSON/KV 持久化；native 身份用 mock E2E，DSH 页面标签需人工 |
| B8 | 步骤 8，最终函数体由步骤 10 提供；sticky 成功后重新登记 pin | `check-views.mjs` 连续多轮推进、单轮上限及推进后编辑/摘要变化拒绝；真实存储降级需集成验证 |
| B9 | 步骤 9；`loadTranscriptBase` | `check-views.mjs` 最新/老块/单块与缺行拒绝 |
| B10 | 步骤 10；`patches/view-safety.block.js`、两种拼接点与共享 identitySig 的 toolCallId | `check-views.mjs` 的实际签名、连续相同工具结果、完整前缀、摘要生命周期状态指纹、尾部覆盖及 WS/增量路径；mock E2E 执行 retire/restore/rewrite 后实际发送校验 |
| B11 | 步骤 11；`parsePromptCacheRouting` 与设置页 | `check-views.mjs`、`check-wrapper.mjs`；另按 SPEC 的 PCK-01–PCK-05 核对优先级与重打幂等 |
| B12 | 已删除（0.7.5，2026-11-21）：折叠、重复-ref 解析与 `image-egress.block.js` 全部移除 | 不再有 `check-image-retention.mjs`；旧行为不得恢复，历史见 [PATCHES 第 20 节](PATCHES.md#20-图片只发一次与图像约定060-起b12b16) |
| B13 | 已删除（0.7.5）：首次上送本地压缩与三平台编码器调用移除 | 上游 `imageRescale` 保持原样；不再有本地压缩检查 |
| B14 | 已删除（0.7.5）：两处提示 seam 与 `imagePrompt` 移除 | 系统提示不再注入插件约定 |
| B15 | 已删除（0.7.5）：回执、finalize 与工具/JSON 后续发送改写移除；保留 B1 的明文头所有权 | `check-outbound-encoding.mjs` 仍覆盖重试/辅助发送的明文头与重签 |
| B16 | 代理步骤 16 与 `scripts/patch-bili-agent.mjs`；两个构建登记五项预算键与 IMG-12 的 `imageRestoreHostOffload` | `check-upstream-ux.mjs` 执行两端实际告警函数，验证这些键不告警、未知键仍告警且去重；代理/native 旧白名单迁移、幂等与坏锚点拒绝均在 installer 和 wrapper 检查 |
| B17 | 步骤 17；IMG-10/IMG-10a 预算卡与 IMG-12 还原开关；`patches/image-card.*.block.js`、`lib/defaults.js` | `check-image-card.mjs` 页面解析与假 DOM、五项默认值/边界/重置、还原开关默认开启且只记录关闭、重置删除该键，并断言折叠/尺寸/约定控件不存在；`check-image-budget.mjs` 持久化到 API-key/account 与 PI provider 路由、卸载恢复、运行中新增 provider 自动写入、删除 provider 后清理失效备份、备份记录跨重启恢复、settings 已销毁时销毁不抛错不告警；`check-image-restore.mjs` 执行产物里的还原缓存：96 片/64 MiB 每会话/64 会话/256 MiB 全局上限、淘汰顺序与开关默认；真实页面保存/重载需浏览器 |
| B18 | 步骤 18；内核默认、页面常量及中英文提示 | `check-views.mjs` 检查默认值及估算/真实用量的中断提醒处理 |
| B19 | 步骤 19 删除本地熔断；步骤 22 补预检分支 | `check-upstream-ux.mjs`、`check-preflight.mjs`、mock E2E 的反复连接失败与健康重试；真实 DSH 退避与上限需集成验证 |
| B20 | `scripts/patch-bili-client.mjs`；installer 合并客户端 | `check-upstream-ux.mjs`；实际 shell 无横幅需人工 |
| B21 | 步骤 21 的中文构造器、`stream-errors.block.js`；步骤 22 的预检、入口/出站大小限制、辅助请求超窗、WS 本地错误与模型隧道 DNS 拒绝 | `check-upstream-ux.mjs`、`check-preflight.mjs` 执行真实编译 HTTP/四协议/loop/completion/WS sink、reader/decoder/ingest/side guard、完整 WS session/history/upstream 和隧道响应；mock E2E 检查实际 HTTP/WS 拒绝及健康续接；receive socket reset 与 WS prewarm 边界见审计 |
| B22 | 步骤 22；`patches/preflight.block.js`；当前渲染 attempt、四协议 kernel/post-processing guard、共用预检入口及零新增范围的已有块 fit 重建 | `check-preflight.mjs` 的 fresh miss、持续降级、完整性、超时/取消、实际内层 fit、二次校正 probe 的四种结束状态与持久化计数、重建图片预算；mock E2E 一次真实 SQLite 读失败后保存/重渲染、块/原文/ref 保留及 gateway 只发送一次；DSH 冷加载/切模型未由自动检查证明 |
| B23 | 步骤 18 的 nudge transient generation 与 `applyConfiguredCompression` 模型工具包装；只认领调用开始时仍有有效 credit 的提醒，成功/partial 消费该 generation | `check-e2e-mock.mjs` 真实 T1 注入、零 block 与异常重试、partial 成功后拒绝、跨轮锁、跨 generation 并发、新提醒重置及过期提醒隔离；`check-preflight.mjs` 保证自动预检路径不受模型工具 gate 限制 |
| B24 | 步骤 25 在响应侧插入 `[stream-trace]` 三行轨迹（`end()`、`finish`、`close`），正常 debug、未结束关闭 warn | `check-e2e-mock.mjs` 在真实断流与正常结束的响应上读取 `bili.log` 的三行轨迹；只读响应对象、不改写字节、不新增计时器 |

IMG-01–IMG-09、IMG-11 已随 B12–B15/B17 的行为删除（0.7.5）；保留 IMG-10/IMG-10a 的预算注入与卡片，以及 2026-11-22 按用户要求重新放开的 IMG-12（宿主退役占位还原）与 IMG-13（上传超限 413 兜底）。IMG-12/IMG-13 的实现位于 `patches/image-restore.block.js`，由 `scripts/patch-bili-build.mjs` 的步骤 22 插入；mock E2E 覆盖数组与合并字符串两种宿主形态、开关关闭保留占位、413 折叠一次重发（含泛化 `request_too_large` 与中文体积文案）、折叠失败时恢复请求计数与待发送视图，`check-image-restore.mjs` 覆盖还原缓存上限与开关；字符串比较忽略 accelerator 引用差异，只看可见文本与图片结构。旧检查 `check-image-retention.mjs`、`check-host-image-fallback.mjs` 已删除，历史审计仍可读。

### 包装包：W1–W7

| ID | 实现位置 | 检查与覆盖边界 |
| --- | --- | --- |
| W1 | `lib/index.js`、生成的 `lib/upstream.js` | `check-runtime.mjs`；单卡与两组真实设置需 DSH |
| W2 | `lib/client.template.js`、installer 的 extractFactory/rewriteOnce | 构建时工厂解析与唯一锚点检查；真实客户端需 DSH |
| W3 | vendor 上游层与 installer 生成的根组合层 | 构建及 runtime 检查；升级须人工比较 inject/config/preset/retryPolicy |
| W4 | `lib/startup.js`、`lib/merge.js`、组合层与 accelerator 补丁 | `check-wrapper.mjs`、`check-runtime.mjs`、`check-ledger-runtime.mjs`；完整热重载需真机 |
| W5 | `lib/fork-lineage.js` | `check-wrapper.mjs` 并发/恢复、`check-runtime.mjs` 实际服务代理；真实 fork 需 DSH |
| W6 | `lib/index.js`、`lib/version.js` 与 installer 的 patchBuild | `check-wrapper.mjs` 版本判断与幂等；实际更新接口需集成验证 |
| W7 | 与 B17 同一实现，不另建配置接口 | `check-image-card.mjs`；真实浏览器保存与重载需人工 |

### 安装与运维：I1–I5

| ID | 实现位置 | 检查与覆盖边界 |
| --- | --- | --- |
| I1 | installer 的来源选择、自带 vendor/解析器与 build/out/profile；补丁器的 SQLite WAL 头修复与 512 层消息 JSON 深度保护 | `check-wrapper.mjs`；`check-storage.mjs` 的深层消息诊断、真实 WAL/rollback、100 字节有限读取、异常关闭与配置优先级；mock E2E 的默认 SQLite 冷恢复；升级核对七文件同基线 |
| I2 | installer 的临时候选、检查后替换和清理 | `check-wrapper.mjs` 坏候选不覆盖；不宣称整个多文件安装有事务原子性 |
| I3 | `lib/profile.js`、`lib/merge.js` 与 installer | wrapper 检查 CLI 迁移，runtime 检查锁/并发/回滚/重载失败；完整管理器安装需真机 |
| I4 | `lib/defaults.js`、`lib/profile.js` 与 installer | wrapper 检查纯规则/CLI，runtime 检查实际 SettingsForms；真实 br 回执需网关 |
| I5 | `scripts/restart.mjs` 与每个检查的资源清理 | `check-restart.mjs` 动态端口与实例替换；备用启动、看护和实际停机需真机 |

自动检查从最终构建提取函数或加载实际代码，存储、模型、路由等仍有替身。补丁标记和检查通过不能证明真实 DSH 的所有边界已覆盖。加速器保留按渠道使用 HTTP/2；没有全局禁用 HTTP/2 的定制要求。机器上的标记、代理、窗口、日志、配置和历史命中率不作为项目默认值。

## 3. 上游升级操作

1. 按根 [AGENTS.md](../AGENTS.md) 和 SPEC 第 7 节完整读规范，记录工作树、当前来源、候选完整提交与全部稳定条款。选定两个来源各自的版本，不直接覆盖唯一 vendor。
2. 在独立目录检出选定 bili 提交，按其流程执行 `npm ci`、`npm run build`，记录提交、Node/npm 和构建命令。先看上游差异，再对候选运行 `node scripts/patch-bili-build.mjs <新目录>/dist/index.js` 和 `node scripts/patch-bili-agent.mjs <新目录>/dist/agent/dsh-native.js`。保留干净来源以便块修改后重新应用，客户端由 installer 合并时修改。
3. 逐项核对 B1–B24 和 IMG-01–IMG-13（B12–B15、B17 的行为与 IMG-01–IMG-09、IMG-11 已删除，只核对剩余项，含 IMG-12/IMG-13）。任何 skipped、缺锚点或行为变化均须判明，步骤 6/7 现在对不兼容锚点直接失败，B1 检查现有 helper 体是否与源一致；仍不能只看退出码。上游等价替代须记录对应提交及输入、配置、降级边界，保留稳定编号。
4. 若升级加速器，显式选定提交并传 `--accelerator <目录>`；省略优先本仓库 vendor，不等于自动升级。不得把来源功能记成本项目新增。
5. 选定来源完整复制后构建候选：

   ```sh
   node scripts/install.mjs --build --bili /path/to/new-bili --accelerator /path/to/accelerator
   node scripts/check-all.mjs --offline
   node scripts/check-all.mjs --host --host-modules /path/to/dsh/node_modules
   node scripts/check-e2e-mock.mjs --bili /path/to/new-bili
   git diff --check
   ```

   显式 bili 输入须满足 installer 的兼容补丁/文件检查；不改输入目录。核对清单、build-info、agent、client、层和 dist 属于同一基线。重打后比较最终字节并再次应用验证幂等，检查独立 `--out` 结果与根产物一致。修改模板/组合层规则也须重建。

   历史故障回归按 SPEC 第 7 节保留。[连续空工具结果故障](audits/2026-11-15-snapshot-tool-seam.md) 对应 B8/B10/B22，检查入口为 `scripts/check-views.mjs` 和 `scripts/check-preflight.mjs`，均已纳入 `check-all.mjs --offline`。[PR 检查](../.github/workflows/check.yml) 和 [发布工作流](../.github/workflows/release.yml) 在构建后运行同一入口；后续合并须核对这些用例仍覆盖最终产物。

   I1 的 SQLite WAL 头修复及 Node 版本兼容的存储深度保护须保留实际产物回归：`check-storage.mjs` 对最终 dist 执行 6000 层消息诊断，再在有写事务的真实 WAL 数据库、rollback 数据库、大文件、短文件、读失败和不存在文件上执行 WAL helper，限制单次只读 100 字节并核对句柄关闭；配置表及 mock E2E 分别验证默认、显式选择与冷恢复。该检查同时接入 installer 的替换前验收。
6. 按全部 B/W/I/IMG/PCK 条款记录保留、等价替代、需求变更或偏差。先修复已知偏差，再提交；同步本文来源、实现历史、用户更新记录及审计。发布执行 [RELEASING.md](RELEASING.md)。
7. 安装与真机验证须在任务授权范围内，见 [USAGE.md](USAGE.md)。普通续聊、fork 首轮/后续轮、重启首轮、历史编辑、开关、禁用/重启、重复上游条目、压缩回执和缓存命中不能用自动检查冒充。清理本轮临时资源。

## 4. 修改文件时的来源规则

| 内容 | 修改入口 | 后续动作 |
| --- | --- | --- |
| bili 代理 | `scripts/patch-bili-build.mjs`、`patches/*.block.js` | 重打/迁移后生成最终 dist，不能手改 dist |
| bili native agent | `scripts/patch-bili-agent.mjs`、`patches/native-ws-headers.block.js` | 完整 factory 唯一锚点及语法/幂等校验后由 installer 生成；保留 WS init/protocol 形状 |
| 包装宿主/血缘/配置 | `lib/index.js`、`fork-lineage.js`、`startup.js`、`merge.js`、`profile.js`、`defaults.js`、`version.js` | 构建、offline、相关 host；装机后宿主重载 |
| 合并客户端 | `lib/client.template.js`、installer 的重写规则 | 构建生成 `lib/client.js`，不手改生成物 |
| 组合层 | 选定 vendor 层与 installer 生成规则 | 重建并核对合并语义 |
| 加速器账本兼容 | `scripts/patch-accelerator.mjs`、`patches/accelerator-ledger.*.js` | 保留精确旧片段，不兼容即拒绝；host ledger 检查 |
| 加速器其他能力 | 第二来源仓库选定提交 | 更新来源及全部条款核对 |
| 维护/发布工具 | `scripts/check-*.mjs`、`release.mjs`、`package-release.mjs`、`.github/workflows/` | 验证成功与失败路径，更新维护/发布说明 |

`already patched` 只表示已有标记，不证明块文件与 dist 一致。补丁器不是通用反向补丁工具；不能改源块后看到该输出就直接发布。

## 5. 环境与新电脑接手

需要 Git 和 Node.js（精确支持范围见根 `package.json#engines`）；维护脚本使用 Node 标准库及仓库自带解析器，无需安装根 npm 依赖。GitHub 推送需要相应凭据，查看/发布使用已登录用户自己的 `gh`，CI 使用仓库令牌，不把凭据写进 Git。首次提交前在该电脑配置 Git 的 user.name/user.email，可用 GitHub 提供的 noreply 地址；不把特定电脑的账户配置作为项目依赖。

首次接手：

```sh
git clone https://github.com/No-ni/billion-context-patched.git
cd billion-context-patched
# 阅读 AGENTS.md、docs/SPEC.md、本文及相关历史后再修改
git status --short --branch
git remote -v
git log -5 --oneline
git fetch origin --tags
node --version
node scripts/install.mjs --build
node scripts/check-all.mjs --offline
```

可将本目录放在任意工作区；无需 dsh-next 或桌面仓库。普通更新用 `git pull --ff-only`，遇本地分叉先查差异。`main` 随提交即可被插件管理器安装，未准备交付的改动放功能分支；同版构建标识也能触发更新，不能把 main 当草稿区。

### 检查分层

| 入口 | 范围 | 环境要求 |
| --- | --- | --- |
| `node scripts/check-all.mjs --offline` / `npm run check` | 15 个入口：文档/条款、版本、views、图片及宿主退役兜底、图像卡与宿主预算、UX、preflight、storage、smoke、outbound-encoding、restart、wrapper、完整 mock E2E | 无用户 profile/真实模型/外网访问；会开本机端口、临时 SQLite/配置和模拟 HTTP/SSE/WS 网关，并使用系统编码器 |
| `node scripts/check-all.mjs --host --host-modules /path/to/dsh/node_modules` | runtime、ledger-runtime | 真实 DSH 的 Cordis/Loader/Settings/Storage/atomic-write 等模块；Node `registerHooks` 所需版本见 engines；缺模块是未运行或失败，不是通过 |
| 真实 DSH | UI、整机重载、冷加载/切模型、模型/网关与缓存 | 单独授权和记录；不作为离线自动检查的隐含结论 |

macOS 图片编码用 `/usr/bin/sips`；Windows 用 PowerShell `System.Drawing`；其他平台按 PATH 探测 ImageMagick。没有后端可跳过压缩，但有后端而编码失败必须报失败。CI 在 Ubuntu 的 Node 22/24、Windows/macOS 的 Node 24 检查最终构建，源码统一 LF。

host 参数是实际宿主模块目录，也可用 `DSH_HOST_MODULES`。模块打包在 Electron ASAR 时只能按有限依赖范围只读提取到任务临时目录，不能修改应用、启动它或读用户数据库。两个 host 脚本开头说明实际模块和替身边界，不限定操作系统。

### 构建与安装参数

```sh
node scripts/install.mjs --build
node scripts/install.mjs --build --out /path/to/temporary-candidate
node scripts/install.mjs --profile /path/to/dsh/profile
```

前两条只构建候选；第三条实际安装并修改指定 profile，须在任务范围内。省略 `--profile` 时取 `DSH_PROFILE_DIR`，再回落到用户主目录下 `.dsh/profiles/desktop`。`--bili`、`--accelerator` 可显式选来源；`BILI_PKG` 也可覆盖 bili 路径，维护时核对这些变量，防止误用旧来源。独立构建不要把输出放到来源目录内。

代理重启见使用说明；自定义环境可通过 `BILI_PORT`、`BILI_PKG` 和 XDG 路径选择实际实例，不凭默认端口终止其他服务。用户配置、日志、会话库、机器路径和标记不提交到本仓库。

## 6. 故障与交付证据

- [预检超窗审计](audits/2026-11-12-preflight-compression.md)：原分析修正、源码链路和相邻问题。
- [预检修复核对](audits/2026-11-12-preflight-fix.md)：B22 与 B19/B21 的修复和此前本地验证。
- [维护与发布核对](audits/2026-11-12-maintenance-release.md)：文档分工、统一检查、CI 和本轮交付记录。
- [0.6.8 上游吸收审计](audits/2026-11-13-upstream-0.6.8.md)：固定来源、批准取舍、全部稳定条款、模拟 E2E、独立扫描与交付核验。
- [连续空工具结果修复核对](audits/2026-11-15-snapshot-tool-seam.md)：签名误配、sticky 连续推进、零新增范围的预检重建与本地验证边界。
- [0.6.9 主线整合审计](audits/2026-11-15-upstream-integration.md)：固定主线、等价采用与本地保留、存储默认与 WAL 修复、全条款和验证边界。
- [0.6.9 发布复核](audits/2026-11-15-release-0.6.9.md)：独立扫描、二次校正修复、最终产物、本地模拟端到端与发布验收。
- [宿主图片配置误报警修复](audits/2026-11-15-native-image-config.md)：B16 双构建白名单、真实告警行为、旧产物迁移与不发版边界。
- [用量提醒与宿主图片兜底复核](audits/2026-11-18-image-offload-and-nudge.md)：估算用量提醒 bug 根因、宿主真实占位格式、引用恢复边界与候选模拟验证。
- [0.7.0 上游整合审计](audits/2026-11-18-upstream-0.7.0.md)：固定主线、兼容更新、本地定制逐项复核、端到端验证和安装边界。
- [重复图片引用根因与 0.7.1 本机更新](audits/2026-11-19-duplicate-image-ref-retention.md)：重复图片引用导致旧像素回发的证据、本地修复、回归和 DSH 安装记录。
- [同一提醒重复折叠根因与 0.7.2 本机更新](audits/2026-11-19-duplicate-nudge-compression.md)：一次 T1 nudge 后多次独立 fold 的根因、并发/partial 防护、离线验证和 DSH 安装记录。
- 所有历史审计从 [文档目录](README.md) 进入；当前分支、标签和 Release 状态以实时查询为准。
