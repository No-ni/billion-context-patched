# 维护本仓库

- 修改前阅读 `MAINTENANCE.md`（当前差异与升级流程）；`PATCHES.md` 保存实现细节和历史。
- 更新任一上游时，逐项核对 MAINTENANCE 的 B1–B11、W1–W6、I1–I5，记录保留、由上游替代或有意移除的结果。不能因文本锚点仍命中就认定行为兼容。
- 行为改动同时更新当前清单和相应验证；历史方案明确标记被谁替代。不要把机器上的配置写成插件默认值。
- `vendor/billion-context/dist/index.js` 只通过 `scripts/patch-bili-build.mjs` 修改；`lib/client.js`、`lib/upstream.js`、根目录 `dsh.bundle.patch.yml` 通过 `scripts/install.mjs --build` 生成。
- 修改补丁块时，注意 `already patched` 只认标记，不会同步已有构建中的新函数体；须从干净上游重打，或编写可识别旧版的迁移，然后验证最终构建。
- 不用 `--skip-smoke` 绕过发布检查。按 MAINTENANCE 运行相关检查，记录未覆盖的真机验证。文档整理不需要升级运行版本或重启 DSH。
- 本任务启动的命令、会话、模拟服务和临时目录都必须收尾；不得清理用户原有进程或资源。
- `prompt_cache_key` 默认开启是本分支明确需求（B11）；升级不能恢复为上游默认关闭，同时必须尊重显式 disabled/auto/enabled。
