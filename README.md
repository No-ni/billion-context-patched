# bili-context-patch

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，代码取自上游 master `406193b2`（上游版本号仍是 0.1.213，但比 0.1.213 那次发版多 155 个提交），MIT 许可。

相对上游，这个包多带一个[模型请求加速](https://github.com/No-ni/dsh-plugin-model-request-accelerator)插件：压缩请求体、预传输共享对话历史，并给出每次请求的耗时面板。两样东西装在一起，所以「设置 → 插件」里只有一张 `bili-context-patch`；bili 面板与「模型请求加速」两个设置页照旧各管各的。

另外补了一处 DSH 的缺口：**fork 出来的会话现在会写明自己的父会话**（会话头的 `parentSession`）。bili 靠这个字段继承父会话的压缩状态；没有它，fork 出来的子会话会把继承来的上百万 token 正文从零重压一遍，首字要等好几分钟，甚至直接 413。这是包装包宿主半边自己做的（`lib/fork-lineage.js`），bili 的构建没有为此多打一行补丁。

项目行为要求与验收条件见 [SPEC.md](SPEC.md)，覆盖全部定制功能及“缓存钥匙默认开启”的明确约定；后续 AI 每次合并前后必须按 SPEC 核对，执行规则见 [AGENTS.md](AGENTS.md)。当前差异与升级流程见 [MAINTENANCE.md](MAINTENANCE.md)；历史排查和实现细节见 [PATCHES.md](PATCHES.md)。

## 安装

设置 → 插件 → 安装，填仓库地址即可，装完重启 DSH：

```
github:No-ni/billion-context-patched
```

包里自带运行所需的一切（两个上游的运行文件副本、合并后的客户端包、组合层），装完不需要再跑任何脚本，也不需要先装 billion-context。

已经 clone 了这个仓库的话，也可以直接把它装进本机 profile：

```sh
node scripts/install.mjs
node scripts/restart.mjs
```

脚本以仓库自带的 `vendor/` 为准，所以在本机已经装过旧版的情况下，更新仓库后重跑这一条就够了，不用先卸。

## 卸载

```sh
dsh plugin --profile desktop remove bili-context-patch
```

插件目录（`plugins/bili-context-patch` 或 pnpm 的 `node_modules/bili-context-patch`）会留在磁盘上，想清理直接删掉即可。

## 目录

- `lib/` —— 主机入口 `index.js`、fork 血缘补丁 `fork-lineage.js`、客户端合并包 `client.js`、上游转发 `upstream.js`
- `vendor/` —— 两个上游的运行文件副本，自包含，不依赖 profile 里的其他包；打过补丁的 bili 构建只有一份，在 `vendor/billion-context/dist/index.js`
- `dsh.bundle.patch.yml` —— 组合层
- `patches/` —— 我们对 bili 构建做的改动：`outbound-encoding.block.js` 是请求体压缩那一整块代码，其余由脚本按锚点插入
- `scripts/` —— `install.mjs`（装进本机 profile，`--build` 重建本仓库产物）、`patch-bili-build.mjs`（给 bili 构建按锚点应用补丁，逐项见 [PATCHES.md](PATCHES.md) 第 0.2 节）、`restart.mjs`、`smoke.mjs`

`vendor/` 从选定来源复制，其中 bili 代理构建由补丁脚本修改；`lib/client.js`、`lib/upstream.js`、根 `dsh.bundle.patch.yml` 由 `node scripts/install.mjs --build` 生成。具体来源规则见 MAINTENANCE，不要只手改生成物。

当前清单覆盖 11 组 bili 补丁、6 项包装能力、5 项安装与运维行为，并逐项列出检查方法和未覆盖部分。上游已吸收的能力与本包新增能力分开记录。

## 插件道的快照渲染（0.4.3，可关）

dsh 这条道每轮整份重发历史，而 billion-context 的插件道默认「客户端说了算」，于是每轮出站前缀都重新推导：折叠一动中段就位移，上游缓存从中间开始对不上。同一个 fork 会话实测头两轮命中 10.0% / 11.3%。

仓库里的 bili 构建让这条道也能用服务端快照渲染：前缀由服务端统一表渲染，只有尾部追加。实测同一个会话出站 963 KiB → 328–340 KiB，命中 99.4%。

两层开关都在本机，不动插件代码：

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| 标记文件 | `~/.config/billion-context/plugin-lane-snapshot.on` | 允许这条道走快照渲染；删掉即回退 |
| 灰度 | `billion-context.json` 的 `rollout.features.snapshotRender` | 打开才真正改变出站字节；关着只做影子观测 |

**fork 出来的会话第一轮也走这条路**（0.4.4）：子会话在第一次保存前没有自己的记录，会退回旧路径整段重推；现在改成先借用父会话的记录。实测新建 fork 第一轮命中 69%（改动前是 0%，输入 26.5 万），第二轮起 99–100%。

**fork 第一轮也命中（0.5.1）**：只借记录还不够——出站字节、缓存钥匙、标签里的时间三样都得跟父会话一致。实测同一台机器上 fork 新会话的首轮：

| 阶段 | 首轮命中率 |
| --- | --- |
| 只借父会话记录 | 32% |
| ＋复用父会话的渲染结果 | 27.8%（钥匙不同，白复用） |
| ＋沿用父会话的缓存钥匙 | 58.1% |
| ＋标签不再带时间（过渡做法） | 99.3% |
| ＋fork 时沿用父会话的时刻，时间戳重新打开 | **99.4%** |

最后一条是定稿做法：fork 时把父会话「每条消息的时刻」抄给子会话，标签里的时间与父会话逐字一致，所以时间戳照旧显示，不需要改任何配置。改动上线后每个会话的下一轮会冷一次（标签字节变了）。

**临时缺行与旧画面复用（0.5.3）**：最新块暂时找不到消息行时，仅在确认该块的全部消息都位于客户端尾部后，才允许这一轮跳过它。旧画面复用改为校验完整历史前缀的 SHA-256，并确认它引用的摘要块仍然有效；历史被编辑、缺少消息或摘要已失效时不复用。重启后的首轮没有旧画面，无法证明完整性时仍可能拒绝请求，不能保证所有存储故障都能无损绕过。

安装会先在临时文件中应用补丁并运行消息完整性、请求压缩检查，再替换正式构建；重装保留手动禁用状态和渠道配置。重启脚本自动读取当前代理端口。

维护检查：

```sh
node scripts/check-views.mjs
node scripts/check-wrapper.mjs
node scripts/check-restart.mjs
node scripts/smoke.mjs
```

细节见 [PATCHES.md](PATCHES.md) 第 18 节。

## 0.5.0：跟上上游主线

0.1.213 之后上游又走了 155 个提交，这一版把它们全部吸收进来，我们的三处改动（请求体压缩、快照渲染开关、fork 首轮借用父会话记录）改成脚本对构建产物按锚点重打，不再是一份手改的二进制。

用户能感觉到的变化：

| 变化 | 说明 |
| --- | --- |
| fork 继承的折叠块不再丢 | 从父会话分出来时，父会话里已经折叠的段落一起带过来 |
| 折叠摘要挪到折叠处 | 摘要落在它替代的那段内容的位置，原位留一个指针，前缀更稳 |
| 出站不以 assistant 结尾 | 历史尾部是助手消息时自动补齐，避免上游不认这条前缀 |
| 被切断的重放更聪明 | 只被切断的推理内容可以原样重放，不必整轮重来 |
| 请求体上限 | 新增单条会话消息上限开关（默认关闭）＋ 32MiB 解码准入 |
| 端口被占会强接管 | bili 进程端口卡死时直接接管，不用手杀 |

## 维护：上游再发新版

按 [MAINTENANCE.md](MAINTENANCE.md) 的来源基线、逐项清单和升级流程处理；仓库 [AGENTS.md](AGENTS.md) 要求后续修改同步记录差异及验证。

当前构建默认开启 `prompt_cache_key`（0.5.4 已恢复并纳入补丁脚本），保留用户显式的 disabled/auto/enabled 设置。加速器仍支持按渠道启用 HTTP/2。本页缓存命中率是历史环境测量，不能保证新网关也相同。

## 许可

本仓库的补丁与包装层：MIT。`vendor/billion-context` 来自 [ranxianglei/billion-context](https://github.com/ranxianglei/billion-context)（MIT），`vendor/dsh-plugin-model-request-accelerator` 来自 [No-ni/dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator)，其中的压缩闸门 vendored 自 deshark42/dsh-compaction-basic-disable（MIT）。

## 版本

版本号是根目录 `package.json` 里的三位 semver，发一版把最后一位加一。设置 → 模型请求加速 页面底部那行「检查更新」查的就是这个仓库。
