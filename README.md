# bili-context-patch（billion-context 的自维护构建）

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，基线 **v0.1.212**，MIT 许可；同时内置 [dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator)。

装上它之后，插件列表里**只有一张卡**：`bili-context-patch`。上游的 billion-context 与加速器都不再作为独立插件出现——它们由这层的包装包在内部挂载。

这里保存的是可直接替换的 `dist/index.js` 构建产物，不是源码：上游发布的就是这个 bundle，没有公开的对应源码树。两个上游包都不复制进本仓库，包装包只负责挂载。

## 为什么维护一个分支

DSH 的「模型请求加速」插件和 bili 都在做同一件事——把请求体变小。bili 会把对话历史折叠后重新序列化再发往上游，插件再压一遍没有意义；反过来，如果压不压只由 bili 的全局开关决定，插件里按渠道的开关就失效了。

这个分支只解决这一件事：**让本地客户端把压缩决定交给 bili，并且能问回真实的出网字节。**

## 相比上游多了什么

1. **出口压缩** —— bili 转发前对模型端点的请求体做 gzip / br
2. **压缩指令** —— `x-accel-compress: off | on | gzip | br`，按请求覆盖全局设置
3. **回执接口** —— `GET /__bili/encode-stats[?rid=…]`，查这条请求折叠后与出网的字节
4. **记录与日志** —— `origBytes / wireBytes / encoding / dir`，另写 `upstream-encode.log`
5. **一体化安装** —— 安装脚本生成一个包装包 `bili-context-patch`：一个 Loader 条目同时挂载 bili、它的压缩闸门和加速器，插件列表因此只有一张卡
6. **默认值调整** —— `prompt_cache_key` 装好即发；中转站渠道装好即开请求压缩（brotli 优先），见下面「装好之后的默认值」

前四项在 `dist/index.js` 里，第五、六项在 `package/` 与 `scripts/install.mjs` 里，细节见 [PATCHES.md](./PATCHES.md)。

## 一体化是怎么做的

「设置 → 插件」是**一个组合包一张卡**（列表按 `dsh.profile.bundles` 里的 bundle 生成，卡片下列出它 insert 或改写的行）。所以只要 bili 与加速器各自还是清单里的一项，就必然是两张卡——改标题只能改字面。做法是加一层很薄的包装包，让清单里只剩它一项：

- **主机半侧**（`package/lib/index.js`）：一个条目里 `ctx.plugin()` 依次挂载 `billion-context`、`billion-context/dsh-compaction-gate` 和加速器。它还 `export const Config = accelerator.Config`——设置服务以**条目 id** 作命名空间键，且只投影声明了 `Config` 的条目；不导出这个 schema，`模型请求加速` 那一页就没有表单可读；
- **配置怎么传下去**：条目收到的 config 里，`.volatile()` 字段是设置服务原地维护的活访问器（改开关不重启进程，只原地换值）。所以子插件以 `{ ...accelerator, Config: undefined }` 挂载：Cordis 对没有 schema 的运行时原样透传 config，访问器不会被二次解析冻成快照，渠道开关因此即时生效；
- **浏览器半侧**：安装时把两个包客户端 bundle 的工厂体切出来，合进一个 `id: "bili-context-patch"` 的工厂，两个 half 依次 apply 到同一处。加速器客户端里 `const NS = "model-request-accelerator"` 这个字面量会被改写成 `"bili-context-patch"`（它按命名空间找设置文档），包装清单同时补上 `dsh.client.inject` 的两条依赖，让两个 half 用到的客户端模块先到；
- **组合层**：`billion-context` 原来的 `dsh.bundle.patch.yml` 被复制进包装包，只删掉那两条 `insert`（那两个插件改由代码挂载），压缩闸门、`compaction-basic`、预设注入与重试策略都保留；开头换成一条 `insert` 指向包装包自己——被列进 `dsh.profile.bundles` 的包只提供 patch 层，不会自己变成 Loader 条目。

于是：

- **装一次**：跑一次安装脚本，两个功能都在，插件列表只有 `bili-context-patch`；
- **卸一次**：从 `dsh.profile.bundles` 移除 `bili-context-patch`，一切随之停止；
- **页面各归各**：设置里仍是两页（bili 面板 + 模型请求加速），加速器的渠道开关不受影响；
- **更新解耦**：两个上游包都没被复制，升级任一包后重跑安装脚本即可重新生成包装包。

## 平台

macOS、Linux、Windows 都可用，补丁和脚本里没有平台专属命令：

- 家目录按 `HOME` → `USERPROFILE` → `os.homedir()` 的顺序解析，所以 `~/.local/state/billion-context/upstream-encoding` 在 Windows 上落在 `%USERPROFILE%\.local\state\billion-context\upstream-encoding`（正斜杠路径 Node 也认）
- 需要换位置时设 `BILI_UPSTREAM_ENCODING_FILE`
- 安装与重启脚本是 Node 写的（`scripts/*.mjs`），不依赖 shell、`lsof` 或 `nohup`
- 默认安装位置：macOS/Linux `~/.dsh/profiles/desktop/node_modules/billion-context`，Windows `%USERPROFILE%\.dsh\profiles\desktop\node_modules\billion-context`（同一个 `os.homedir()` 表达式，可用参数或 `BILI_PKG` 覆盖）

## 安装

```sh
node scripts/install.mjs                       # 默认位置：装构建 + 生成 bili-context-patch
node scripts/install.mjs /path/to/billion-context
node scripts/install.mjs --dry-run             # 只打印要做什么，不写文件
node scripts/install.mjs --compression-only    # 只要压缩补丁，不生成包装包
node scripts/install.mjs --accelerator /path/to/dsh-plugin-model-request-accelerator
node scripts/restart.mjs                       # 重启 bili 代理，让新的 dist 生效
```

`install.mjs` 依次做这些事，每步都打印结果，每个被改的文件都留 `<文件>.bak-<时间戳>` 备份：

1. 先拿候选构建跑冒烟测试（`scripts/smoke.mjs`：本机起一个模拟上游，分不压缩 / brotli / gzip 三路，验证到达上游的 `content-length` 只有一个、是个数字、且等于实际字节数，身体解压后与原文一致，重试不会二次压缩）；通过才备份并覆盖 `dist/index.js`，不通过就停在这里，已装的构建原样不动（`--skip-smoke` 可跳过）；
2. 确保加速器在 `<profile>/plugins/model-request-accelerator`（缺失时 `git clone`，也可用 `--accelerator` 指定）；
3. 生成 `<profile>/plugins/bili-context-patch`：manifest、主机入口、合并后的 `lib/client.js`、以及从 bili 复制并删掉 insert 的 `dsh.bundle.patch.yml`；
4. 把它链进 `node_modules`（加速器同样）；
5. 改 profile 的 `package.json`：把 `billion-context` 换成 `bili-context-patch`，两个包都写成 `link:` 依赖；
6. 把 profile 的 `cordis.patch.yml` 里那条按 id 定位的渠道配置改指向 `bili-context-patch`（只改带 `config:` 的那一行，不碰别的行）；
7. **不写任何禁用行**：合并插件自己那行必须是 `disabled: false`；上游三行如果被旧版本钉过 `disabled: true`，这里会把它们删掉（默认即启用）。道理在下一节。

装完重启 DSH 生效。`restart.mjs` 只重启 bili 代理，用来加载新的 `dist/index.js`。

### 卸载

```sh
dsh plugin --profile desktop remove bili-context-patch
```

`plugins/bili-context-patch`、`plugins/model-request-accelerator` 与 `node_modules/billion-context` 会留在磁盘上，但不再被任何组合层挂载，不启动、不占资源。要彻底清掉，删掉这两个目录并在 profile 的 `dependencies` 里移除对应条目即可。

### 原版怎么被关掉

安装时脚本把 `billion-context` 和 `dsh-plugin-model-request-accelerator` 从 `dsh.profile.bundles` 里移出去，只留 `bili-context-patch`。插件页的开关就是这张清单的投影，所以那两张卡片显示为关闭，网页也只下发一个客户端包。

包在两个地方兜底：

1. `dsh.bundle.patch.yml` 里只有一条 insert：`bili-context-patch` 自己。原版没有条目，不会被创建；
2. 宿主半侧挂载子插件**之前**扫一遍条目树，把仍然开着的原版条目关掉。顺序不能反：两边注册同一套服务和 HTTP 路由，晚一步关会把已经注册的接口一起带走（实测 `/api/model-request-accelerator/version` 会 404）。

想换回原版：先关掉 `bili-context-patch`，再去插件页打开要用的那张卡片，它就会作为独立插件跑起来。**别两边同时开**——同一批服务和路由被注册两遍，接口会互相顶掉。

| 状态 | 插件页 | 网页下发的客户端包 | 加速器接口 |
|---|---|---|---|
| 正常安装后 | 我们开、两张原版关 | 只有 `bili-context-patch` | `2.3.0` |
| 关掉我们、打开某个原版 | 只有那张原版开 | 那张原版 | `2.3.0` |

### 用插件管理器增删别的插件之后

插件管理器在包操作后会重算 `dsh.profile.bundles`，把声明了 bundle patch 的依赖重新写回去。真发生的话，原版卡片会重新亮起来——重跑一次 `node scripts/install.mjs` 就能把清单恢复成"只留合并插件"；即使不重跑，宿主半侧的自检也会在启动时把它们关掉，功能不会重复。

## 验证

装上并重启后，看两处：

1. **设置 → 插件 → 插件列表**：只有一张 `bili-context-patch`，不再有 `billion-context` 或 `模型请求加速` 的独立卡片；
2. **设置侧栏**：`模型请求加速` 那一页仍在（排在 bili 那页前面），对话里能挂出请求耗时面板。

压缩链路：

```sh
curl -s http://127.0.0.1:18787/__bili/health
curl -s "http://127.0.0.1:18787/__bili/encode-stats?rid=<某个 rid>" | head -c 400
```

想单独复核压缩链路，不经过对话：`node scripts/smoke.mjs`（默认测仓库里的 `dist/index.js`，也可以传一个路径）。它失败就说明这份构建不能装。

## 开关

```sh
# 没有指令的请求（例如别的客户端）默认怎么压
echo gzip > ~/.local/state/billion-context/upstream-encoding   # 或 br；清空文件则关闭
```

带 `x-accel-compress` 的请求以指令为准。

## 装好之后的默认值

两件事不用手动开，装完就是开的：

| 能力 | 默认 | 起作用的地方 | 怎么关 |
| --- | --- | --- | --- |
| `prompt_cache_key` 注入 | 开 | `dist/index.js` 里 `parsePromptCacheRouting` 的兜底值由 `disabled` 改成 `enabled`，配置没写 `routing` 时对所有上游都发 | 在 bili 配置里写 `promptCache.routing: "disabled"`；写 `"auto"` 则只对 `api.openai.com` 发 |
| 中转站渠道的请求压缩 | 开，`encoding: auto`（优先 brotli，缺 brotli 或上游拒绝时回落 gzip） | `install.mjs` 扫描 profile 里的 `baseURL`，主机名是 `www.didudidu.asia` 或 `154.219.111.56` 的渠道，自动在包装包条目下写 `enabled: true` + `encoding: auto` | 设置 → 模型请求加速 → 渠道，关掉对应开关；或改 `cordis.patch.yml` 里那个渠道的 `enabled` |

渠道是**按主机名匹配**的，渠道名字（`ylinkimi`、`test` 之类）随便改都不影响；换成别的域名要重跑一次 `node scripts/install.mjs`。脚本每次运行都会打印它认出了哪些渠道：

```
relay channels: ylinkimi, test -> compression on, brotli-first
```

### 版本号与检查更新

版本号就是这个包装包自己的三位 semver，写在 `package/package.json` 里，当前 **0.1.1**；发一版就把最后一位加一（0.1.1、0.1.2…），提交推送后远端就有了。基线 bili 版本不写进版本号，记录在安装后 manifest 的 `meta.upstream`（例如 `billion-context@0.1.212`）里。

设置 → 模型请求加速 页面底部那行「版本 / 检查更新」在合并之后指向**本补丁包**：

- 点「检查更新」→ `GET /api/bili-context-patch/version`，把本机版本和仓库里 `package/package.json` 的版本比对；
- 点「更新到 vX」→ `POST /api/bili-context-patch/version?action=update`，在补丁仓库里 `git pull --ff-only`，然后自动跑一次 `scripts/install.mjs` 重新生成包装包，完成后提示重启 dsh web；
- 这个动作需要安装时记下仓库路径（manifest 里的 `patchRepo`）。仓库被移动或删除时接口会返回 `no patch checkout recorded`，重跑一次 `node scripts/install.mjs` 就能补上。

手动更新依旧是这两条：

```sh
cd /Users/senno/Documents/deepseek-harness/billion-context-patched
git pull && node scripts/install.mjs
```

## 上游升级之后

`dist/index.js` 是构建产物，上游一升级，这份补丁就不能照搬了：需要按 [PATCHES.md](./PATCHES.md) 列出的位置重新落一遍，然后**重跑一次 `node scripts/install.mjs`**——它会用新的 bili 版本重新生成包装包（组合层、合并的客户端 bundle 都从当时磁盘上的上游包里现取）。

## 风险与边界

- 只处理 POST 且路径含 `/chat/completions`、`/v1/messages`、`/responses` 的请求体；其他路径一律原样
- 请求体小于 1024 字节、压缩后不足原文 95%、或已带 `content-encoding` 时不压
- br 用 quality 4；上游是否接受 br 由网关决定，这里**不会**在失败时自动降级，客户端可按需改回 gzip
- 入站解压、折叠策略、其他 `/__bili/*` 接口都没有改动
- 合并只在安装期发生：两个上游包一个字节都没被改写，包装包里的客户端 bundle 是安装时从它们的构建产物切出来的
