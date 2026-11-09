# bili-context-patch（billion-context 的自维护构建）

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili»）的自维护构建，基线 **v0.1.212**，MIT 许可；同时内置 [dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator)。

装上它之后，插件列表里**只有一张卡**：`bili-context-patch»。上游的 billion-context 与加速器**不再作为依赖安装**，它们的文件被复制进这个包的 `vendor/» 目录，由包自己在内部挂载。

这里保存的是可直接替换的 `dist/index.js» 构建产物，不是源码：上游发布的就是这个 bundle，没有公开的对应源码树。本仓库不复制上游代码；复制发生在你机器上的安装目录里。

## 为什么维护一个分支

DSH 的「模型请求加速」插件和 bili 都在做同一件事——把请求体变小。bili 会把对话历史折叠后重新序列化再发往上游，插件再压一遍没有意义；反过来，如果压不压只由 bili 的全局开关决定，插件里按渠道的开关就失效了。

这个分支只解决这一件事：**让本地客户端把压缩决定交给 bili，并且能问回真实的出网字节。**

## 相比上游多了什么

1. **出口压缩** —— bili 转发前对模型端点的请求体做 gzip / br
2. **压缩指令** —— `x-accel-compress: off | on | gzip | br»，按请求覆盖全局设置
3. **回执接口** —— `GET /__bili/encode-stats[?rid=…]»，查这条请求折叠后与出网的字节
4. **记录与日志** —— `origBytes / wireBytes / encoding / dir»，另写 `upstream-encode.log»
5. **一体化安装** —— 安装脚本生成**唯一一个**包装包 `bili-context-patch»：一个 Loader 条目同时挂载 bili、它的压缩闸门和加速器，profile 只依赖它，插件列表因此只有一张卡
6. **默认值调整** —— `prompt_cache_key» 装好即发；中转站渠道装好即开请求压缩（brotli 优先），见下面「装好之后的默认值」

前四项在 `dist/index.js» 里，第五、六项在 `package/» 与 `scripts/install.mjs» 里，细节见 [PATCHES.md](./PATCHES.md)。

## 一体化是怎么做的

「设置 → 插件」**一个装好的包一张卡**：列表来自 profile 的 `dependencies»，开关是 `dsh.profile.bundles» 的投影。所以只要 bili 和加速器还各自是被依赖的包，就必然是两张卡——改标题只能改字面。做法是让 profile 只依赖一个包，这个包把两边的文件都带在身上：

- **源码复制**：安装时把 bili 的 `package.json»、`dist/index.js»、`dist/agent/*»、`dsh.bundle.patch.yml»，和加速器的 `package.json» + `lib/*.js» 复制进 `plugins/bili-context-patch/vendor/»（约 9.6 MB）。复制是**派生**的：每次运行脚本都重建，不要手改；
- **主机半侧**（`package/lib/index.js»）：一个条目里 `ctx.plugin()» 依次挂载 bili、压缩闸门和加速器，三者都从 `lib/upstream.js» 引入——那个文件用**相对路径**指向 `vendor/» 里的副本，因此 profile 不需要任何上游依赖；
- **配置怎么传下去**：条目收到的 config 里，`.volatile()» 字段是设置服务原地维护的活访问器（改开关不重启进程，只原地换值）。所以子插件以 `{ ...accelerator, Config: undefined }» 挂载：Cordis 对没有 schema 的运行时原样透传 config，访问器不会被二次解析冻成快照，渠道开关因此即时生效；包自身导出 `Config = accelerator.Config»，设置服务以**条目 id** 作命名空间键，只投影声明了 `Config» 的条目，不导出这一页就没有表单；
- **浏览器半侧**：安装时把两个包客户端 bundle 的工厂体切出来，合进一个 `id: "bili-context-patch"» 的工厂，两个 half 依次 apply 到同一处，并改写加速器客户端里设置命名空间那个字面量；
- **组合层**：bili 原来的 `dsh.bundle.patch.yml» 被复制进包装包，只删掉那两条 `insert»（那两个插件改由代码挂载），压缩闸门、`compaction-basic»、预设注入与重试策略都保留；开头换成一条 `insert» 指向包装包自己——被列进 `dsh.profile.bundles» 的包只提供 patch 层，不会自己变成 Loader 条目。

于是：

- **装一次**：跑一次安装脚本，两个功能都在，插件列表只有 `bili-context-patch»；
- **卸一次**：从依赖里移除它，一切随之停止，也不会留下两张「关着的原版卡」；
- **页面各归各**：设置里仍是两页（bili 面板 + 模型请求加速），加速器的渠道开关不受影响；
- **升级互不牵连**：上游什么时候更新都不会自己生效，要等你在安装脚本里重新取一次（见下面「上游升级之后」）。

## 平台

macOS、Linux、Windows 都可用，补丁和脚本里没有平台专属命令：

- 家目录按 `HOME» → `USERPROFILE» → `os.homedir()» 的顺序解析，所以 `~/.local/state/billion-context/upstream-encoding» 在 Windows 上落在 `%USERPROFILE%\.local\state\billion-context\upstream-encoding»（正斜杠路径 Node 也认）
- 需要换位置时设 `BILI_UPSTREAM_ENCODING_FILE»
- 安装与重启脚本是 Node 写的（`scripts/*.mjs»），不依赖 shell、`lsof» 或 `nohup»

## 安装

```sh
node scripts/install.mjs                          # 默认 profile：~/.dsh/profiles/desktop
node scripts/install.mjs --profile /path/to/profile
node scripts/install.mjs --bili /path/to/billion-context   # 指定上游源码位置
node scripts/install.mjs --dry-run                # 只打印要做什么，不写文件
node scripts/install.mjs --accelerator /path/to/dsh-plugin-model-request-accelerator
node scripts/restart.mjs                          # 重启 bili 代理，让新的 dist 生效
```

`install.mjs» 依次做这些事，每步都打印结果，每个被改的文件都留 `<文件>.bak-<时间戳>» 备份：

1. 拿候选构建跑冒烟测试（`scripts/smoke.mjs»：本机起一个模拟上游，分不压缩 / brotli / gzip 三路，验证到达上游的 `content-length» 只有一个、是个数字、且等于实际字节数，身体解压后与原文一致，重试不会二次压缩）；**合并产物也生成好之后**才写进 `vendor»，任何一步失败都停在那里，已装的构建和包装包原样不动（`--skip-smoke» 可跳过冒烟）；
2. 找上游源码：`--bili» / 位置参数 > `<profile>/node_modules/billion-context» > 上次留下的 `vendor/billion-context»；加速器同理（缺失时 `git clone»）；
3. 复制进 `plugins/bili-context-patch/vendor/»，并把打过补丁的 `dist/index.js» 放进去；
4. 生成包装包本体：manifest、主机入口、`lib/upstream.js»、合并后的 `lib/client.js»、从 bili 复制并删掉 insert 的 `dsh.bundle.patch.yml»；
5. 把它链进 `node_modules»；改 profile 的 `package.json»：依赖里**只留** `bili-context-patch»（`link:» 到 `plugins/»），billion-context 与加速器那两行删掉，启动清单里同样只留这一项；
6. 把 profile 的 `cordis.patch.yml» 里那条按 id 定位的渠道配置改指向 `bili-context-patch»（只改带 `config:» 的那一行，不碰别的行）；
7. 压住旧安装留下的条目：宿主半侧启动前扫一遍条目树，谁还开着就关掉（正常安装不会有这种事，兜「清单被别的工具回写」这种情况）。

装完重启 DSH 生效。`restart.mjs» 只重启 bili 代理，用来加载新的 `dist/index.js»。

### 卸载

```sh
dsh plugin --profile desktop remove bili-context-patch
```

依赖一去掉，卡片就没了，功能也随之停止。`plugins/bili-context-patch»（含 `vendor/»）会留在磁盘上，想彻底清掉直接删这个目录。原先单独装的 `node_modules/billion-context» 与 `plugins/model-request-accelerator» 现在只是「曾经装过」，删不删都不影响运行。

### 想换回独立的两个插件

先移除 `bili-context-patch»，再把 billion-context / dsh-plugin-model-request-accelerator 装回来。**别两边同时开**：同一批服务和 HTTP 路由被注册两遍，接口会互相顶掉。

## 用插件管理器增删别的插件之后

插件管理器在包操作后会重算 `dsh.profile.bundles»，把声明了 bundle patch 的**依赖**重新写回去。我们的包是依赖里的一项，所以它会被保留；上游两个包已经不是依赖，不会自己回来。真要有人手动把上游装回来，宿主半侧启动时的自检会把它关掉，功能不会重复。

## 验证

装上并重启后，看两处：

1. **设置 → 插件 → 插件列表**：只有一张 `bili-context-patch»，没有 billion-context 或「模型请求加速」的卡片；
2. **设置侧栏**：「模型请求加速」那一页仍在（排在 bili 那页前面），对话里能挂出请求耗时面板。

压缩链路：

```sh
curl -s http://127.0.0.1:18787/__bili/health
curl -s "http://127.0.0.1:18787/__bili/encode-stats?rid=<某个 rid>" | head -c 400
```

想单独复核压缩链路，不经过对话：`node scripts/smoke.mjs»（默认测仓库里的 `dist/index.js»，也可以传一个路径）。它失败就说明这份构建不能装。

## 开关

```sh
# 没有指令的请求（例如别的客户端）默认怎么压
echo gzip > ~/.local/state/billion-context/upstream-encoding   # 或 br；清空文件则关闭
```

带 `x-accel-compress» 的请求以指令为准。

## 装好之后的默认值

两件事不用手动开，装完就是开的：

| 能力 | 默认 | 起作用的地方 | 怎么关 |
| --- | --- | --- | --- |
| `prompt_cache_key» 注入 | 开 | `dist/index.js» 里 `parsePromptCacheRouting» 的兜底值由 `disabled» 改成 `enabled»，配置没写 `routing» 时对所有上游都发 | 在 bili 配置里写 `promptCache.routing: "disabled"»；写 `"auto"» 则只对 `api.openai.com» 发 |
| 中转站渠道的请求压缩 | 开，`encoding: auto»（优先 brotli，缺 brotli 或上游拒绝时回落 gzip） | `install.mjs» 扫描 profile 里的 `baseURL»，主机名是 `www.didudidu.asia» 或 `154.219.111.56» 的渠道，自动在包装包条目下写 `enabled: true» + `encoding: auto» | 设置 → 模型请求加速 → 渠道，关掉对应开关；或改 `cordis.patch.yml» 里那个渠道的 `enabled» |

渠道是**按主机名匹配**的，渠道名字（ylinkimi、test 之类）随便改都不影响；换成别的域名要重跑一次 `node scripts/install.mjs»。脚本每次运行都会打印它认出了哪些渠道：

```
relay channels: ylinkimi, test -> compression defaults (missing keys only)
```

### 版本号与检查更新

版本号就是这个包装包自己的三位 semver，写在 `package/package.json» 里，当前 **0.2.0**；发一版就把最后一位加一（0.2.1、0.2.2…），提交推送后远端就有了。基线 bili 版本不写进版本号，记录在安装后 manifest 的 `meta.upstream»（例如 `billion-context@0.1.212»）里。

设置 → 模型请求加速 页面底部那行「版本 / 检查更新」在合并之后指向**本补丁包**：

- 点「检查更新」→ `GET /api/bili-context-patch/version»，把本机版本和仓库里 `package/package.json» 的版本比对；
- 点「更新到 vX」→ `POST /api/bili-context-patch/version?action=update»，在补丁仓库里 `git pull --ff-only»，然后自动跑一次 `scripts/install.mjs» 重新生成包装包，完成后提示重启 dsh web；
- 这个动作需要安装时记下仓库路径（manifest 里的 `patchRepo»）。仓库被移动或删除时接口会返回 `no patch checkout recorded»，重跑一次 `node scripts/install.mjs» 就能补上。

手动更新依旧是这两条：

```sh
cd /Users/senno/Documents/deepseek-harness/billion-context-patched
git pull && node scripts/install.mjs
```

## 上游升级之后

`dist/index.js» 是构建产物，上游一升级，这份补丁就不能照搬了：需要按 [PATCHES.md](./PATCHES.md) 列出的位置重新落一遍。

因为 profile 里已经没有上游包，脚本默认从 `vendor/» 里那份旧副本重新复制。要跟上新版，把新版放到任何位置再指过去：

```sh
dsh plugin --profile tmp add billion-context
node scripts/install.mjs --bili ~/.dsh/profiles/tmp/node_modules/billion-context
```

脚本会把新版整套复制进 `vendor/»，版本记在 manifest 的 `meta.upstream» 里。

## 风险与边界

- 只处理 POST 且路径含 `/chat/completions»、`/v1/messages»、`/responses» 的请求体；其他路径一律原样
- 请求体小于 1024 字节、压缩后不足原文 95%、或已带 `content-encoding» 时不压
- br 用 quality 4；上游是否接受 br 由网关决定，这里**不会**在失败时自动降级，客户端可按需改回 gzip
- 入站解压、折叠策略、其他 `/__bili/*» 接口都没有改动
- 复制只发生在安装目录里：上游包一个字节都没被改写，仓库里也不含上游代码
