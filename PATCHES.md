# 相对上游 v0.1.212 的改动

- 上游：<https://github.com/ranxianglei/billion-context>（MIT，Copyright (c) 2026 ranxianglei）
- 本分支基线：**0.1.212**（commit `daa082ea`）
- 完整 diff：[`patches/upstream-0.1.212.diff`](./patches/upstream-0.1.212.diff)

改动只有两处：`dist/index.js` 里新增了一段模块级函数（约第 530 行附近），以及 `fetchWithTimeout` 开头多了一行调用。

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

## 5. 没有改动的部分

- 入站解压（客户端发来的 gzip / br / zstd）仍用上游实现
- 折叠策略、健康检查、其他 `/__bili/*` 接口均未改动
- 上游的 `dsh.bundle.patch.yml`、`hermes-plugin`、文档等文件原样保留

## 6. 已知限制

- `dist/index.js` 是构建产物，补丁按**文本锚点**落在 0.1.212 上；上游一旦改动这些函数，需要按上面列的位置手工重做
- br 是否被上游网关接受取决于网关版本，这里不做自动降级
