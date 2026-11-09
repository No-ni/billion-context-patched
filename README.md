# bili-context-patch

[billion-context](https://github.com/ranxianglei/billion-context)（命令名 `bili»）的自维护构建，基线 **v0.1.212**，MIT 许可。

相对上游，这个包多带一个[模型请求加速](https://github.com/No-ni/dsh-plugin-model-request-accelerator)插件：压缩请求体、预传输共享对话历史，并给出每次请求的耗时面板。两样东西装在一起，所以「设置 → 插件」里只多一张 `bili-context-patch»；bili 面板与「模型请求加速」两个设置页照旧各管各的。

## 安装

```sh
node scripts/install.mjs
node scripts/restart.mjs
```

装完重启 DSH。脚本默认取 `~/.dsh/profiles/desktop» 这个 profile 里已装的 bili 作为源码，也可以用 `--profile» 换 profile、用 `--bili <路径>» 指定 bili 的位置。

## 卸载

```sh
dsh plugin --profile desktop remove bili-context-patch
```

插件目录 `plugins/bili-context-patch» 会留在磁盘上，想清理直接删掉即可。

## 目录

- `dist/index.js» —— 这个仓库替换的 bili 构建产物
- `package/» —— 包装包源码：主机入口、客户端模板、包清单
- `scripts/install.mjs» —— 安装脚本（生成插件目录并接线到 profile）
- `patches/» —— 相对上游 v0.1.212 的 diff

## 版本

版本号是 `package/package.json» 里的三位 semver，发一版把最后一位加一。设置 → 模型请求加速 页面底部那行「检查更新」查的就是这个仓库。
