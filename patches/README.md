# patches/

行为要求见 [SPEC.md](../docs/SPEC.md)，当前差异与升级流程以 [MAINTENANCE.md](../docs/MAINTENANCE.md) 为准，实现历史见 [PATCHES.md](../docs/PATCHES.md)。下列命令在仓库根目录运行。

- `outbound-encoding.block.js`：B1，请求体 gzip/br、指令头与回执接口。
- `view-safety.block.js`：B10，完整前缀、摘要有效性与跳过块的尾部覆盖校验。
- `image-retention.block.js`、`image-convention.block.js`、`image-card.*.block.js`：B12–B17，图片折叠、编码、约定与配置页。
- `preflight.block.js`：B22 的有界快照恢复，以及 B19/B21 的预检错误输出；步骤 22 支持按哨兵替换已有块。
- B2–B9、B11、B18、B19、B21 在 `scripts/patch-bili-build.mjs` 定点修改原函数；B20 是客户端 bundle 的改动，在 `scripts/patch-bili-client.mjs`，由 `install.mjs` 合并时施加（幂等）。B4/B8 的最终函数体由 B10 替换。按 B1–B22 完整核对，不能只抄旧版本的某一段。
- `accelerator-ledger.block.js` 与 `accelerator-ledger.legacy.js`：加速器账本兼容补丁及精确旧片段，由 `scripts/patch-accelerator.mjs` 应用；用 `check-ledger-runtime.mjs` 验证资源生命周期。

对选定上游的新构建执行：

```sh
node scripts/patch-bili-build.mjs /path/to/new-bili/dist/index.js
node --check /path/to/new-bili/dist/index.js
node scripts/check-views.mjs /path/to/new-bili/dist/index.js
node scripts/check-image-retention.mjs /path/to/new-bili/dist/index.js
node scripts/check-image-card.mjs /path/to/new-bili/dist/index.js
node scripts/check-upstream-ux.mjs /path/to/new-bili/dist/index.js
node scripts/check-preflight.mjs /path/to/new-bili/dist/index.js
node scripts/smoke.mjs /path/to/new-bili/dist/index.js
```

脚本重复运行支持跳过已有标记；这不等于会同步块文件的后续修改。修改块文件后须从干净上游重打，或写识别旧版的迁移，再检查最终 dist。步骤 6/7 缺锚点目前会打印 skipped，必须检查输出和后续验证，不能只看退出码。

`install.mjs` 在临时副本中应用补丁、运行检查，通过后才替换构建。完整维护使用 `node scripts/check-all.mjs --offline`，宿主检查显式提供 `--host --host-modules <目录>`；两个来源版本、SPEC 全部条款与未覆盖的 DSH 真机行为仍须核对。发布入口见 [RELEASING.md](../docs/RELEASING.md)。
