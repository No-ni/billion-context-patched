# bili-context-patch

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，基线 **v0.1.213**，MIT 许可。

相对上游，这个包多带一个[模型请求加速](https://github.com/No-ni/dsh-plugin-model-request-accelerator)插件：压缩请求体、预传输共享对话历史，并给出每次请求的耗时面板。两样东西装在一起，所以「设置 → 插件」里只有一张 `bili-context-patch`；bili 面板与「模型请求加速」两个设置页照旧各管各的。

另外补了一处 DSH 的缺口：**fork 出来的会话现在会写明自己的父会话**（会话头的 `parentSession`）。bili 靠这个字段继承父会话的压缩状态；没有它，fork 出来的子会话会把继承来的上百万 token 正文从零重压一遍，首字要等好几分钟，甚至直接 413。这是包装包宿主半边自己做的（`lib/fork-lineage.js`），bili 的构建没有为此多打一行补丁。

## 安装

设置 → 插件 → 安装，填仓库地址即可，装完重启 DSH：

```
github:No-ni/billion-context-patched
```

包里自带运行所需的一切（两个上游的源码副本、合并后的客户端包、组合层），装完不需要再跑任何脚本，也不需要先装 billion-context。

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
- `vendor/` —— 两个上游的源码副本，自包含，不依赖 profile 里的其他包；打过补丁的 bili 构建只有一份，在 `vendor/billion-context/dist/index.js`
- `dsh.bundle.patch.yml` —— 组合层
- `patches/` —— 相对上游 v0.1.213 的 diff
- `scripts/` —— `install.mjs`（装进本机 profile，`--build` 重建本仓库产物）、`patch-plugin-lane-snapshot.mjs`（给 bili 构建打快照渲染开关）、`restart.mjs`、`smoke.mjs`

`vendor/`、`lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml` 是 `node scripts/install.mjs --build` 生成的，不要手改。补丁本身改了什么，见 [PATCHES.md](PATCHES.md)。

## 插件道的快照渲染（0.4.3，可关）

dsh 这条道每轮整份重发历史，而 billion-context 的插件道默认「客户端说了算」，于是每轮出站前缀都重新推导：折叠一动中段就位移，上游缓存从中间开始对不上。同一个 fork 会话实测头两轮命中 10.0% / 11.3%。

仓库里的 bili 构建让这条道也能用服务端快照渲染：前缀由服务端统一表渲染，只有尾部追加。实测同一个会话出站 963 KiB → 328–340 KiB，命中 99.4%。

两层开关都在本机，不动插件代码：

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| 标记文件 | `~/.config/billion-context/plugin-lane-snapshot.on` | 允许这条道走快照渲染；删掉即回退 |
| 灰度 | `billion-context.json` 的 `rollout.features.snapshotRender` | 打开才真正改变出站字节；关着只做影子观测 |

细节见 [PATCHES.md](PATCHES.md) 第 13 节。

## 维护：上游发新版

1. 按 `patches/` 里的 diff 把改动落到新版 bili 的 `dist/index.js` 上（锚点位置见 PATCHES.md）。
2. 把打好补丁的 bili 目录指给脚本重建：

   ```sh
   node scripts/install.mjs --build --bili /path/to/billion-context
   ```

3. 看 `git diff`、改 `package.json` 版本号、提交。

`--build` 只接受打过补丁的构建（认 `__biliEncZlib`），没打补丁的 bili 不会被拷进来顶掉现有的；覆盖之前还会先跑一遍冒烟测试。

## 许可

本仓库的补丁与包装层：MIT。`vendor/billion-context` 来自 [ranxianglei/billion-context](https://github.com/ranxianglei/billion-context)（MIT），`vendor/dsh-plugin-model-request-accelerator` 来自 [No-ni/dsh-plugin-model-request-accelerator](https://github.com/No-ni/dsh-plugin-model-request-accelerator)，其中的压缩闸门 vendored 自 deshark42/dsh-compaction-basic-disable（MIT）。

## 版本

版本号是根目录 `package.json` 里的三位 semver，发一版把最后一位加一。设置 → 模型请求加速 页面底部那行「检查更新」查的就是这个仓库。
