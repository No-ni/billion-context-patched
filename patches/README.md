# patches/

当前差异与升级流程以 [MAINTENANCE.md](../MAINTENANCE.md) 为准，实现历史见 [PATCHES.md](../PATCHES.md)。

- `outbound-encoding.block.js`：B1，请求体 gzip/br、指令头与回执接口。
- `view-safety.block.js`：B10，完整前缀、摘要有效性与跳过块的尾部覆盖校验。
- B2–B9、B11 在 `scripts/patch-bili-build.mjs` 定点修改原函数；B4/B8 的最终函数体由 B10 替换。按十一步完整执行，不能只抄旧版本的某一段。

对选定上游的新构建执行：

```sh
node scripts/patch-bili-build.mjs /path/to/new-bili/dist/index.js
node --check /path/to/new-bili/dist/index.js
node scripts/check-views.mjs /path/to/new-bili/dist/index.js
node scripts/smoke.mjs /path/to/new-bili/dist/index.js
```

脚本重复运行支持跳过已有标记；这不等于会同步块文件的后续修改。修改块文件后须从干净上游重打，或写识别旧版的迁移，再检查最终 dist。步骤 6/7 缺锚点目前会打印 skipped，必须检查输出和后续验证，不能只看退出码。

`install.mjs` 在临时副本中应用补丁、运行检查，通过后才替换构建。完整维护还需检查包装包、两个上游版本与 DSH 真机行为。
