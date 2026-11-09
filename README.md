# bili-context-patch

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili`）的自维护构建，基线 **v0.1.212**，MIT 许可。

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

- `lib/` —— 主机入口（`index.js`）、客户端合并包（`client.js`）、上游转发（`upstream.js`）
- `vendor/` —— 两个上游的源码副本，自包含，不依赖 profile 里的其他包
- `dsh.bundle.patch.yml` —— 组合层
- `dist/index.js` —— 这个仓库替换的 bili 构建产物
- `scripts/install.mjs` —— 安装/重建脚本：默认写进本机 profile；加 `--build` 则重建本仓库里的产物
- `patches/` —— 相对上游 v0.1.212 的 diff

`vendor/`、`lib/client.js`、`lib/upstream.js`、`dsh.bundle.patch.yml` 都是 `node scripts/install.mjs --build` 生成的，不要手改；上游升级后重建一次并提交。

## 版本

版本号是根目录 `package.json` 里的三位 semver，发一版把最后一位加一。设置 → 模型请求加速 页面底部那行「检查更新」查的就是这个仓库。
