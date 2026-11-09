# 相对上游的实现细节与历史

当前差异清单、完整来源提交、覆盖范围与升级流程统一见 [MAINTENANCE.md](MAINTENANCE.md)。下文包含历史方案；各节的旧假设和测量不能替代当前实现，第 16、17 节的复用条件以第 18 节为准。

- 上游：<https://github.com/ranxianglei/billion-context>（MIT，Copyright (c) 2026 ranxianglei）
- 本分支基线：上游 `master` 的 `406193b2`（上游版本号仍是 0.1.213，比那次发版多 155 个提交，见第 15 节）
- 我们的改动不是一份 diff：bili 构建上的十一组补丁由 `scripts/patch-bili-build.mjs` 按锚点重打（第 0.2 节），其余改动都在我们自己的文件里（第 0.1 节）

当前维护分为 bili 构建 B1–B11、包装包 W1–W6、安装与运维 I1–I5 三组，见 MAINTENANCE；第 0 节保留实现索引。

## 0. 一页看完（改了什么、下次怎么核对）

这一节只做索引和纪律：相对上游改了什么、每处在哪、合并上游时按什么顺序核对。细节在后面各节。

### 0.1 四层改动

| 层 | 文件 | 改了什么 | 上游升级时怎么重打 |
| --- | --- | --- | --- |
| 包装包（我们自己的代码） | `lib/index.js`、`lib/fork-lineage.js`、`lib/client.template.js`、`package.json` | 一个 Loader 条目里挂 bili、压缩闸门、加速器；把两个客户端 bundle 的工厂体合成一个 `id`；fork 时补父会话血缘；`/api/bili-context-patch/version` 的版本与更新接口；启动时把仍然开着的上游条目关掉 | 与上游无关，不用重打 |
| 组合层 | `dsh.bundle.patch.yml`（生成物） | 只保留自己那条 `insert`，其余是 bili 原有的层：`compaction-basic auto: false`、四个 preset 注入 `biliBasicCompactionPolicy`、`llm-deepseek`/`llm-deepseek-account` 的 retry 策略（含 `MALFORMED_RESPONSE`）；两个上游 insert 行删掉 | `install.mjs` 重跑一次即按新层重新生成 |
| bili 构建产物 | `vendor/billion-context/dist/index.js` | 十一组文本补丁（0.2 的表） | `node scripts/patch-bili-build.mjs`，锚点对不上会报错退出 |
| 安装期 | `scripts/install.mjs`、`scripts/smoke.mjs`、`scripts/restart.mjs` | 取源顺序、构建校验与冒烟、客户端 bundle 合成、profile 改写（dependencies / bundles / 渠道开关）、`--build` 产物生成 | 与上游无关；上游客户端 bundle 封装格式变了会直接报错退出 |

当前仍保留指定中转主机渠道的压缩缺省值规则（仅补缺失键）。`promptCache.routing=enabled` 默认值已在 0.5.4 恢复并纳入第 11 组补丁，见第 7、19 节；显式配置优先。

### 0.2 我们对 bili 构建的十一组补丁

改的都是 `vendor/billion-context/dist/index.js`，由 `scripts/patch-bili-build.mjs` 按顺序重打。多数新插入位置要求唯一命中；步骤 6/7 在缺少锚点时仍可能打印 skipped。必须逐项检查输出并验证最终构建，不能把退出码当成十一项全齐的证明。

| # | 做什么 | 锚点（上游原文） | 开关 / 落点 | 细节 |
| --- | --- | --- | --- | --- |
| 1 | 出站请求体压缩（gzip/br）、`x-accel-compress` 指令、回执环、`GET /__bili/encode-stats` | `async function fetchWithTimeout(`、`checkOutboundBody(opts.body);`、`return sendWebLogs(res,req);` | 整块代码在 `patches/outbound-encoding.block.js`；算法开关 `~/.local/state/billion-context/upstream-encoding` 或配置 | 第 1–4、10 节 |
| 2 | 插件道（dsh 原生全量重发）也走服务端快照渲染 | `if(deps.pluginMode)return clientMsgs;`、`function maybeSnapshotView(session,clientMsgs,deps){` | 标记文件 `~/.config/billion-context/plugin-lane-snapshot.on`，或 `BILI_PLUGIN_SNAPSHOT=1` | 第 13 节 |
| 3 | fork 子会话首轮借用父会话的记录 | `function loadTranscriptBase(session){` … `function assembleView(rows,blockSeeds,coveredSeqUnion,d,tailMsgs){` | 无条件；父记录不可用时退回 `transcript-empty` | 第 14 节 |
| 4 | fork 子会话首轮直接复用父会话上一轮的渲染结果 | `function maybeSnapshotView(session,clientMsgs,deps){`、`if(!live&&!shadow)return clientMsgs;`、`noteRender(session,deps);return r.view}` | 一次有效，成功后置 `session.metadata.__biliForkPinned` | 第 16 节 |
| 5 | 出站请求体落盘（只用于诊断） | `function __biliEncodeOutbound(opts,url){` | 标记文件 `~/.local/state/billion-context/body-dump.on`，目录 `…/body-dump/` | 第 16 节 |
| 6 | fork 子会话沿用父会话的 `prompt_cache_key` | `if(pckDecision==="stamp"){rebuilt.prompt_cache_key=session.id}` | 进程内 `__biliPckChain` 记录每个会话最后盖的钥匙 | 第 16 节 |
| 7 | fork 子会话沿用父会话的消息时刻 | `child.state.nextRunId=parent.state.nextRunId;` | 只在 fork 那一刻抄一次，之后新消息照常打时间 | 第 16 节 |
| 8 | 存储退化时复用本会话上一轮画面 | `legacyFor` | 插件道；0.5.3 增加完整前缀和摘要有效性校验 | 第 17、18 节 |
| 9 | 最新块缺行时保留其原文 | `blockSeqs.size===0` | 0.5.3 要求所有覆盖消息都在实际尾部 | 第 17、18 节 |
| 10 | 完整前缀、摘要有效性和跳过块覆盖校验 | `buildView`、`buildAnchoredView`、pin helpers | `patches/view-safety.block.js`；普通与增量两条路径都检查 | 第 18 节 |
| 11 | 默认开启 prompt_cache_key，保留显式三档设置 | `parsePromptCacheRouting` | 未设置/无效值回落 enabled；精确锚点、幂等检查 | 第 19 节 |

第 4 组依赖第 2、3 组，第 8 组依赖 pin，第 10 组升级第 4、8、9 组并同时检查普通与增量拼接点；按脚本顺序执行，所有步骤支持重复运行。

### 0.3 上游没动的部分

入站解压、折叠与摘要策略、健康检查、其余 `/__bili/*` 接口全部是上游原样（第 6 节）。我们只改了「出站请求体怎么发」「插件道要不要用服务端快照」「fork 首轮借不借父会话的东西」这三类。

### 0.4 试过、明确不用的做法

写在这里是为了不再走一遍。每条都实测过。

| 做法 | 为什么不用 |
| --- | --- |
| 在 profile 的 `cordis.patch.yml` 里写跟随行（`!!js` 按条件禁用） | 依赖条目创建顺序，行会落到还不存在的条目上，日志 `patch: entry "bili-native" not found`，规则空转 |
| 在我们自己的层文件里写 `disabled: true` 压住上游条目 | 层按 `dsh.profile.bundles` 顺序合成，包装包排在原版前面时那几行同样落空（重启后三套一起起来） |
| 靠运行时 `entry.update()` 关原版 | 插件页的卡片和开关是 `dsh.profile.bundles` 的投影，运行时关不掉卡片；只保留作为「用户又把手装回来了」的兜底 |
| 直接安装未打补丁的上游 dist | 会丢本仓库能力；正确流程是先从选定上游源码构建，再重打补丁和检查，见 MAINTENANCE |
| 只打开上游 `snapshotRender` 灰度，不打补丁 | `maybeSnapshotView` 对插件道第一句就 `return clientMsgs`，开关对我们这条路无效（第 13 节） |
| 关掉 `compress.messageTimestamps` 换取 fork 首轮命中 | 已由第 7 组替代，时间戳照常开也能 99%（第 16 节） |
| `setTimeout` 延迟挂载 + dispose 时恢复上游条目 | 整树重建时多余，且会让已注册的 HTTP 路由短暂消失 |

### 0.5 合并上游的检查清单

升级流程统一维护在 [MAINTENANCE.md 第 3 节](MAINTENANCE.md#3-上游升级操作)，包含两个来源、全部检查与真机边界。本节不再复制另一套命令，避免再次出现漏跑视图检查、默认跳过冒烟或把缓存命中率当通用门槛的问题。

## 1. 出口压缩

新增 `__biliHome()`：按 `HOME` → `USERPROFILE` → `os.homedir()` 解析家目录，三个平台一致。

新增 `__biliUpstreamEncoding()`：先读 `~/.local/state/billion-context/upstream-encoding`（内容 `gzip` / `br`，其他值当关闭），读不到再读 `~/.config/billion-context/billion-context.json` 的 `upstream.encoding`；按文件 mtime 缓存。

压缩发生在转发之前，入口是 `fetchWithTimeout`：

```js
async function fetchWithTimeout(url,opts,timeoutMs,externalSignal,forceDirect){
  checkOutboundBody(opts.body);        // 上游原有
  __biliEncodeOutbound(opts,url);      // 本分支新增
  ...
```

`__biliEncodeOutbound` 只在同时满足这些条件时改写请求体：POST、路径属于三个模型端点、请求体 ≥1024 字节、没有现成的 `content-encoding`、压缩后小于原文 95%。命中后改写 `opts.body`，补 `content-encoding`，删除旧 `content-length`；新长度由 fetch 计算（第 10 节）。

- gzip：`zlib.gzipSync(buf,{level:6})`
- br：`zlib.brotliCompressSync(buf,{params:{[BROTLI_PARAM_QUALITY]:4}})`

## 2. 压缩指令头

`__biliTakeCompress(opts)` 取走 `x-accel-compress` 并从头里删除，避免泄漏给上游。

| 取值 | 行为 |
| --- | --- |
| `off` | 不压缩 |
| `gzip` / `br` | 用指定算法 |
| `on` | 用 bili 的全局设置，没设置就用 gzip |
| 缺失 / 其他 | 完全走全局设置（与上游行为一致） |

```js
var dir=__biliTakeCompress(opts);
var enc=dir==="off"?""
       :(dir==="gzip"||dir==="br")?dir
       :dir==="on"?(__biliUpstreamEncoding()||"gzip")
       :__biliUpstreamEncoding();
```

## 3. 回执接口

- `__biliEncRing`：模块级数组，最多 300 条，只收带 `rid` 的记录
- `__biliTakeRid(opts)`：读 `x-accel-rid` 并从头里删除
- `GET /__bili/encode-stats`：返回 `{now, records[]}`；带 `?rid=<id>` 只返回匹配项，不带则返回最近 100 条
- 路由插在 `/__bili` 管理链原有的日志路由之后，不影响既有接口

## 4. 记录字段与日志

```js
__biliEncPush({ rid, ts, url, origBytes, wireBytes, encoding, dir })
```

- `origBytes`：交到传输层时的体积，也就是**折叠后**的大小
- `wireBytes`：压缩后真正发往上游的大小
- `encoding`：`gzip` / `br` / `none`
- `dir`：本次指令原文；空串表示没有指令

每次压缩另写一行 `~/.local/state/billion-context/upstream-encode.log`：

```
2026-11-08T17:41:48.332Z encoded 481153 -> 142851 (br) rid=e79ee3c7-…
```

## 5. 一体化层：一个包挂三样东西（0.2.0 起，0.2.1 加自检）

这一处不在 bili 的 `dist/index.js` 里：源码是仓库根的 `lib/` 与 `package.json`，生成物（`vendor/`、`lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml`）由 `node scripts/install.mjs --build` 写进仓库，安装时整包被复制到 `<profile>/plugins/bili-context-patch`（或由包管理器装进 `node_modules`）。

**为什么需要它**：「设置 → 插件」**一个装好的包一张卡**——卡片列表来自 profile 的 `dependencies`，卡片开关是 `dsh.profile.bundles` 的投影（`readProfilePlugins` 里 `enabled: bundles.includes(name)`）。只要 bili 与加速器各自还是被依赖的包，就必然是两张卡，改标题只能改字面。0.2.0 起 profile 只依赖这一个包，两个上游的**文件被复制**进它的 `vendor/`。

**怎么做的**：

- **源码复制**：`install.mjs` 把 bili 的 `package.json`、`dist/build-info.json`、`dist/agent/{dsh-native,dsh-compaction-gate,dsh-native-client}.js`、`dsh.bundle.patch.yml`，以及加速器的 `package.json` + `lib/*.js` 复制进 `vendor/`（约 9.4 MB）。bili 的 `node_modules`（mysql2、zod）不需要：它的两个主机入口都是打包产物，只 import `node:module`，代理脚本由入口按自身路径找到（`nativeProxyScriptPath` = `dist/index.js`）。这份副本是**派生的**，每次运行重建；打过补丁的构建 `dist/index.js` 单独处理——仓库里已有一份，只有指了 `--bili` 且那份构建确实带补丁时才覆盖。
- `lib/index.js`（主机半侧）——一个条目内 `ctx.plugin()` 依次挂载 bili、压缩闸门、加速器，三者都从生成的 `lib/upstream.js` 引入；那个文件用相对路径 `../vendor/...` 导出三者（`export * as bili from ...`），所以**没有任何裸包名**需要被 profile 解析；
- **设置命名空间**：`@deepseek-ai/dsh-settings` 的 `describe()` 用 `entry.options.id` 当 `ns`，并且只在 `entry.fiber.runtime.Config` 存在时才投影该条目。所以包装包必须 `export const Config = accelerator.Config`，否则条目 id 一变，`模型请求加速` 那一页就没有 schema 可读；
- **配置的活性**：条目的 `.volatile()` 字段不是普通值，而是设置服务原地维护的活访问器（Cordis 的 volatile 更新路径 `volatileEntries(fiber.effectiveConfig)` 只换值、不重启 fiber）。`resolveConfig(runtime, config)` 在 `runtime.Config` 不存在时**原样返回 config**，因此加速器以 `{ ...accelerator, Config: undefined }` 挂载，访问器一路到达它的 `plainConfig()`；二次解析会把访问器冻成快照，渠道开关就不即时了；
- `lib/client.template.js`（浏览器半侧）——安装时把两个包客户端 bundle 的工厂体（`window.__ModuleLoader__.load({id, factory})` 里面的那段）切出来，合进同一个 `id: "bili-context-patch"` 的工厂，两个 half 依次 apply、`inject` 取并集。加速器客户端 `lib/client.js:23` 的 `const NS = "model-request-accelerator"` 会被改写成 `"bili-context-patch"`（它按命名空间找文档、注册分区），原文必须恰好出现一次，否则脚本报错退出；包装清单补上 `dsh.client.inject: ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-ui-settings"]`，客户端模块按它决定到达顺序；
- **组合层**——复制 bili 的 `dsh.bundle.patch.yml`，删掉开头那条 `- insert:`（`bili-native` 与 `bili-compaction-gate` 改由代码挂载），换成本包装包自己的一条 `insert`（被列进 `dsh.profile.bundles` 的包只提供 patch 层，不会自己变成 Loader 条目），`compaction-basic.auto:false`、四个 preset 的 `inject: [biliBasicCompactionPolicy]`、`llm-deepseek(-account)` 的 retryPolicy 全部保留。

**上游两个包怎么不见的**：不是被关掉，是**不再被装**。安装脚本从 `dependencies` 删掉 `billion-context` 与 `dsh-plugin-model-request-accelerator` 两行（它们不再是运行时依赖），`dsh.profile.bundles` 里同样只留包装包。没有依赖就没有卡片，没有清单项就没有 Loader 条目。

**兜底：每次启动都自检一遍（0.2.1）**。正常安装没有上游条目，这三道只在有人把上游装回来、或清单里还留着旧行时才起作用。

1. **启动扫描**：`apply()` 不就地挂载子插件，而是 `queueMicrotask` 一帧之后再干活——先遍历 `ctx.get("loader").store.include.subtree.store`，把仍开着的 `bili-native` / `bili-compaction-gate` / `model-request-accelerator` 用 `entry.update({ ...entry.options, disabled: true })` 关掉，再 `ctx.plugin()` 挂三个子插件。为什么必须晚一帧：条目按 `dsh.profile.bundles` 顺序创建，**上游排在包装包之后**时（把上游重新装回来，新行追加在末尾），同步扫描根本看不到它，等它启动就已经抢走同一批服务与路由。一帧足够——loader 整棵树是一口气建完的；再晚就会让等 `biliBasicCompactionPolicy` 的四个 preset 在启动摘要里报 pending。
2. **运行期跟踪**：`ctx.on("loader/entry-init", …)` 跟着 loader 每建一个条目的事件走，在微任务里把上游条目重新关掉。插件页把那张卡点开时条目是立刻创建的，不必等重启。（该事件在条目的构造期发出，此时 `options` 还没写入，所以处理函数必须延迟到微任务里再读 `entry.options.id`。）
3. **只在内存里改**：`entry.update` 不落盘（落盘只发生在 `EntryTree.create/remove` 调 `commit` 的时候），关掉的是运行中的条目，profile 里用户写的一个字都没动。

顺序仍然必须在挂载之前：两边注册同一批服务和 HTTP 路由，晚一步关会把已注册的接口一起带走——实测 `/api/model-request-accelerator/version` 变 404。

验证（`/tmp` 里的 profile 副本 + 真机启动，两个方向都跑过）：① 上游三行排在包装包**之后** → 日志三条 `switching off the standalone …`，只下发一个客户端包，`/api/bili-context-patch/version` 与 `/api/model-request-accelerator/version` 都正常，无重复域、无 `patch: entry … not found`；② 正常安装（上游不在清单里）→ 一条 `switching off` 都没有，启动摘要只剩与本改动无关的缺包提示。

**profile 侧的改写**（由脚本完成、幂等、带 `.bak-<时间戳>` 备份）：

1. `dependencies`：只留 `bili-context-patch`（`link:` 到 `plugins/`），两个上游那两行删掉（0.2.0 起）；其余依赖一律不动。
2. `dsh.profile.bundles`：只留包装包，且排在**最后**——条目配置按清单顺序合成，包装包的层若排在别的条目之前，它写的行只能落到还不存在的条目上，日志打印 `patch: entry ... not found`，规则空转。
3. `cordis.patch.yml` 里按 id 定位的渠道配置改成 `- id: bili-context-patch`——只改**带 `config:`** 的那一行。早先的实现按"第一行同 id"改名，会连别行的钉子一起改名，结果把包装包自己写成 `disabled: true`。
4. 清掉更早版本写进 profile 的 `!!js` 跟随行（三个 id）。那套做法依赖条目创建顺序，已废弃。

**代价**：`vendor/` 是最后一次重建时的那一版上游，上游发新版不会自动进来。要跟上就按 README「维护：上游发新版」重做一次补丁，再 `node scripts/install.mjs --build --bili <新的 billion-context 目录>`，然后提交。
## 6. 没有改动的部分

- 入站解压（客户端发来的 gzip / br / zstd）仍用上游实现
- 折叠策略、健康检查、其他 `/__bili/*` 接口均未改动
- 除了 `vendor/` 里那两个上游副本，仓库不保存别的上游代码；仓库根本身就是成品，安装时整包复制进 profile（包管理器安装则拷进 `node_modules`）
- 本包只复制 installer 的 BILI_FILES 与加速器 package.json/lib 文件；不分发完整上游源码、hermes-plugin 或整套上游文档

## 7. 默认值：历史与当前

- **默认开启缓存钥匙（0.5.4 恢复，B11）**：旧提交 `537d590` 把 `parsePromptCacheRouting` 兜底从 disabled 改成 enabled；`f2b9fd6` 刷新基线时意外漏迁。现已作为第 11 步重打并回归检查。未配置或无效值默认 enabled；显式 disabled 不发、auto 按上游判定、enabled 开启，环境变量优先级不变。第 6 组只决定盖章时选择哪个 key。
- **中转站渠道自动开请求压缩**：`install.mjs` 扫描 profile 的 `cordis.yml` 与 `cordis.patch.yml`，把 `baseURL` 命中 `www.didudidu.asia` 或 `154.219.111.56` 的渠道名挑出来，在包装包条目的 `config.providers.<渠道>` 下仅补缺失的 `enabled: true` 与 `encoding: auto`（优先 brotli，运行时缺 brotli 或上游拒绝时回落 gzip）。匹配用的是**主机名**，渠道改名不影响；渠道换了别的域名要重跑一次脚本。

## 8. 已知限制

- `vendor/billion-context/dist/index.js` 是构建产物，补丁按**文本锚点**落在 0.1.213 上；上游一旦改动这些函数，需要按上面列的位置手工重做
- br 是否被上游网关接受取决于网关版本，这里不做自动降级
- 包装包的浏览器半侧按**工厂体文本**切分上游 bundle：上游如果改了客户端 bundle 的封装格式（不再是 `factory: (require) => {...}`），安装脚本会直接报错退出，不会生成半成品
- 安装脚本会改写 profile 的 `package.json` 与 `cordis.patch.yml`（均保留 `.bak-<时间戳>` 备份）；用 DSH 插件管理器更新 bili 或增删别的插件时它不会自动重做这些，做完需要自己跑一次 `install.mjs`
- 关掉 `bili-context-patch` 会一起带走：条目本身、它挂的三个子插件、以及这一层里注入 preset 的 `biliBasicCompactionPolicy`。三者同生共死，所以 preset 会退回复用 dsh 自带的压缩策略，不会卡在等一个没人提供的服务上（上游 #3662 描述的是闸门与注入分离的情形）。要回到独立插件形态，得先把 `billion-context` / 加速器重新装成依赖（0.2.0 起它们不再是依赖条目，插件页没有那两张卡可点）
- 一体化之后，卸载 `bili-context-patch` 等于同时停掉三项能力；这是「一张卡」的代价，也是它的定义
- 0.2.0 起两个上游只存在于 `plugins/bili-context-patch/vendor/`：`dsh plugin add billion-context` 之后不会自动接上，须按 MAINTENANCE 显式选定来源；默认重跑 `install.mjs` 会优先保留本仓库 vendor，并不会自动采用刚安装的新版

## 9. 检查更新

包装包自带一个更新入口，路径 `/api/bili-context-patch/version`：`GET` 查版本，`POST ?action=update` 执行更新，由 `lib/index.js` 通过 `connection.fetch.register` 注册。

- `GET` 读本机 `plugins/bili-context-patch/package.json` 的 `version`，再读 `https://raw.githubusercontent.com/No-ni/billion-context-patched/main/package.json` 的 `version`；两边都是三位数字才比较，返回 `{ version, latest, updateAvailable }`。
- `POST ?action=update` 在安装时记下的 `patchRepo` 里跑 `git pull --ff-only`，随后用同一个 Node 进程执行 `scripts/install.mjs`（`ELECTRON_RUN_AS_NODE=1`），返回 `{ ok, from, to, output }`。同一时刻只跑一个更新，第二个请求等第一个。

设置页那行「版本 / 检查更新」是加速器自带的 UI。安装脚本在合并客户端 bundle 时改写三个字面量，让它指向本补丁包：

- 设置命名空间：`const NS = "model-request-accelerator";` → `const NS = "bili-context-patch";`
- 版本接口：`const VERSION_PATH = "/api/model-request-accelerator/version";` → `const VERSION_PATH = "/api/bili-context-patch/version";`
- 更新提示：加速器那句“在本插件目录执行 git pull --ff-only” → “拉取补丁仓库并重新生成包装包”

前两个找不到时安装脚本直接报错退出（不然会悄悄退回加速器的旧行为）；第三个找不到只打印一条 warning，因为提示文案不影响功能。

## 10. 压缩请求体的 Content-Length（0.1.1）

**症状**：渠道开了 brotli / gzip 请求体压缩后，对话报 `502 ... UND_ERR_INVALID_ARG`，代理日志里是 `fetch failed <- invalid content-length header`。Node 24（内置 undici 7.16）上必现，同一上游不压缩时正常。

**原因**：`__biliEncodeOutbound` 压缩完自己写了 `h["content-length"] = String(out.length)`。`fetch` 对 Buffer 身体也会补一个，两个值在 Node 24 上被并成 `"5, 5"`，undici 判为非法请求头，请求在到达网络之前就被拒。

**改法**（bili 的 `dist/index.js`，本仓库里是 `vendor/billion-context/dist/index.js`）：

- 删掉那行手动写入，只保留「删掉原请求所有大小写形式的 content-length」，长度交给 `fetch` 按压缩后的 Buffer 计算；
- 顺手修掉冒烟测试暴露的第二个问题：`x-accel-compress` / `x-accel-rid` 在第一跳就被删了，重试时没有指令，会回落到全局默认编码（`~/.local/state/billion-context/upstream-encoding`，这台机器是 `gzip`），于是「明确要求不压缩」的请求重试时反而被压。现在把这两个判断记在请求对象上（`__biliCompress` / `__biliRid`，不可枚举，不参与头部转发），重试沿用第一次的决定。

**安装期冒烟测试**（`scripts/smoke.mjs`）：从候选构建（本仓库里是 `vendor/billion-context/dist/index.js`）切出真实的压缩函数（`var __biliEncZlib=` 到 `async function fetchWithTimeout(`），对本机模拟上游发三路请求，断言：

1. 上游只收到一个 `content-length`，是纯数字，且等于实收字节数；
2. 解压后与原文逐字节一致；不压缩那路不能带 `content-encoding`；
3. 同一请求连调两次不会二次压缩，`content-encoding` 不变；
4. 内部指令头 `x-accel-compress` 不会转发给上游；
5. 文本里不得再出现 `h["content-length"]=String(`。

`install.mjs` 在覆盖 `vendor/billion-context/dist/index.js` 之前跑它，失败就退出、不动已装文件；跑在将要运行代理的那个 Node 上（更新接口走 Electron 的 Node，会带上 `ELECTRON_RUN_AS_NODE=1`）。

**重启脚本**（`scripts/restart.mjs`）：成功不再是「端口上有人答应 health」，而是「答应的那个 `instanceId` 和关停前不同」。旧进程优雅退出期间会继续应答，旧脚本把这段当成重启成功，等旧进程真正退出后服务就没了。

**同一批顺手修的三处**：

- 渠道开关不再被重装覆盖：安装脚本只补缺失的 `enabled` / `encoding` 键，已有的值原样保留——在设置页关掉的渠道，重跑脚本不会又被打开。
- 构建的覆盖挪到合并产物生成之后：上游 bundle 改了封装格式、合并在中途退出时，不会留下「新 dist + 旧包装包」的半成品。
- `scripts/restart.mjs` 的探针改成一次性连接（`agent: false`）：旧版用 keep-alive 轮询 health，自己的连接正是代理 drain 时要等的 live conns，关停被拖长；现在探针不占连接。

## 11. 仓库结构

仓库根就是可分发的插件，没有第二套源码：

- `lib/index.js`、`lib/fork-lineage.js`、`lib/client.template.js`、`package.json` —— 手写的部分
- `vendor/` —— 两个上游的副本，**直接提交**，安装时不再需要网络或先装上游
- `lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml` —— `install.mjs --build` 生成的产物，也提交，装下来即可运行
- `patches/` —— 我们对构建做的改动，`outbound-encoding.block.js` 是第 1–4 节那一整块代码，其余由 `scripts/patch-bili-build.mjs` 按锚点插入

补丁版构建在仓库里只有一份：`vendor/billion-context/dist/index.js`（旧版在仓库根另存过一份 `dist/`，两份内容相同，已合并）。脚本允许用 `--bili <目录>` 从外部更新它，但只接受带 `__biliPluginLaneSnapshot` 或 `__biliEncZlib` 的构建，没打过补丁的 bili 不会顶掉现有构建。

取源顺序（0.4.2 起）：显式 `--bili` → 本包自带的 `vendor/billion-context` → profile 里已装的 billion-context → 上次装进 profile 的 vendor 副本。自带副本排在最前，是因为它自洽（清单、层、agent 文件、补丁构建来自同一个上游版本）；否则在已经装过旧版的机器上再跑一次脚本，会继续沿用 profile 里的旧上游，静默不升级。包管理器安装时前两项是同一个路径，等于没有复制。

## 12. fork 会话记住父会话（0.4.1）

**症状**：在长会话顶部 fork，新会话要等很久才出第一个字，重的时候直接 413。日志依次是：

```
[dsh-client] bili-native-dsh: fork adoption for session-… skipped — the session header
  says isSeeded but carries no usable parentSession; the child starts without inherited
  compression state (#4215)
context 1089686 tokens reached preflight target 284464 (model window 284464 …)
preflight aborted (the client disconnected during preflight compression)
413 preflight_compress_failed: payload core text alone is ~2280574 bytes … ≥ ~304077
  tokens vs the model window 284464; no upstream can accept it
```

**根因**：DSH 的 fork 不写父会话。`@deepseek-ai/dsh-api-session-controller/lib/index.js` 里：

```js
await this.ctx.agents.create({ sessionId: childId, seed, inheritedEventCount: SessionLogOffset(boundary + 1),
  meta: { ...cwd, isSeeded: true, ...agentPreset }, agentOptions: { provider, model }, setup: composition.setup });
```

`meta` 里没有 `parentSession`。字段本身是合法的：`dsh-session` 的 `sessions.prepare` 明确接受
`meta.parentSession`（`...meta?.parentSession === void 0 ? {} : { parentSession: meta.parentSession }`），
`session-query` 的血缘查询也按它算——只是没人填。而 bili 的收养门
（`vendor/billion-context/dist/agent/dsh-native.js`）判的正是这一项：

```js
const parent = session.header.parentSession;
if (session.header.isSeeded !== true) return { ok: false, reason: "not-seeded", sid };
if (typeof parent !== "string" || parent.length === 0) return { ok: false, reason: "parent-missing", sid };
```

所以补这一格就够了，bili 一行都不用改（上游 #5122 / #5738 说的都是这件事，仍在 open）。

**改法**（`lib/fork-lineage.js`，宿主半边，随包装包一起加载）：

1. 包装 `sessionController.fork`：把本次 fork 的父会话 id 放进 `AsyncLocalStorage`，两个 fork 并发也不会串。
2. 包装 `agents.create`：当上述 store 生效、且这次创建是 `meta.isSeeded === true`（fork 自己的子会话）时，往 `meta` 补一个 `parentSession`；其余创建原样透传。
3. 作用域销毁时把两个方法还原，关掉包装包即恢复 DSH 原行为。

包装的是**共享的服务实例**：插件装上去的包装，别的插件通过 `ctx.agents` / `ctx.sessionController` 拿到的就是它，所以会话控制器自己那次 `agents.create` 也能被拦到。

**验证**（沙箱 profile 副本 + 真机启动）：把 live 里一个 1,089,686 token 的会话复制进沙箱，通过网关 RPC 调 `session/fork`，探针日志：

```
FORK intercepted session-199ef92b-23f0-41e3-96d3-582530dc4a78
INJECT parentSession session-199ef92b-… -> session-9b8ba0f2-… isSeeded true
FORK result {"sessionId":"session-9b8ba0f2-b1ae-4619-a41b-cae8c5338781"}
```

子会话落盘的头（zstd 首帧）：

```json
{"type":"session","version":4,"id":"session-9b8ba0f2-…","createdAt":1794209889720,
 "cwd":"/Users/senno/Documents/deepseek-harness/default-workspace",
 "parentSession":"session-199ef92b-23f0-41e3-96d3-582530dc4a78","isSeeded":true,
 "delegationDepth":0,"agentPreset":"ptc"}
```

**边界**：

- 只对 fork 期间、且 `isSeeded: true` 的那一次创建动手；普通新建、subagent、ACP 创建都不带这个字段。
- 子会话不会被当成 subagent：那条路径还要求 `header.origin === "subagent"`，fork 子会话没有 origin。
- 会话查询/遥测里会多一个 `parent_id`，语义是对的（它确实是子会话）；`session-query` 的 parent 过滤只在显式按父会话搜索时用到。
- DSH 改版后若服务名或 fork 实现变了，`ctx.inject` 拿不到服务就不装，行为退回「从零重压」，不会报错、不会阻断启动。


## 13. 插件道也走服务端快照渲染（0.4.3，本地试验开关）

**问题**：dsh 原生这条道是插件道，每轮把整段历史重发（实测 2474 → 2670 条、5.4–5.9 MiB）。billion-context 的插件道按设计「客户端说了算」，于是每轮的出站前缀都重新推导：折叠计划一动，中段就位移，上游缓存从中间开始对不上。fork 会话的头两轮实测命中 10.0% / 11.3%，两轮各重新计费约 19 万 token。

**改法**：上游 `src/server/snapshot-render.ts` 的 `maybeSnapshotView` 第一句是

```ts
if (deps.pluginMode) return clientMsgs; // plugin lane: client-authoritative by design
```

构建产物里这一句（唯一一处）改成先问一个标记文件：

```js
if(deps.pluginMode&&!__biliPluginLaneSnapshot())return clientMsgs;
```

`__biliPluginLaneSnapshot()` 在 `maybeSnapshotView` 前面定义，读：

- `$XDG_CONFIG_HOME/billion-context/plugin-lane-snapshot.on`（默认 `~/.config/billion-context/`）存在即放行；
- 环境变量 `BILI_PLUGIN_SNAPSHOT=1|0` 覆盖文件判断。

**两层开关**：

1. 上面这枚标记文件只决定「这条道**允许**用快照渲染」。
2. 真正改变出站字节的是 billion-context 自己的灰度 `snapshotRender`（`~/.config/billion-context/billion-context.json` 里 `rollout.features.snapshotRender`）。灰度关着时只喂 shadow 观测器，出站字节不变。

**生效后的行为**：出站前缀由服务端统一表渲染，只有尾部追加。同一个 fork 会话实测出站 963 KiB → 328–340 KiB，每轮只长 5 KiB，缓存命中 99.4%（中位数 99.2%）。

**回退**：删掉标记文件并重启 bili 进程，即回到「每轮重新推导」。灰度改回 `false` 则只保留观测。

**重打补丁**：`node scripts/patch-bili-build.mjs [dist/index.js]`（第 2 步），脚本按 `if(deps.pluginMode)return clientMsgs;` 定位、要求唯一命中、已打过就跳过；`install.mjs` 在临时副本中先应用补丁并检查，通过后才替换构建。已有标记不证明新补丁源码与旧构建一致，见 MAINTENANCE。

**边界**：快照渲染有大量降级门（锚点校验失败、尾部接不上、行不可解析都会退回旧路径，退回时出站字节与改动前一致）；服务端对前缀有最终解释权，客户端改写头部（检查点、删除）不再复活被丢的行。



## 14. fork 第一轮就沿用父会话的前缀（0.4.4）

**问题**：fork 出来的会话第一轮仍然是全价。原因不是没做血缘（`#2399` 的 adoption 早就在跑，日志里 `fork child … adopted parent … at branch point 3465`），而是**子会话在第一次保存之前没有任何统一表记录**：`loadTranscriptBase` 读到空表就返回 `transcript-empty`，首轮退回旧路径，整段重新推导、重新计费一次。

**改法**：adoption 时 bili 已经把父会话 id 记在子会话上（`child.metadata.parentConversationId`，`src/plugin.ts:1682`）。构建产物里给 `loadTranscriptBase` 加一个来源解析：

```js
function __biliForkTranscriptSource(session,store){
  try{
    const parent=session&&session.metadata&&session.metadata.parentConversationId;
    if(typeof parent==="string"&&parent.length>0){
      const own=store.unifiedMessageIdRows(session.id);
      if(!own||own.length===0)return parent;
    }
  }catch{}
  return session.id;
}
```

函数体里四处读表（identity rows、tail seqs、uncovered rows、tail view rows）改用解析出来的 id。**只在子会话自己没有记录时**借用父会话；子会话第一轮落盘后就用自己的记录，行为回到常态。

**降级照旧**：父 id 不存在、父记录为空、行不可解析、锚点对不上，全部原样返回 `transcript-empty` / 对应 reason，退回旧路径——与改动前一致。

**验证方法**：新建一个 fork 会话发第一句，看日志首轮是否出现 `[snapshot-render] active`，以及 `[acp-usage]` 的 cached 是否不为 0。

## 15. 基线升到上游 master（0.5.0）

**为什么**：0.4.x 的构建是从官方发布的 0.1.213 成品上手工改出来的，改动以 diff 的形式存在（旧文件 `patches/upstream-0.1.213.diff`，已删）。成品本身没有源码，上游再往前走了 155 个提交就吸收不进来。

**现在**：构建来自上游源码（默认分支是 `master`，不是 `main`），取到的提交 `406193b2`。构建命令就是上游自己的：`npm ci && npm run build`。我们对构建的改动由 `scripts/patch-bili-build.mjs` 按锚点重打，每一组要求锚点在文件里唯一命中，对不上就报错退出：

| 步骤 | 锚点 | 改动 |
| --- | --- | --- |
| 1. 请求体压缩（第 1–4 节） | `async function fetchWithTimeout(`、`checkOutboundBody(opts.body);`、`return sendWebLogs(res,req);` | 插入 `patches/outbound-encoding.block.js` 整块、在转发前调用 `__biliEncodeOutbound`、注册 `GET /__bili/encode-stats` |
| 2. 快照渲染开关（第 13 节） | `if(deps.pluginMode)return clientMsgs;`、`function maybeSnapshotView(session,clientMsgs,deps){` | 改成先问标记文件，再决定是否跳过 |
| 3. fork 首轮借用父会话（第 14 节） | `function loadTranscriptBase(session){` … `function assembleView(` | 插入 `__biliForkTranscriptSource`，函数体内四处读表改写 |
| 4. fork 首轮钉住父会话的渲染结果（第 16 节） | `maybeSnapshotView` 首行、`if(!live&&!shadow)return clientMsgs;`、`noteRender(session,deps);return r.view}` | 插入 `__biliPinViewRecord` / `__biliForkPinView`，首轮直接返回父会话那份视图再接新消息 |
| 5. 请求体落盘（诊断，默认关） | `function __biliEncodeOutbound(opts,url){` | 插入 `__biliDumpBody`，只有标记文件存在时才写盘 |
| 6. fork 沿用父会话的缓存钥匙（第 16 节） | `if(pckDecision==="stamp"){rebuilt.prompt_cache_key=session.id}` | 改成 `__biliForkPck(session)`，沿血缘取父会话实际用的那把钥匙 |
| 7. fork 沿用父会话的消息时刻（第 16 节） | `child.state.nextRunId=parent.state.nextRunId;` | 插入一行：把父会话 `state.tsStamps` 里属于本次前缀的时刻抄给子会话 |
| 8. 取不到统一记录时沿用上一轮画面（第 17 节） | `function legacyFor(session,deps,clientMsgs,reason){`、`session.metadata["snapshotRenderDegradeReason"]=reason;` | 插入 `__biliStickyView`，退化前先试着沿用本会话上一轮的渲染结果 |
| 9. 最新的块还没落行时只丢它自己（第 17 节） | `if(blockSeqs.size===0)return{reason:"block-unanchored"};` | 取不到行的是最新那个块就跳过它（这一轮它的消息按原文发出，其余照旧压缩）；取不到行的是更老的块才继续判定整份视图不可用 |
| 10. 消息完整性校验（第 18 节） | pin helpers、`buildView`、`buildAnchoredView` | 完整前缀哈希、摘要仍有效、跳过块必须完整存在于追加尾部 |
| 11. 默认开启缓存钥匙（第 19 节） | `parsePromptCacheRouting` | 将兜底恢复为 enabled，显式三档不变 |

**吸收进来的上游改动**（用户可感）：

- `#5970`（`4f807020`）fork 时父会话已折叠的段落一起继承：`if (b.expanded || consumed.has(b.blockId)) continue;`
- `#5470`（`cc1e2408`+`ad242bf6`）折叠摘要落在折叠点，原位留指针
- `#5604`（`8c98898e`）出站历史不得以 assistant 结尾
- `#5951`（`2fa4def4`）只被切断推理内容时可以原样重放
- `#5981`（`adc863af`）压缩参数被截断时提示重发
- `#5000`/`#5794`（`d1b2d8fa`）新增 `maxMessages`（默认 0 关闭）、`DEFAULT_INGEST_BODY_BYTES` 32MiB
- `#5955`（`33bec442`）端口卡死强制接管

**上游这几处没动过**：`src/server/snapshot-render.ts` 在这 155 个提交里一行未改，所以第 2 步的锚点仍然成立；第 3 步锚在 `loadTranscriptBase`，上游也没碰。

**复核方法**：`node scripts/smoke.mjs vendor/billion-context/dist/index.js` 打三路请求，断言出站字节被压缩且没有自己写 content-length；`dist/build-info.json` 记录当前构建对应的上游提交。

## 16. fork 第一轮真正复用父会话的缓存（0.5.1）

本节的末条前缀探针是历史实现，0.5.3 已由第 18 节的完整前缀与摘要有效性校验替代；命中率表为当时环境测量。

第 3 组补丁只解决了「有记录可读」，实测 fork 首轮命中仍然只有 1%。逐轮排查下来是三件事叠在一起，缺一件都不成立：

| 现象（fork 首轮命中） | 找到的原因 | 处理 |
| --- | --- | --- |
| 1% | 首轮出站前缀与父会话最后一轮不是同一份字节：这一轮又重算了一遍 | 第 4 组：首轮直接复用父会话上一轮的渲染结果，只追加新消息 |
| 28% → 58% | 请求体带 `prompt_cache_key`，bili 按会话盖章；fork 换了钥匙，上游把前缀分到另一个仓 | 第 6 组：fork 会话沿血缘取父会话**实际用的**那把钥匙（只看一层不够，套娃 fork 会拿错） |
| 58% → 99.3% | 消息标签 `<acp tokens type time>` 里的时间在 fork 时被重打（18:37:52 → 18:37:54），两位数字之差让前缀从这里断开 | 第 7 组：fork 时把父会话的时刻表抄给子会话，标签时间与父会话逐字一致。过渡做法是把 `compress.messageTimestamps` 关掉，现在不需要了 |

**定位方法**（可复用）：第 5 组补丁把出站请求体原样落盘（标记文件 `~/.local/state/billion-context/body-dump.on`，目录 `~/.local/state/billion-context/body-dump/`），把父会话最后一轮与 fork 首轮两份放在一起逐条比对。实测 75 条消息里只有 2 条不同，差异精确落在标签时间上——比读代码猜快得多。诊断完删掉标记文件即停止写盘。

**第 4 组（fork-pin）细节**：`maybeSnapshotView` 在 `live` 时先问 `__biliForkPinView`；命中条件是父会话有 pin、本次客户端消息数不比 pin 短、末条前缀一致、追加不超过 8 条、追加段不以 tool 开头。成功后置 `session.metadata.__biliForkPinned`，后续轮次回到常规路径。日志 `[snapshot-render] fork-pin active parent=… pinned=… appended=…`，不命中时打 `fork-pin skipped: <原因>`。

**第 6 组（缓存钥匙）细节**：`__biliPckChain` 在进程内记录每个会话最后盖章用的钥匙；fork 会话先查父会话的、查不到退回父会话 id，再退回自己的 id。进程重启后链为空，退化为「用父会话 id」这一级。

**第 7 组（消息时刻）细节**：时间由 `stamp-timestamps` 节点写进会话状态 `state.tsStamps`（键是原始消息 id），渲染时直接取这张表。fork 出来的子会话这张表是空的，于是每条继承来的消息按 fork 那一刻重新打点——这就是标签时间差几秒的来源。补丁在 `handlePluginFork` 组装子会话状态的地方加一行，把父会话 `tsStamps` 里属于本次前缀（`prefix` 的 `rawId`）的时刻原样抄过去；fork 之后新产生的消息照常按自己的时间打。

**验证数据**（同一台机器，fork 新会话首轮）：

| 阶段 | 输入 | 命中 | 命中率 |
| --- | --- | --- | --- |
| 只有第 3 组 | 89.4K | 28.3K | 32% |
| ＋第 4 组 | 101.6K | 28.3K | 27.8% |
| ＋第 6 组（钥匙） | 63.7K | 37.0K | 58.1% |
| ＋去掉标签时间（过渡做法） | 88.8K | 88.2K | 99.3%（第二轮 99.6%） |
| ＋第 7 组：沿用父会话时刻，时间戳重新打开 | 78.8K | 78.3K | **99.4%**（第二轮 98.9%、第三轮 99.7%） |

**代价与注意**：改动上线后每个会话的下一轮会冷一次（标签字节变了）；第 7 组只在 fork 那一刻抄一次时刻，之后子会话的新消息照常按自己的时间打，`compress.messageTimestamps` 保持默认（开）。

## 17. 取不到统一记录时，沿用上一轮画面（0.5.2）

历史记录：下文“最新块消息必在尾部”的推断有反例，末条前缀探针也不足以证明历史一致。两者均由第 18 节修正，不能单独恢复本节方案。

**现象**：19:37 有一次请求直接失败——`preflight fail-fast 502 (retryable=false)`，报「上下文约 204 万 token 超过模型窗口 28.4 万，且找不到可压缩的段落」。两秒后宿主自动重试就成功了。

**根因**：那一轮快照渲染退回了旧路径（日志 `[snapshot-render] legacy fallback (block-unanchored)`）——某个生效中的块在统一记录里找不到自己的消息行。退回本身是瞬时的：压缩刚提交这个块，写消息行的 ingest 还没跟上（同一次请求的日志里有 `slow-ingest … path=full`，说明增量快路径退回了整份重写），下一次请求记录就齐了。要命的是插件道上客户端发来的消息**就是整段原始历史**（请求日志为 3442 条 / 7.5 MiB），旧路径把它原样交出，preflight 压不下去，只能按超窗拒绝。

**处理**（第 8 组）：`legacyFor` 在退回旧路径前先问一次 `__biliStickyView`——如果这个会话上一轮渲染过、客户端消息的尾部与那次一致、追加不超过 8 条，就用上一轮的渲染结果接上新消息。结果是：存储短暂不齐时这一轮少压一点（新消息可能还没折进摘要），但请求照常发出，而不是整份原始历史被拒。

**条件与边界**：只在插件道（`deps.pluginMode`）接管；没有上一轮记录、尾部对不上、追加超过 8 条、追加段以 tool 开头时都退回原来的退化路径。日志 `[snapshot-render] sticky view (<原因>): pinned=… appended=…`。

**顺带收紧**：fork-pin 命中后把子会话这一轮的渲染结果也登记成它自己的 pin（从子会话再 fork 的孙会话也能复用，sticky 也立刻可用）；pin 表上限 4 → 8；缓存钥匙链上限 512 条。

**这条兜底的极限**：pin 只存在内存里，代理刚重启时一个都没有，所以「重启后的第一轮又撞上同一种瞬时缺失」时它帮不上忙——同一张错误卡片在 19:46 又被客户端显示了一次，查日志那是 19:37 那次请求的重放，19:45 重启之后没有任何新的 fail-fast。真要堵住这一类，得让缺失本身不致命。

**当时的处理（第 9 组，已由第 10 组补齐条件）**：`loadTranscriptBase` 里块取不到消息行时，原来一律放弃整份视图。现在按块的位置分两种：取不到行的是**最新的那个块**——它的消息正是客户端尾部还没落盘的那几条，这一轮跳过它没有任何内容损失（这些消息随后按原文接在视图尾部），其余块照旧压缩；取不到行的是**更老的块**——照旧放弃，否则那些消息会从视图里静默消失。跳过还额外要求「至少已经有一个块锚住了」，避免整份视图退化成纯原文。日志 `[snapshot-render] newest block <id> is not in the transcript yet, rendered raw this turn`。

两层的关系：第 9 组从源头上让这一轮能正常渲染（哪怕少折一个块），第 8 组是它之外的兜底（视图整体取不回来时才用上一轮画面）。


## 18. 消息完整性与安装、重启修正（0.5.3）

第 17 节「最新块的消息一定在尾部」只是当时的假设，不是代码保证。反例：统一记录是 A、B、C，客户端是 A、B、X、C，最新块覆盖 X。原补丁跳过这个块，拼接点选到 C，结果既没有 X 原文也没有它的摘要，仍返回成功。现在在普通和增量渲染路径上都验证：跳过块的每一条 effectiveMessageId 必须在最终追加的原文尾部，否则返回 `skipped-block-not-in-tail`，走受校验的旧画面兜底或原有拒绝路径。第 9 步仅放宽零行的最新块；单块缺行、更老块缺行仍拒绝。

旧画面与 fork 首轮复用原来只比较末条消息 JSON 的前 200 个字符，历史中较早的编辑或末条长文本后半段的修改都会被忽略。现在对完整客户端前缀逐条计算 SHA-256，复用时重新校验；并要求旧画面的每个摘要占位符仍对应一个 active 块，避免块被重新压缩后复用失效的空占位符。复用成功时补写 `snapshotRenderTailStart`，供出站完整性检查使用。pin 表仍最多 8 条，缓存钥匙链仍最多 512 条。

显式指定未打补丁的上游目录时现在先报错，避免用新 manifest/client 配旧 dist。安装脚本改为先在临时目录打补丁并检查，检查失败不会替换正在安装的 dist；退出时删除临时目录。原来的重新安装逻辑会把带 `disabled:` 的包装包行改成只有 `disabled: false`，连同同一行的 config 一起删掉，现已删除这段逻辑，保留用户显式开关和配置。

包装包延迟启动回调现在在 dispose 后取消，避免插件刚被禁用或重载，排队的旧回调仍挂载三个子插件。

重启脚本从 `proxy-origin` 发现当前端口，替换进程换端口时也跟进；手动起代理的备选路径改为优先使用包装包内的 vendor，避免寻找已经不再安装的独立包。健康检查要求有效实例标识，并处理响应中断。若脚本尝试启动的进程未成为实际替换进程，精确终止该子进程；成功保留时输出 PID、端口和停止方式，并沿用可获得的宿主看护 PID、通道和模型窗口信息。

验证：`check-views.mjs` 检查 15 项渲染、pin、缓存钥匙及 fork 时间戳行为；`check-wrapper.mjs` 验证并发 fork、禁用时取消排队启动、安装幂等、配置保留，以及补丁失败不覆盖正式构建；`check-restart.mjs` 用本地模拟服务验证动态端口发现与实例替换；`smoke.mjs` 验证原文、br、gzip 三路传输。检查不会向真实模型发请求。

边界：这些改动防止静默丢失和错误复用，不能保证所有存储故障都能继续发请求。没有可靠旧画面且无法证明消息覆盖时仍应拒绝。彻底消除块/消息读取不一致，需要上游把块状态、消息行和视图指针作为同一版本提交并读取；这次没有改造上游存储事务。

## 19. 恢复默认开启缓存钥匙（0.5.4）

默认开启 `prompt_cache_key` 是本分支明确需求。`537d590` 曾直接修改旧构建，0.5.0（`f2b9fd6`）改用上游源码构建时没有把它迁入补丁脚本，因此意外回到默认 disabled。0.5.3 文档整理只记录缺失，没有恢复既定需求，这一处理现已纠正。

第 11 步精确修改 `parsePromptCacheRouting` 的兜底为 enabled；缺失或无效值启用，用户显式 disabled/auto/enabled 和环境变量优先级保持不变。脚本验证唯一锚点，无法识别的上游实现直接失败，重复应用不改字节。设置页独立的缺省选项同样改为 enabled，并将中英文的“当前默认”说明移到开启项。B6 的 fork 血缘选 key 与 B11 的默认开关分别记录，避免再次混淆。

`check-views.mjs` 从实际发布构建提取解析及生效函数，验证缺省、无效值与三档设置，并检查设置页缺省选项与默认文案；当前共 17 项检查。安装时也运行此检查，因此缺少 B11 的候选构建无法通过发布验证。
