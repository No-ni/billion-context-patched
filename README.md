# billion-context（自维护分支）

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，基线 **v0.1.212**，MIT 许可。

这个仓库做两件事：替换 `dist/index.js`（出口压缩与回执），以及在**安装时**把 [dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator) 并进同一个安装单元——装一次 bili，两个功能都在；卸一次，两个一起走。

这里保存的是可直接替换的 `dist/index.js` 构建产物，不是源码：上游发布的就是这个 bundle，没有公开的对应源码树。加速插件不复制进来，它仍是自己的仓库、自己的包，安装脚本只负责接线。

## 为什么维护一个分支

DSH 的「模型请求加速」插件和 bili 都在做同一件事——把请求体变小。bili 会把对话历史折叠后重新序列化再发往上游，插件再压一遍没有意义；反过来，如果压不压只由 bili 的全局开关决定，插件里按渠道的开关就失效了。

这个分支只解决这一件事：**让本地客户端把压缩决定交给 bili，并且能问回真实的出网字节。**

## 相比上游多了什么

1. **出口压缩** —— bili 转发前对模型端点的请求体做 gzip / br
2. **压缩指令** —— `x-accel-compress: off | on | gzip | br`，按请求覆盖全局设置
3. **回执接口** —— `GET /__bili/encode-stats[?rid=…]`，查这条请求折叠后与出网的字节
4. **记录与日志** —— `origBytes / wireBytes / encoding / dir`，另写 `upstream-encode.log`
5. **合并加速插件** —— 安装时在 bili 的组合层追加一行 `insert`，把 `model-request-accelerator` 一起挂上；它的设置页、耗时面板、仓库和发版节奏都不变

前四项在 `dist/index.js` 里，第五项在安装期完成，细节和代码位置见 [PATCHES.md](./PATCHES.md)。

## 合并是怎么做到的

DSH 里「一次安装」的单位是组合包：profile 的 `dsh.profile.bundles` 里列了谁，谁的 `dsh.bundle.patch.yml` 才会被应用。所以合并只动组合层，不动任何一方的代码：

- 那一行的**来源**从加速插件自己的组合层，挪到 bili 的组合层（安装时追加到 `dsh.bundle.patch.yml` 末尾）；
- 加速插件从 `dsh.profile.bundles` 移除，但**保留 profile 依赖**（`link:./plugins/model-request-accelerator`）——加载器要按名字从 `node_modules` 解析到它的模块；
- 加速插件自己的 `cordis.patch.yml` 不再被应用（同一个 id 被两个组合层插入会变成重复条目），文件留着即可。

于是：

- **装一次**：装好 bili 之后两个功能都在，加速插件的按渠道开关照旧在它自己的设置页里；
- **卸一次**：从 `dsh.profile.bundles` 移除 billion-context，那行 `insert` 随之消失，加速插件不再启动、设置页消失；
- **页面各归各**：加速插件的设置页由它自己注册（`settings.section`），bili 还是原来那套面板；
- **更新解耦**：加速插件更新只动它自己的目录；bili 更新要重跑一次 `install.mjs`——换包会把组合层还原成上游，这一步本来就在你的升级流程里。

## 平台

macOS、Linux、Windows 都可用，补丁和脚本里没有平台专属命令：

- 家目录按 `HOME` → `USERPROFILE` → `os.homedir()` 的顺序解析，所以 `~/.local/state/billion-context/upstream-encoding` 在 Windows 上落在 `%USERPROFILE%\.local\state\billion-context\upstream-encoding`（正斜杠路径 Node 也认）
- 需要换位置时设 `BILI_UPSTREAM_ENCODING_FILE`
- 安装与重启脚本是 Node 写的（`scripts/*.mjs`），不依赖 shell、`lsof` 或 `nohup`
- 默认安装位置：macOS/Linux `~/.dsh/profiles/desktop/node_modules/billion-context`，Windows `%USERPROFILE%\.dsh\profiles\desktop\node_modules\billion-context`（同一个 `os.homedir()` 表达式，可用参数或 `BILI_PKG` 覆盖）

## 安装

```sh
node scripts/install.mjs                       # 默认位置：装构建 + 合并加速插件
node scripts/install.mjs /path/to/billion-context
node scripts/install.mjs --dry-run             # 只打印要做什么，不写文件
node scripts/install.mjs --compression-only    # 只要压缩补丁，不合并加速插件
node scripts/install.mjs --accelerator /path/to/dsh-plugin-model-request-accelerator
node scripts/restart.mjs                       # 重启 bili 代理，让新的 dist 生效
```

`install.mjs` 依次做四步，每步都打印结果，且每个被改的文件都留 `<文件>.bak-<时间戳>` 备份：

1. 备份并覆盖 `dist/index.js`；
2. 确保加速插件在 `<profile>/plugins/model-request-accelerator`（缺失时 `git clone`，也可用 `--accelerator` 指定已有目录）；
3. 改 profile 的 `package.json`：依赖写 `link:`，并从 `dsh.profile.bundles` 里移掉加速插件；
4. 在 bili 的 `dsh.bundle.patch.yml` 末尾追加加速插件那一行（重复执行会替换旧块，不会叠加）。

装完重启 DSH 生效（开了 HMR 会自动重组）。`restart.mjs` 只重启 bili 代理，用来加载新的 `dist/index.js`。

### 卸载

按 DSH 的方式移除组合包即可，两个功能一起停：

```sh
dsh plugin --profile desktop remove billion-context
```

`plugins/model-request-accelerator` 目录会留在磁盘上——它只是 profile 的一个 link 依赖，不再被任何组合层挂载，不启动、不占资源。要彻底清掉，删掉该目录并从 profile 的 `dependencies` 里移除即可。

## 验证

```sh
curl -s http://127.0.0.1:18787/__bili/health
curl -s "http://127.0.0.1:18787/__bili/encode-stats?rid=<某个 rid>" | head -c 400
```

（Windows 上没有 curl 时，浏览器打开同样地址即可。）记录里 `dir` 为空串表示这条请求没有带指令、走的是 bili 自己的全局设置；`encoding` 是 `none` 表示这条没有压缩。

合并是否生效，看两处：DSH 设置里仍有「模型请求加速」那一页（它在 bili 那页上面，注册顺序 30 对 100），以及对话里能挂出请求耗时面板。

## 开关

```sh
# 没有指令的请求（例如别的客户端）默认怎么压
echo gzip > ~/.local/state/billion-context/upstream-encoding   # 或 br；清空文件则关闭
```

带 `x-accel-compress` 的请求以指令为准。

## 上游升级之后

`dist/index.js` 是构建产物，上游一升级，这份补丁就不能照搬了：需要按 [PATCHES.md](./PATCHES.md) 列出的位置重新落一遍。`patches/upstream-0.1.212.diff` 是本分支相对上游 0.1.212 的完整 diff，可对照。

组合层也一样：新版本换上之后 `dsh.bundle.patch.yml` 会退回上游原样，加速插件那一行随之消失——重跑一次 `node scripts/install.mjs` 即可同时补上构建与合并（脚本可重复执行）。

## 风险与边界

- 只处理 POST 且路径含 `/chat/completions`、`/v1/messages`、`/responses` 的请求体；其他路径一律原样
- 请求体小于 1024 字节、压缩后不足原文 95%、或已带 `content-encoding` 时不压
- br 用 quality 4；上游是否接受 br 由网关决定，这里**不会**在失败时自动降级，客户端可按需改回 gzip
- 入站解压、折叠策略、其他 `/__bili/*` 接口都没有改动
- 合并只改组合层，不改加速插件的代码：它的按渠道开关、耗时面板和接口都还是它自己的
