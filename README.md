# billion-context（自维护分支）

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，基线 **v0.1.212**，MIT 许可。

这里保存的是可直接替换的 `dist/index.js` 构建产物，不是源码：上游发布的就是这个 bundle，没有公开的对应源码树。

## 为什么维护一个分支

DSH 的「模型请求加速」插件和 bili 都在做同一件事——把请求体变小。bili 会把对话历史折叠后重新序列化再发往上游，插件再压一遍没有意义；反过来，如果压不压只由 bili 的全局开关决定，插件里按渠道的开关就失效了。

这个分支只解决这一件事：**让本地客户端把压缩决定交给 bili，并且能问回真实的出网字节。**

## 相比上游多了什么

1. **出口压缩** —— bili 转发前对模型端点的请求体做 gzip / br
2. **压缩指令** —— `x-accel-compress: off | on | gzip | br`，按请求覆盖全局设置
3. **回执接口** —— `GET /__bili/encode-stats[?rid=…]`，查这条请求折叠后与出网的字节
4. **记录与日志** —— `origBytes / wireBytes / encoding / dir`，另写 `upstream-encode.log`

细节和代码位置见 [PATCHES.md](./PATCHES.md)。

## 安装

```sh
./scripts/install.sh                 # 默认写进 ~/.dsh/profiles/desktop/node_modules/billion-context
./scripts/install.sh /path/to/billion-context   # 或指定安装位置
./scripts/restart-bili.sh            # 重启后生效
```

install.sh 会先把现有的 `dist/index.js` 备份成 `dist/index.js.bak-<时间戳>`，再覆盖。

## 验证

```sh
curl -s http://127.0.0.1:18787/__bili/health
curl -s "http://127.0.0.1:18787/__bili/encode-stats?rid=<某个 rid>" | head -c 400
```

记录里 `dir` 为空串表示这条请求没有带指令、走的是 bili 自己的全局设置；`encoding` 是 `none` 表示这条没有压缩。

## 开关

```sh
# 没有指令的请求（例如别的客户端）默认怎么压
echo gzip > ~/.local/state/billion-context/upstream-encoding   # 或 br；清空文件则关闭
```

带 `x-accel-compress` 的请求以指令为准。

## 上游升级之后

`dist/index.js` 是构建产物，上游一升级，这份补丁就不能照搬了：需要按 [PATCHES.md](./PATCHES.md) 列出的位置重新落一遍。`patches/upstream-0.1.212.diff` 是本分支相对上游 0.1.212 的完整 diff，可对照。

## 风险与边界

- 只处理 POST 且路径含 `/chat/completions`、`/v1/messages`、`/responses` 的请求体；其他路径一律原样
- 请求体小于 1024 字节、压缩后不足原文 95%、或已带 `content-encoding` 时不压
- br 用 quality 4；上游是否接受 br 由网关决定，这里**不会**在失败时自动降级，客户端可按需改回 gzip
- 入站解压、折叠策略、其他 `/__bili/*` 接口都没有改动
