# 相对上游 v0.1.212 的改动

- 上游：<https://github.com/ranxianglei/billion-context>（MIT，Copyright (c) 2026 ranxianglei）
- 本分支基线：**0.1.212**（commit `daa082ea`）
- 完整 diff：[`patches/upstream-0.1.212.diff`](./patches/upstream-0.1.212.diff)

改动分两类：`dist/index.js` 里的出口压缩（第 1–4 节，见上面的 diff），以及**安装期**生成的一体化包装包（第 5 节，源码在 `package/`）。

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

## 5. 一体化层：一个条目挂三样东西

这一处不在 `dist/index.js` 里，源码是 `package/`，由 `scripts/install.mjs` 在安装时生成到 `<profile>/plugins/bili-context-patch`。

**为什么需要它**：「设置 → 插件」**一个组合包一张卡**——列表遍历 `dsh.profile.bundles`，每项用 `declaredRows()` 列出它的 patch 声明了哪些行。只要 bili 与加速器各自还在清单里，就必然是两张卡，改标题只能改字面。

**怎么做的**：

- `package/lib/index.js`（主机半侧）——一个条目内 `ctx.plugin()` 依次挂载 `billion-context`、`billion-context/dsh-compaction-gate`、`dsh-plugin-model-request-accelerator`；
- **设置命名空间**：`@deepseek-ai/dsh-settings` 的 `describe()` 用 `entry.options.id` 当 `ns`，并且只在 `entry.fiber.runtime.Config` 存在时才投影该条目。所以包装包必须 `export const Config = accelerator.Config`，否则条目 id 一变，`模型请求加速` 那一页就没有 schema 可读；
- **配置的活性**：条目的 `.volatile()` 字段不是普通值，而是设置服务原地维护的活访问器（Cordis 的 volatile 更新路径 `volatileEntries(fiber.effectiveConfig)` 只换值、不重启 fiber）。`resolveConfig(runtime, config)` 在 `runtime.Config` 不存在时**原样返回 config**，因此加速器以 `{ ...accelerator, Config: undefined }` 挂载，访问器一路到达它的 `plainConfig()`；二次解析会把访问器冻成快照，渠道开关就不即时了；
- `package/lib/client.template.js`（浏览器半侧）——安装时把两个包客户端 bundle 的工厂体（`window.__ModuleLoader__.load({id, factory})` 里面的那段）切出来，合进同一个 `id: "bili-context-patch"` 的工厂，两个 half 依次 apply、`inject` 取并集。加速器客户端 `lib/client.js:23` 的 `const NS = "model-request-accelerator"` 会被改写成 `"bili-context-patch"`（它按命名空间找文档、注册分区），原文必须恰好出现一次，否则脚本报错退出；包装清单补上 `dsh.client.inject: ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-ui-settings"]`，客户端模块按它决定到达顺序；
- 组合层——复制 bili 的 `dsh.bundle.patch.yml`，删掉开头那条 `- insert:`（`bili-native` 与 `bili-compaction-gate` 改由代码挂载），换成本包装包自己的一条 `insert`（被列进 `dsh.profile.bundles` 的包只提供 patch 层，不会自己变成 Loader 条目），`compaction-basic.auto:false`、四个 preset 的 `inject: [biliBasicCompactionPolicy]`、`llm-deepseek(-account)` 的 retryPolicy 全部保留。

**上游两个包怎么被压住**——全部在包装包自己的组合层里，用户配置里不落任何东西：

```yaml
# <profile>/plugins/bili-context-patch/dsh.bundle.patch.yml 末尾
- id: bili-native
  disabled: true
- id: bili-compaction-gate
  disabled: true
- id: model-request-accelerator
  disabled: true
```

1. 这些行由 `install.mjs` 生成，**只为这台机器上实际装了的包写**；没装的包不写行，免得每次启动打印 `patch: entry ... not found`。
2. 这一层只在包装包被列进 `dsh.profile.bundles` 时生效。关掉或卸载包装包，层不再参与合成，两个上游包自动回来——不需要清理任何状态。
3. 行只能改到**已经存在**的条目，而条目按 `dsh.profile.bundles` 的顺序创建。为了防止"包装包排在原版前面"这种顺序，`package/lib/index.js` 在挂载自己的子插件**之前**遍历 `ctx.get("loader").store.include.subtree.store`，把还开着的上游条目用 `entry.update({ ...entry.options, disabled: true })` 关掉。顺序必须在挂载之前：两边注册同一批服务和 HTTP 路由，晚一步关会把已注册的接口一起带走——实测 `/api/model-request-accelerator/version` 会 404。

**profile 侧的改写**（由脚本完成、幂等、带 `.bak-<时间戳>` 备份）：

1. `dsh.profile.bundles`：只保证 `bili-context-patch` 在清单里，其余项一律不增不删不改序；`dependencies` 里两个包各写一条 `link:`（依赖必须留着，包装包要按包名 import 它们）。
2. `cordis.patch.yml` 里按 id 定位的渠道配置改成 `- id: bili-context-patch`——只改**带 `config:`** 的那一行。早先的实现按"第一行同 id"改名，会连别行的钉子一起改名，结果把包装包自己写成 `disabled: true`。
3. 清掉上一版写进 profile 的 `!!js` 跟随行（三个 id）。那套做法依赖条目创建顺序，开关把包装包挪到末尾后就失效，三个插件会同时跑；现在改由第 2 条的组合层 + 运行时自检负责。

**效果**：装一次两个功能都在、插件列表只有一张 `bili-context-patch`；从 `dsh.profile.bundles` 移除它，一切随之停止。两个上游包一个字节都没被改写，升级任一包后重跑 `install.mjs` 即可重新生成包装包。

## 6. 没有改动的部分

- 入站解压（客户端发来的 gzip / br / zstd）仍用上游实现
- 折叠策略、健康检查、其他 `/__bili/*` 接口均未改动
- 仓库里的 `dist/index.js` 之外，仓库不保存任何上游包的副本；包装包在安装时生成
- `hermes-plugin`、文档等文件原样保留

## 7. 已知限制

- `dist/index.js` 是构建产物，补丁按**文本锚点**落在 0.1.212 上；上游一旦改动这些函数，需要按上面列的位置手工重做
- br 是否被上游网关接受取决于网关版本，这里不做自动降级
- 包装包的浏览器半侧按**工厂体文本**切分上游 bundle：上游如果改了客户端 bundle 的封装格式（不再是 `factory: (require) => {...}`），安装脚本会直接报错退出，不会生成半成品
- 安装脚本会改写 profile 的 `package.json` 与 `cordis.patch.yml`（均保留 `.bak-<时间戳>` 备份）；用 DSH 插件管理器更新 bili 或增删别的插件时它不会自动重做这些，做完需要自己跑一次 `install.mjs`
- **不要**在插件页点开关关掉 `bili-context-patch`：这个条目同时挂着压缩闸门（`biliBasicCompactionPolicy`），bili 上游注释 #3662 说明闸门必须常开，否则新建会话会一直等它。停用请从 `dsh.profile.bundles` 移除
- 一体化之后，卸载 `bili-context-patch` 等于同时停掉三项能力；这是「一张卡」的代价，也是它的定义
