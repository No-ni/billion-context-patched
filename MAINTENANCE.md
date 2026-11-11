# 当前差异与上游升级指南

本文是当前实现的维护入口，按 0.6.4 的代码核对。`PATCHES.md` 保存实现细节、历史故障和测量结果；发生冲突时先核查代码，再同步两份文档，不能把历史叙述当成当前保证。

[SPEC.md](SPEC.md) 规定必须保留的行为，本页记录当前实现与验证覆盖。发现代码偏离规范时登记并修复，不能仅通过修改说明把回归变成新默认。每次合并前后按 SPEC 第 7 节核对 PCK-01–PCK-05 和本页全部稳定 ID，并保存核对结果；不仅在上游升级时执行。

## 1. 两个来源分别锁定

| 来源 | 当前版本 / 提交 | 本仓库的关系 |
| --- | --- | --- |
| [billion-context](https://github.com/ranxianglei/billion-context) | 0.1.213，master `406193b202c13248241f25201e1c6bbda747c99b` | 上游源码构建后，对代理 `dist/index.js` 应用 B1–B18；agent、client、层和清单也随该基线复制 |
| [dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator) | 2.3.0，`e8c30af1f2b5cffa6749d032f0f296e17d4e26d0` | 2026-11-09 逐文件比对：当前 vendor 的 package.json 和全部 8 个 lib/*.js 与该提交完全一致；其功能独立维护，包装包仅在生成客户端时改写三个字面量 |

bili 的短提交记在 `vendor/billion-context/dist/build-info.json`。完整提交通过上游提交接口核对；本轮未重新构建该基线做逐字节比对，不将整个二进制声明为已独立验证可复现。版本号相同不代表提交相同，不能只按 0.1.213 判断是否需要升级。

## 2. 必须逐项核对的差异

### bili 构建：B1–B18 对应补丁脚本步骤

| ID | 当前行为与边界 | 维护位置 | 验证 |
| --- | --- | --- | --- |
| B1 | 折叠后的模型请求体 gzip/br；消费 x-accel-compress、x-accel-rid；重复调用保留决定，不二次压缩；fetch 计算 content-length；300 条回执环与 encode-stats 接口 | `patches/outbound-encoding.block.js`；脚本步骤 1 | `smoke.mjs` 验证三种传输和重复调用；回执接口需真机检查 |
| B2 | 插件道允许服务端快照渲染，仍受快照 live/shadow 开关控制 | 步骤 2，`__biliPluginLaneSnapshot` | 标记/环境开关需真机检查；不是默认无条件启用 |
| B3 | fork 自己没有统一消息行时借父会话记录；不是永久跟随父会话 | 步骤 3，`__biliForkTranscriptSource` | 首轮/已有子记录两种情况需真机检查 |
| B4 | fork 首次成功时复用父画面并记录子 pin；只追加最多 8 条，首条不能是 tool | 步骤 4；最终函数体由步骤 10 提供 | `check-views.mjs` 检查前缀拒绝、子 pin 与只成功一次 |
| B5 | 标记文件开启才落盘出站请求体；默认关闭 | 步骤 5，`__biliDumpBody` | 默认关、开启后写盘需人工验证；不在自动检查中 |
| B6 | 盖 prompt_cache_key 时，fork 沿进程内血缘链选父亲实际使用的 key；最多 512 条，重启清空 | 步骤 6，`__biliForkPck` | `check-views.mjs` 检查多层继承与上限；路由是否盖 key 另受配置控制 |
| B7 | fork 只拷继承前缀的时间戳；之后新消息用自身时间 | 步骤 7，`__biliCopyTsStamps` | `check-views.mjs` 检查前缀范围与独立副本 |
| B8 | 存储降级时，插件道尝试复用本会话 pin 加尾部；无 pin、前缀变动或尾部不合格就拒绝复用 | 步骤 8；最终函数体由步骤 10 提供 | `check-views.mjs` |
| B9 | 只有最后一个 active 块零行且前面有块已锚住时，才允许暂时跳过；还必须通过 B10 | 步骤 9，`loadTranscriptBase` | `check-views.mjs` 检查最新/老块/单块缺失 |
| B10 | SHA-256 校验完整客户端前缀；旧画面所有摘要块仍 active；跳过块全部消息必须在实际追加尾部；复用时补 tailStart | `patches/view-safety.block.js`；步骤 10 同时修改普通与 WS/增量拼接点 | `check-views.mjs` 检查历史编辑、长文本编辑、失效摘要、拼接点前遗漏、部分覆盖、两种请求路径 |
| B11 | prompt_cache_key 路由默认 enabled；显式 disabled/auto/enabled 原样保留，环境变量优先级不变；设置页缺省选项及中英文默认文案同步 | 步骤 11，parsePromptCacheRouting | check-views.mjs 提取真实解析与生效函数检查缺省、无效值及三档显式设置 |
| B12 | 图片在首次成功发送后折叠成一行占位说明（尺寸、ref、已看过提示、可选的 acp_read_original_image 取回方式）；四协议全覆盖，含 tool_result 与原图回执图 | `patches/image-retention.block.js`；步骤 12、14 | `check-image-retention.mjs` 检查四种请求形状与关机行为 |
| B13 | 首次上送按需压缩：长边 > imageRetentionMaxDim（默认 1200）或 > 100 KB 时，按平台顺序借宿主编码器（macOS `/usr/bin/sips`、Windows PowerShell `System.Drawing`、其它 ImageMagick）试 JPEG(q80) 与 PNG 取小，且 ≤ 原图 × 0.8 才采纳；一个都没有则静默跳过 | 同一个块的 `biliRetentionShrinkOne`、`biliRetentionBackends`；步骤 12 | `check-image-retention.mjs` 核对三平台命令行并用自造 PNG 真跑本机后端 |
| B14 | 两个压缩提示构建器的返回尾部追加恒定图像约定；覆盖四协议与两种 strategy，不受 `applySectionOverrides` 影响 | `patches/image-convention.block.js`；步骤 13 的两处 seam | `check-image-retention.mjs` 检查文本开头、关键词、稳定性与关闭 |
| B15 | 折叠记账挂在 `noteSuccessfulForward`：只有上游真正接收后才算看过，失败请求下一轮仍发原图 | 步骤 15 | `check-image-retention.mjs` 检查首次不折叠、记账后再见折叠 |
| B16 | 新增顶层配置键（imageRetention / imageRetentionKeepLastUser / imageRetentionMaxDim / imagePrompt / imageRescaleMaxDim）登记，避免启动未知键警告 | 步骤 16 | `check-image-retention.mjs` 结构检查 |
| B17 | bili Web UI「配置」页里的「图像」卡：四个控件只编辑配置草稿，保存走页面原有的 `PUT /__bili/config`；边长不小于 128，恢复默认只删四个键；中英词条在 `translate` 之前注入 bundle 级 `MESSAGES` | `patches/image-card.{markup,script,listeners}.block.js`；步骤 17，哨兵区间可整段替换 | `check-image-card.mjs` 检查标记、词条、调用点、内联脚本解析与假 DOM 行为 |
| B18 | 压缩增长阈值缺省 80000：内核 `defaultConfig` 的 floor/cap、Web UI 快速配置默认值、中英文提示文案同步；只给没写 `compress.nudgeGrowthTokens` 的配置定值 | `scripts/patch-bili-build.mjs` 第 18 节；`check-views.mjs` 的新值断言 | `check-views.mjs` 检查 `growthFloor:8e4`、`NUDGE_DEFAULT = 80000`、中英提示 80000 在，旧的 5e4 与 50000 不在 |

依赖：B4 依赖 B2/B3，B8 依赖 pin，B10 升级 B4/B8/B9 的行为。pin 表最多 8 条，不落盘；重启首轮无 pin。检查提取真实构建函数，用模拟存储运行，不能替代真实 DSH 的存储/投影集成测试。

### 包装包：W1–W7

| ID | 保留的能力 | 维护位置与验证 |
| --- | --- | --- |
| W1 | 一张插件卡挂 bili、compaction gate、accelerator 三个子插件；显式导出 Config，传递活访问器时不二次解析 schema | `lib/index.js`、`lib/upstream.js`；需真机检查设置即时生效 |
| W2 | 合并两个客户端工厂，inject 取并集；改加速器的设置命名空间、版本路由和提示文案 | `lib/client.template.js`、安装脚本 extractFactory/rewriteOnce；前两字面量恰好一次，否则失败 |
| W3 | 重写组合层只留包装包 insert，保留上游 compaction-basic、四个 preset 的闸门注入、两项 DeepSeek retryPolicy | `dsh.bundle.patch.yml` 由 vendor 层生成；升级要人工比对层，避免替换 inject/config 时丢新字段 |
| W4 | 抑制重复的上游条目：组合层静态 disabled 行在层合成期关掉排在包装包前面的上游，`loader/entry-init` 的 guard 改写 `entry.update` 关掉排在后面的上游，启动扫描与 `_initTask` 等待仅作兜底；销毁时取消排队启动 | `dsh.bundle.patch.yml`、`lib/merge.js`、`lib/index.js`；`check-wrapper.mjs` 覆盖 guard、挂载后 dispose 与取消启动，重复条目与热重载需真机验证 |
| W5 | fork 经 AsyncLocalStorage 给 seeded create 补 parentSession，尊重已有父字段；销毁时恢复服务 | `lib/fork-lineage.js`；`check-wrapper.mjs` 检查并发隔离、普通创建和恢复 |
| W6 | 包装包自己的版本检查和更新接口；串行共享更新；checkout 安装用 git pull --ff-only + installer；无 patchRepo 提示走插件管理器 | `lib/index.js`；与客户端 W2 配对；版本提示、更新成功/失败需人工验证，四项自动检查不覆盖接口 |
| W7 | （补丁 B17）bili Web UI「配置」页里的「图像」卡：四个控件（折叠总开关、上传豁免、首传最长边、图像约定）只编辑页面上的配置草稿，保存沿用页面原有的 `PUT /__bili/config`；边长只收不小于 128 的整数，非法就地提示并回填；恢复默认只删四个键；中英词条随补丁注入 bundle 级 `MESSAGES`，位置必须在 `translate` 定义之前 | `patches/image-card.{markup,script,listeners}.block.js`、`scripts/patch-bili-build.mjs` 第 17 节、`scripts/install.mjs`；`check-image-card.mjs` 覆盖结构、内联脚本解析与假 DOM 行为，真实浏览器里的保存与重启后显示需人工确认 |

### 安装与运维：I1–I5

| ID | 保留的能力 | 维护位置与验证 |
| --- | --- | --- |
| I1 | 自带 vendor 优先于 profile 旧副本；显式外部来源必须是补丁构建；支持 --build/--out、--profile | `scripts/install.mjs`；检查来源清单/agent/client/dist 必须同基线 |
| I2 | 临时副本先打补丁，做视图与压缩检查后替换 dist；文本工厂先解析；退出清理临时目录 | installer；`check-wrapper.mjs` 检查不兼容补丁不覆盖；不宣称整个多文件安装具备事务原子性 |
| I3 | dependencies/bundles 合并为包装包，保留其他插件；配置改寻址、旧 !!js 跟随行迁移；已有 disabled/config 保留；备份保留最近 3 份。管理器安装不跑脚本，包装包首次启动时自行从 `dsh.profile.bundles` 移除两个上游、保留 `dependencies`，幂等 | installer、`lib/merge.js`；`check-wrapper.mjs` 覆盖重装幂等、禁用与渠道配置保留、首次启动合并，旧配置迁移仍需审阅 |
| I4 | 两个指定中转主机的渠道仅补缺失 enabled/encoding，不覆盖用户值；管理器安装由包装包首次启动补齐缺失键 | installer 的 COMPRESS_HOSTS、`lib/index.js` 的 `seedCompressionDefaults`；这是包装包默认规则，不是 bili 原生默认，也不是所有渠道都开；首次启动补齐需真机验证 |
| I5 | 发现实际端口；核对替换 instanceId；一次性探针；备用 vendor 路径；精确收尾自建失败进程，保留服务报告 PID/端口 | `scripts/restart.mjs`；`check-restart.mjs` 只自动覆盖端口发现/实例替换；自建启动、看护与清理需真机验证 |

### 已失效描述与本地配置

- **默认开启 prompt_cache_key 已恢复（0.5.4，B11）**：这是本分支要求。旧提交 `537d590` 的手改默认值在 `f2b9fd6`（0.5.0）刷新源码基线时意外丢失；现已纳入重打脚本和回归检查。B6 决定盖章时使用哪个 key，B11 决定未显式配置时启用路由；用户显式三档选择仍保留。
- **配置页图像卡（0.6.4，B17）**：卡片属于当前实现，配置键和代理行为不受它影响；若要整张卡去掉，删除三个 `patches/image-card.*.block.js`、`scripts/patch-bili-build.mjs` 的第 17 节、`scripts/install.mjs` 里 `check-image-card.mjs` 那一行，再从干净构建重打补丁即可。四个配置键仍可手改文件或走环境变量。
- **折叠步长默认 80k（0.6.4，B18）**：`compress.nudgeGrowthTokens` 的缺省是 80000——内核 `defaultConfig` 的 floor/cap、配置页常量与中英文提示同步；用户明确要求对齐本机配置。显式配置优先，页面上删掉该键即回落 80000。回滚：删掉 `scripts/patch-bili-build.mjs` 第 18 节与 `scripts/check-views.mjs` 的默认值断言，从干净构建重打。
- **图片折叠与压缩默认开启（0.6.0，B12–B15）**：`imageRetention` 关掉折叠与压缩、`imageRetentionKeepLastUser` 关掉上传豁免、`imagePrompt` 关掉约定，环境变量 `BILI_IMAGE_RETENTION` / `BILI_IMAGE_PROMPT` 优先。三条都是改配置即可回滚，不需要重打补丁。压缩只借宿主自带的编码器（macOS `sips`、Windows PowerShell `System.Drawing`、其它平台 ImageMagick），0.6.0 只覆盖 macOS，0.6.1 起三平台。上游 jimp 降采样链因依赖未安装而从未生效；不要为了恢复上游行为去改 `IMAGE_RESCALE_DEFAULT_MAX_DIM`，那个常量当前没有效果。
- **不能称整个插件禁止 HTTP/2**：当前加速器保留按渠道启用 HTTP/2 的能力；它的 transport 与来源提交一致。bili 转发仍用当前上游的 fetch/transport 路径；十八组补丁里没有独立的 HTTP/2 禁用补丁。不要把旧描述当成重打要求。
- 标记文件、rollout、代理、模型窗口和用户设置属于运行环境，不随 Git 安装自动复制。历史 99% 缓存命中、首轮耗时是特定配置下的测量，不能作为所有网关的发布通过阈值。

## 3. 上游升级操作

1. 确认工作区状态，选定两个上游各自的完整提交。新源码在独立目录处理，不能直接覆盖唯一的 vendor 构建。先查看旧/新上游差异。
2. bili 在选定源码提交运行上游自己的 `npm ci`、`npm run build`。记录 commit、Node/npm 版本和构建命令；**从源码构建是当前流程，不是禁用方案**。
3. 在新构建运行 `node scripts/patch-bili-build.mjs <新目录>/dist/index.js`。逐项看 B1–B18；任何 skipped、缺锚点或行为变化都须判明。尤其步骤 6/7 当前缺锚点只打印 skipped，不会强制失败；后续视图检查会使用其函数，但不能只依赖脚本退出码。
4. 若上游已提供等价功能，记录哪个上游提交替代哪个 ID，调整补丁与检查后再移除重复实现。不要在未比较输入、配置和降级边界前直接删补丁。
5. 需要升级加速器时，显式指定 `--accelerator <选定提交目录>`；省略该选项可能沿用 profile/旧 vendor，不代表自动升级。它的压缩、预传输、HTTP/2、计时和账本功能来自第二个仓库，不要误归为 bili 的差异。
6. 构建仓库产物（在本仓库运行，示例目录替换成实际路径）：

   ```sh
   node scripts/install.mjs --build --bili /path/to/new-bili --accelerator /path/to/accelerator
   ```

   核对 B1–B18、W1–W7、I1–I5；更新本页来源和当前结论、PATCHES 对应细节。修改客户端模板/安装合并逻辑后也要重建 `lib/client.js`、`lib/upstream.js` 和根组合层。
7. 自动验证最终 vendor 构建，而不只验证输入来源：

   ```sh
   node --check vendor/billion-context/dist/index.js
   node scripts/check-views.mjs
   node scripts/check-wrapper.mjs
   node scripts/check-restart.mjs
   node scripts/smoke.mjs
   git diff --check
   ```

   `check-wrapper` 在临时 profile 运行真实 installer；`check-restart`/smoke 只开本地模拟服务。它们不调用真实模型。外部候选可先用 `check-views.mjs <dist>`、`smoke.mjs <dist>`。再次打补丁比较文件哈希，确认幂等。
8. 审阅新增/删除的文件和生成物，不能只看 GitHub 隐藏的二进制 diff。bili 清单、build-info、agent、client、层与 dist 必须来自同一源码基线；当前没有全自动验证这一点。
9. 真机验证才安装到本地：`node scripts/install.mjs`，`node scripts/restart.mjs`。包装包宿主/客户端改动还需重载插件或重启 DSH，代理重启本身不重载宿主代码。检查普通续聊、fork 首轮/后续轮、重启首轮、修改历史、开关即时生效、禁用/重新启用、重复上游条目、压缩回执和按来源支持的缓存命中。
10. 记录已做与未做的验证；运行行为变化升三段版本号，防止 W6 检查不到更新。提交完整产物；发布前核对远端提交与本地一致。清理本次临时资源，说明有意保留的服务。

## 4. 修改文件时的来源规则

| 内容 | 应修改哪里 | 后续动作 |
| --- | --- | --- |
| bili 代理差异 | 补丁脚本与 patches/*.block.js | 从干净上游重打或写旧版迁移，再检查最终 dist；只改块文件不会更新已有带标记的 dist |
| 包装包宿主/分支血缘 | lib/index.js、lib/fork-lineage.js | 相关检查；装机后宿主重载 |
| 合并客户端 | lib/client.template.js、installer 的重写逻辑 | --build；不要只手改 lib/client.js |
| 组合层 | vendor 的选定上游层 + installer 生成规则 | --build；检查 inject/config 替换语义 |
| 加速器自身功能 | 第二个来源仓库，选定提交再复制 | 记录新完整提交；运行其自身检查及本包装包检查 |

已有标记只表明补丁曾插入过，**不证明当前块文件与 dist 一致**；`patch-bili-build` 也不是通用反向补丁工具。不能在旧 dist 上改完源块，再跑一次看到 already patched 就发布。
