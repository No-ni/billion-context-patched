# 相对上游 v0.1.212 的改动

- 上游：<https://github.com/ranxianglei/billion-context>（MIT，Copyright (c) 2026 ranxianglei）
- 本分支基线：**0.1.212**（commit `daa082ea`）
- 完整 diff：[`patches/upstream-0.1.212.diff`](./patches/upstream-0.1.212.diff)

改动分两类：`dist/index.js` 里的出口压缩（第 1–4 节，见上面的 diff），以及**安装期**对组合层的合并（第 5 节，不进 diff，由 `scripts/install.mjs` 写入）。

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

每次压缩另写一行 `~/.local/state/billion-context/upstream-encode.log`（Windows 上是 `%USERPROFILE%\.local\state\billion-context\upstream-encode.log`）：

```
2026-11-08T17:41:48.332Z encoded 481153 -> 142851 (br) rid=e79ee3c7-…
```

## 5. 合并层：随 billion-context 启用的加速插件

这一处不在 `dist/index.js` 里。`scripts/install.mjs` 安装时会在 bili 的 `dsh.bundle.patch.yml` 末尾追加一段：

```yaml
- insert:
    - id: model-request-accelerator
      name: dsh-plugin-model-request-accelerator
```

并把 `dsh-plugin-model-request-accelerator` 从 profile 的 `dsh.profile.bundles` 里移除（依赖保留，写 `link:` 指到本地插件目录）。

两个约束决定了这一个写法：

- **不能两边都插**：同一个 id 被两个组合层各插一次，会变成两行 `model-request-accelerator`，是重复条目而不是合并。所以加速插件自己的 `cordis.patch.yml` 不再被应用（它的内容也只有同一行 insert，无损失）。
- **依赖必须留**：加载器按 `name` 从 profile 的 `node_modules` 解析包，包不在了这行就是悬空引用。

效果是「装一次、卸一次」：移除 `billion-context` 组合包后，这段 patch 层不再被应用，加速插件那一行一起消失，插件不再启动、设置页消失。卸载时 `plugins/model-request-accelerator` 目录会留在磁盘上（只是 profile 的一个 link 依赖，不再被挂载）。

加速插件自身没有一行代码被复制进本仓库：它的设置页（`settings.section`）、耗时面板（`conversation.view`）、接口（`/api/model-request-accelerator/*`）和按渠道开关都还是它自己仓库里的实现，更新它只需更新那个目录。

## 6. 没有改动的部分

- 入站解压（客户端发来的 gzip / br / zstd）仍用上游实现
- 折叠策略、健康检查、其他 `/__bili/*` 接口均未改动
- 仓库里的 `dsh.bundle.patch.yml` 保持上游原样：第 5 节那段是安装时追加的，不进版本库，所以上游一升级、重跑 `install.mjs` 就能接上
- `hermes-plugin`、文档等文件原样保留

## 7. 已知限制

- `dist/index.js` 是构建产物，补丁按**文本锚点**落在 0.1.212 上；上游一旦改动这些函数，需要按上面列的位置手工重做
- br 是否被上游网关接受取决于网关版本，这里不做自动降级
- 合并依赖 profile 只有一份依赖清单：如果将来把加速插件重新加回 `dsh.profile.bundles`，必须同时去掉 bili 这层里的 insert，否则是重复条目
- 安装脚本会改写 profile 的 `package.json`（保留 `.bak-<时间戳>` 备份）；用 DSH 插件管理器更新 bili 时它不会自动重写这段，更新后需要自己跑一次 `install.mjs`
