# patches/

我们对 bili 构建做的改动。构建本身来自上游源码（`npm ci && npm run build`），这里只放改动。

- `outbound-encoding.block.js` —— 第 1–4 节那一整块代码（出口压缩、`x-accel-compress` 指令、回执环、`GET /__bili/encode-stats`）。它是一行很长的 JS：构建产物是单个 bundle，插进去的代码也必须能在这份 bundle 顶层直接跑（用模块顶层的 `require` 取 `node:zlib`、`node:fs`）。
- `view-safety.block.js` —— 完整前缀、旧摘要有效性与跳过块的消息覆盖校验。
- 其余改动（快照渲染开关、fork 首轮借用父会话记录）不是独立文件，而是对已有函数的定点改写，见 `scripts/patch-bili-build.mjs` 第 2、3 步。

打补丁：

```sh
node scripts/patch-bili-build.mjs path/to/dist/index.js
node scripts/smoke.mjs path/to/dist/index.js
```

脚本是幂等的：已打过的步骤会跳过；锚点对不上会报错退出，不会写出半个补丁。`scripts/install.mjs` 在每次安装后自动跑一遍。
