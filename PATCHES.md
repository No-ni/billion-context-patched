# 相对上游 v0.1.212 的改动

- 上游：<https://github.com/ranxianglei/billion-context>（MIT，Copyright (c) 2026 ranxianglei）
- 本分支基线：**0.1.212**（commit `daa082ea`）
- 完整 diff：[`patches/upstream-0.1.212.diff`](./patches/upstream-0.1.212.diff)

改动分两类：上游 bili 的 `dist/index.js` 里的出口压缩（第 1–4 节，见 `patches/` 里的 diff；本仓库里这份构建只有一份，在 `vendor/billion-context/dist/index.js`），以及**安装期**生成的一体化包装包（第 5 节，源码在仓库根）。

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

`__biliEncodeOutbound` 只在同时满足这些条件时改写请求体：POST、路径属于三个模型端点、请求体 ≥1024 字节、没有现成的 `content-encoding`、压缩后小于原文 95%。命中后改写 `opts.body`，补 `content-encoding` 与 `content-length`。

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
- `hermes-plugin`、文档等文件原样保留

## 7. 默认值：装好即开的两项

- **`prompt_cache_key` 默认注入**：`parsePromptCacheRouting` 的兜底值由 `"disabled"` 改成 `"enabled"`。取值仍是三档：`disabled` 不发、`auto` 只对 `api.openai.com` 发、`enabled` 对所有上游发。配置文件里显式写了 `disabled` 的仍然尊重。
- **中转站渠道自动开请求压缩**：`install.mjs` 扫描 profile 的 `cordis.yml` 与 `cordis.patch.yml`，把 `baseURL` 命中 `www.didudidu.asia` 或 `154.219.111.56` 的渠道名挑出来，在包装包条目的 `config.providers.<渠道>` 下写 `enabled: true` 与 `encoding: auto`（优先 brotli，运行时缺 brotli 或上游拒绝时回落 gzip）。匹配用的是**主机名**，渠道改名不影响；渠道换了别的域名要重跑一次脚本。

## 8. 已知限制

- `vendor/billion-context/dist/index.js` 是构建产物，补丁按**文本锚点**落在 0.1.212 上；上游一旦改动这些函数，需要按上面列的位置手工重做
- br 是否被上游网关接受取决于网关版本，这里不做自动降级
- 包装包的浏览器半侧按**工厂体文本**切分上游 bundle：上游如果改了客户端 bundle 的封装格式（不再是 `factory: (require) => {...}`），安装脚本会直接报错退出，不会生成半成品
- 安装脚本会改写 profile 的 `package.json` 与 `cordis.patch.yml`（均保留 `.bak-<时间戳>` 备份）；用 DSH 插件管理器更新 bili 或增删别的插件时它不会自动重做这些，做完需要自己跑一次 `install.mjs`
- 关掉 `bili-context-patch` 会一起带走：条目本身、它挂的三个子插件、以及这一层里注入 preset 的 `biliBasicCompactionPolicy`。三者同生共死，所以 preset 会退回复用 dsh 自带的压缩策略，不会卡在等一个没人提供的服务上（上游 #3662 描述的是闸门与注入分离的情形）。要回到独立插件形态，得先把 `billion-context` / 加速器重新装成依赖（0.2.0 起它们不再是依赖条目，插件页没有那两张卡可点）
- 一体化之后，卸载 `bili-context-patch` 等于同时停掉三项能力；这是「一张卡」的代价，也是它的定义
- 0.2.0 起两个上游只存在于 `plugins/bili-context-patch/vendor/`：`dsh plugin add billion-context` 之后不会自动接上，必须重跑 `install.mjs`（它会用新的源码重建 vendor 与包装包）

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

- `lib/index.js`、`lib/client.template.js`、`package.json` —— 手写的部分
- `vendor/` —— 两个上游的副本，**直接提交**，安装时不再需要网络或先装上游
- `lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml` —— `install.mjs --build` 生成的产物，也提交，装下来即可运行
- `patches/` —— 相对上游的 diff，供维护者核对与重做补丁

补丁版构建在仓库里只有一份：`vendor/billion-context/dist/index.js`（旧版在仓库根另存过一份 `dist/`，两份内容相同，已合并）。脚本允许用 `--bili <目录>` 从外部更新它，但只接受带 `__biliEncZlib` 的构建，没打过补丁的 bili 不会顶掉现有构建。