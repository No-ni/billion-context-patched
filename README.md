# bili-context-patch

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，基线 **v0.1.213**，MIT 许可。

相对上游，这个包多带一个[模型请求加速](https://github.com/No-ni/dsh-plugin-model-request-accelerator)插件：压缩请求体、预传输共享对话历史，并给出每次请求的耗时面板。两样东西装在一起，所以「设置 → 插件」里只有一张 `bili-context-patch`；bili 面板与「模型请求加速」两个设置页照旧各管各的。

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

## 卸载

```sh
dsh plugin --profile desktop remove bili-context-patch
```

插件目录（`plugins/bili-context-patch` 或 pnpm 的 `node_modules/bili-context-patch`）会留在磁盘上，想清理直接删掉即可。

## 目录

- `lib/` —— 主机入口 `index.js`、客户端合并包 `client.js`、上游转发 `upstream.js`
- `vendor/` —— 两个上游的源码副本，自包含，不依赖 profile 里的其他包；打过补丁的 bili 构建只有一份，在 `vendor/billion-context/dist/index.js`
- `dsh.bundle.patch.yml` —— 组合层
- `patches/` —— 相对上游 v0.1.213 的 diff
- `scripts/` —— `install.mjs`（装进本机 profile，`--build` 重建本仓库产物）、`restart.mjs`、`smoke.mjs`

`vendor/`、`lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml` 是 `node scripts/install.mjs --build` 生成的，不要手改。补丁本身改了什么，见 [PATCHES.md](PATCHES.md)。

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
