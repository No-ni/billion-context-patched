# 维护与接手指南

独立修改及验收要求的唯一清单是 [SPEC.md](SPEC.md)。本文只记录来源、环境、实现与检查映射及维护操作；实现理由和历史见 [PATCHES.md](PATCHES.md)，用户变化见 [CHANGELOG.md](../CHANGELOG.md)，交付步骤见 [RELEASING.md](RELEASING.md)。代码偏离 SPEC 时须修复偏差，不能只改说明。

全部路径和命令相对于本仓库根目录；不依赖外层工作区、旧检出或聊天记录。

## 1. 两个来源分别锁定

| 来源 | 当前版本 / 提交 | 本仓库的关系 |
| --- | --- | --- |
| [billion-context](https://github.com/ranxianglei/billion-context) | 0.1.213，master `406193b202c13248241f25201e1c6bbda747c99b` | 上游源码构建后，对代理 `dist/index.js` 应用 B1–B22；agent、client、层和清单也随该基线复制 |
| [dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator) | 2.3.0，`e8c30af1f2b5cffa6749d032f0f296e17d4e26d0` | 来源未升级；2026-11-12 在 lib/index.js、lib/ledger.js 加本地账本生命周期与依赖寻址补丁，其余文件保留基线。补丁由 scripts/patch-accelerator.mjs 重打，客户端仍只改三个字面量 |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1，ISC | 从 2026-11-11 审计的 DSH settings 随附版本复制 Node runtime，仅清除 Document.js 一处行末空格；CLI 与运行期共用解析器，来源范围见 `vendor/yaml/SOURCE.md` |
| [zod](https://github.com/colinhacks/zod) | 4.4.3，MIT | 原加速器清单里的嵌套依赖不会由根包装包自动安装。自带 Node ESM runtime，账本显式用相对路径导入，管理器与 CLI 均不依赖原版或 profile 残留；范围见 vendor/zod/SOURCE.md |

bili 的短提交记在 `vendor/billion-context/dist/build-info.json`。完整提交通过上游提交接口核对；本轮未重新构建该基线做逐字节比对，不将整个二进制声明为已独立验证可复现。版本号相同不代表提交相同，不能只按 0.1.213 判断是否需要升级。

## 2. 实现与检查映射

行为、默认值和拒绝条件只在 SPEC 维护；下表按稳定 ID 定位实现和验证。B1–B22 的代理改动由 `scripts/patch-bili-build.mjs` 重打，B20 的客户端改动由 `scripts/patch-bili-client.mjs` 在构建时施加。

### bili：B1–B22

| ID | 实现位置 | 检查与覆盖边界 |
| --- | --- | --- |
| B1 | 步骤 1；`patches/outbound-encoding.block.js` | `smoke.mjs` 三路传输与重复调用；回执接口需真机 |
| B2 | 步骤 2；`__biliPluginLaneSnapshot` | 标记与 live/shadow 开关联动需真机 |
| B3 | 步骤 3；`__biliForkTranscriptSource` | fork 首轮与自身记录接管需真机 |
| B4 | 步骤 4，最终函数体由步骤 10 提供 | `check-views.mjs`；B2/B3 联动需真机 |
| B5 | 步骤 5；`__biliDumpBody` | 标记控制的实际写盘需人工验证 |
| B6 | 步骤 6；`__biliForkPck` | `check-views.mjs`；实际盖钥匙与缓存命中需真实网关 |
| B7 | 步骤 7；`__biliCopyTsStamps` | `check-views.mjs`；实际渲染标签需人工 |
| B8 | 步骤 8，最终函数体由步骤 10 提供 | `check-views.mjs`；真实存储降级需集成验证 |
| B9 | 步骤 9；`loadTranscriptBase` | `check-views.mjs` 最新/老块/单块与缺行拒绝 |
| B10 | 步骤 10；`patches/view-safety.block.js` 与两种拼接点 | `check-views.mjs` 前缀、摘要有效性、尾部覆盖及 WS/增量路径 |
| B11 | 步骤 11；`parsePromptCacheRouting` 与设置页 | `check-views.mjs`、`check-wrapper.mjs`；另按 SPEC 的 PCK-01–PCK-05 核对优先级与重打幂等 |
| B12 | 步骤 12、14；`patches/image-retention.block.js` | `check-image-retention.mjs` 四协议与关闭路径 |
| B13 | 步骤 12 的可替换哨兵块 | `check-image-retention.mjs` 块一致性、三平台命令与本机编码器；不可用后端明确 skip |
| B14 | 步骤 13；`patches/image-convention.block.js` 两处 seam | `check-image-retention.mjs` 文本、稳定性与关闭 |
| B15 | 步骤 15；`noteSuccessfulForward` | `check-image-retention.mjs` 成功记账前后 |
| B16 | 步骤 16；`KNOWN_TOP_LEVEL_KEYS` | `check-image-retention.mjs` 配置键登记 |
| B17 | 步骤 17；`patches/image-card.*.block.js` | `check-image-card.mjs` 页面解析与假 DOM；真实保存/重载需浏览器 |
| B18 | 步骤 18；内核默认、页面常量及中英文提示 | `check-views.mjs`、`check-image-card.mjs` |
| B19 | 步骤 19 删除本地熔断；步骤 22 补预检分支 | `check-upstream-ux.mjs`、`check-preflight.mjs`；真实 DSH 退避与上限需集成验证 |
| B20 | `scripts/patch-bili-client.mjs`；installer 合并客户端 | `check-upstream-ux.mjs`；实际 shell 无横幅需人工 |
| B21 | 步骤 21 的中文构造器；步骤 22 的预检/解码分支 | `check-upstream-ux.mjs`、`check-preflight.mjs` HTTP/四协议输出 |
| B22 | 步骤 22；`patches/preflight.block.js`；共用预检入口 | `check-preflight.mjs` 缺行恢复、持续降级、完整性、超时/取消与计数；真实冷加载/切模型未由自动检查证明 |

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
| I1 | installer 的来源选择、自带 vendor/解析器与 build/out/profile | `check-wrapper.mjs`；升级人工核对 manifest/build-info/agent/client/层/dist 同基线 |
| I2 | installer 的临时候选、检查后替换和清理 | `check-wrapper.mjs` 坏候选不覆盖；不宣称整个多文件安装有事务原子性 |
| I3 | `lib/profile.js`、`lib/merge.js` 与 installer | wrapper 检查 CLI 迁移，runtime 检查锁/并发/回滚/重载失败；完整管理器安装需真机 |
| I4 | `lib/defaults.js`、`lib/profile.js` 与 installer | wrapper 检查纯规则/CLI，runtime 检查实际 SettingsForms；真实 br 回执需网关 |
| I5 | `scripts/restart.mjs` 与每个检查的资源清理 | `check-restart.mjs` 动态端口与实例替换；备用启动、看护和实际停机需真机 |

自动检查从最终构建提取函数或加载实际代码，存储、模型、路由等仍有替身。补丁标记和检查通过不能证明真实 DSH 的所有边界已覆盖。加速器保留按渠道使用 HTTP/2；没有全局禁用 HTTP/2 的定制要求。机器上的标记、代理、窗口、日志、配置和历史命中率不作为项目默认值。

## 3. 上游升级操作

1. 按根 [AGENTS.md](../AGENTS.md) 和 SPEC 第 7 节完整读规范，记录工作树、当前来源、候选完整提交与全部稳定条款。选定两个来源各自的版本，不直接覆盖唯一 vendor。
2. 在独立目录检出选定 bili 提交，按其流程执行 `npm ci`、`npm run build`，记录提交、Node/npm 和构建命令。先看上游差异，再对候选运行 `node scripts/patch-bili-build.mjs <新目录>/dist/index.js`。
3. 逐项核对 B1–B22。任何 skipped、缺锚点或行为变化均须判明，尤其步骤 6/7 缺锚点目前只打印 skipped，不能只看退出码。上游等价替代须记录对应提交及输入、配置、降级边界，保留稳定编号。
4. 若升级加速器，显式选定提交并传 `--accelerator <目录>`；省略优先本仓库 vendor，不等于自动升级。不得把来源功能记成本项目新增。
5. 选定来源完整复制后构建候选：

   ```sh
   node scripts/install.mjs --build --bili /path/to/new-bili --accelerator /path/to/accelerator
   node scripts/check-all.mjs --offline
   node scripts/check-all.mjs --host --host-modules /path/to/dsh/node_modules
   git diff --check
   ```

   显式 bili 输入须满足 installer 的兼容补丁/文件检查；不改输入目录。核对清单、build-info、agent、client、层和 dist 属于同一基线。重打后比较最终字节并再次应用验证幂等，检查独立 `--out` 结果与根产物一致。修改模板/组合层规则也须重建。
6. 按全部 B/W/I/PCK 条款记录保留、等价替代、需求变更或偏差。先修复已知偏差，再提交；同步本文来源、实现历史、用户更新记录及审计。发布执行 [RELEASING.md](RELEASING.md)。
7. 安装与真机验证须在任务授权范围内，见 [USAGE.md](USAGE.md)。普通续聊、fork 首轮/后续轮、重启首轮、历史编辑、开关、禁用/重启、重复上游条目、压缩回执和缓存命中不能用自动检查冒充。清理本轮临时资源。

## 4. 修改文件时的来源规则

| 内容 | 修改入口 | 后续动作 |
| --- | --- | --- |
| bili 代理 | `scripts/patch-bili-build.mjs`、`patches/*.block.js` | 重打/迁移后生成最终 dist，不能手改 dist |
| 包装宿主/血缘/配置 | `lib/index.js`、`fork-lineage.js`、`startup.js`、`merge.js`、`profile.js`、`defaults.js`、`version.js` | 构建、offline、相关 host；装机后宿主重载 |
| 合并客户端 | `lib/client.template.js`、installer 的重写规则 | 构建生成 `lib/client.js`，不手改生成物 |
| 组合层 | 选定 vendor 层与 installer 生成规则 | 重建并核对合并语义 |
| 加速器账本兼容 | `scripts/patch-accelerator.mjs`、`patches/accelerator-ledger.*.js` | 保留精确旧片段，不兼容即拒绝；host ledger 检查 |
| 加速器其他能力 | 第二来源仓库选定提交 | 更新来源及全部条款核对 |
| 维护/发布工具 | `scripts/check-*.mjs`、`release.mjs`、`package-release.mjs`、`.github/workflows/` | 验证成功与失败路径，更新维护/发布说明 |

`already patched` 只表示已有标记，不证明块文件与 dist 一致。补丁器不是通用反向补丁工具；不能改源块后看到该输出就直接发布。

## 5. 环境与新电脑接手

需要 Git 和 Node.js（精确支持范围见根 `package.json#engines`）；维护脚本使用 Node 标准库及仓库自带解析器，无需安装根 npm 依赖。GitHub 推送需要相应凭据，查看/发布使用已登录用户自己的 `gh`，CI 使用仓库令牌，不把凭据写进 Git。

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
| `node scripts/check-all.mjs --offline` / `npm run check` | 文档/条款、版本、views、图片、图像卡、UX、preflight、smoke、restart、wrapper | 无用户 profile/真实模型/外网访问；会开本机端口、使用临时目录及系统编码器 |
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
- 所有历史审计从 [文档目录](README.md) 进入；当前分支、标签和 Release 状态以实时查询为准。
