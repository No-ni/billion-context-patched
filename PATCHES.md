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

**为什么需要它**：插件列表一条 Loader 条目一张卡，浏览器半侧的客户端 bundle 也是按条目分发的（`@deepseek-ai/dsh-client-modules`：宿主扫描已启用的 Loader 条目并组合启动图）。只要 bili 和加速器各占一条条目，就必然是两张卡——改标题只能改字面。

**怎么做的**：

- `package/lib/index.js`（主机半侧）——一个条目内 `ctx.plugin()` 依次挂载 `billion-context`、`billion-context/dsh-compaction-gate`、`dsh-plugin-model-request-accelerator`；本条目收到的 `config` 转发给加速器，渠道开关因此仍然生效；
- `package/lib/client.template.js`（浏览器半侧）——安装时把两个包客户端 bundle 的工厂体（`window.__ModuleLoader__.load({id, factory})` 里面的那段）切出来，合进同一个 `id: "bili-context-patch"` 的工厂，两个 half 依次 apply、`inject` 取并集；
- 组合层——复制 bili 的 `dsh.bundle.patch.yml`，删掉开头那条 `- insert:`（`bili-native` 与 `bili-compaction-gate` 改由代码挂载，否则又是两条 Loader 条目），`compaction-basic.auto:false`、四个 preset 的 `inject: [biliBasicCompactionPolicy]`、`llm-deepseek(-account)` 的 retryPolicy 全部保留。

**profile 侧的三处改写**（都由脚本完成、幂等、带 `.bak-<时间戳>` 备份）：`dsh.profile.bundles` 里 `billion-context` 换成 `bili-context-patch`；`dependencies` 里给包装包与加速器各写一条 `link:`；`cordis.patch.yml` 里按 id 定位的那条渠道配置改成 `- id: bili-context-patch`。

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
- 安装脚本会改写 profile 的 `package.json` 与 `cordis.patch.yml`（均保留 `.bak-<时间戳>` 备份）；用 DSH 插件管理器更新 bili 时它不会自动重做这些，更新后需要自己跑一次 `install.mjs`
- 一体化之后，禁用 `bili-context-patch` 等于同时停掉三项能力；这是「一张卡」的代价，也是它的定义
