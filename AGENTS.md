# 维护本仓库

## SPEC 是本项目行为与合并验收依据

- 每次维护先完整阅读 [docs/SPEC.md](docs/SPEC.md)，再阅读 [docs/MAINTENANCE.md](docs/MAINTENANCE.md) 和相关 [docs/PATCHES.md](docs/PATCHES.md)。本文是给后续 AI 维护者的执行入口，不得仅凭历史对话或上游默认判断项目需求。
- **每次合并前后必须检查 SPEC**：包括 merge、rebase、cherry-pick、PR 合并、复制上游文件和替换 vendor；纯文档合并也须核对。按 SPEC 第 7 节执行并记录结果，不能只解决文本冲突就宣布完成。
- **以 SPEC 为准**：代码、上游默认或旧说明与规范冲突时，登记并修复实现偏差；不得静默删功能、改默认或反向改写规范来迁就代码。有已知偏差时不得宣称合并验收通过或发布。
- 改变既定需求必须有用户明确指示或已记录的需求决定，并同步 SPEC、实现、检查和维护记录；用户在本次任务中的明确指示优先，须把新决定写回规范。
- 每次合并的 PR 描述、提交说明或维护记录中，必须覆盖 B1–B21、W1–W7、I1–I5 与 PCK-01–PCK-05，写明来源、保留/等价替代/需求变更/偏差结果、验证证据和未覆盖项。不受影响项可分组，但要说明依据；已通过的自动检查不能冒充真实 DSH 验证。

## 实现与发布约束

- 修改前阅读 `docs/SPEC.md`（已确认的行为要求与验收条件）和 `docs/MAINTENANCE.md`（当前实现与升级流程）；`docs/PATCHES.md` 保存实现细节和历史。用户说明见 `README.md` 与 `docs/USAGE.md`，版本摘要见 `CHANGELOG.md`，逐次核对记录放在 `docs/audits/`。
- 升级按 SPEC 的稳定条款与维护清单逐项核对；实现偏离规范时登记并修复，不能仅因上游或当前代码改变就改写既定需求。行为变更同步规范、实现、检查与维护记录。
- 更新任一上游时，逐项核对 MAINTENANCE 的 B1–B21、W1–W7、I1–I5，记录保留、由上游替代或有意移除的结果。不能因文本锚点仍命中就认定行为兼容。
- 行为改动同时更新当前清单和相应验证；历史方案明确标记被谁替代。不要把机器上的配置写成插件默认值。
- `vendor/billion-context/dist/index.js` 只通过 `scripts/patch-bili-build.mjs` 修改；`lib/client.js`、`lib/upstream.js`、根目录 `dsh.bundle.patch.yml` 通过 `scripts/install.mjs --build` 生成。
- 修改补丁块时，注意 `already patched` 只认标记，不会同步已有构建中的新函数体；须从干净上游重打，或编写可识别旧版的迁移，然后验证最终构建。
- 不用 `--skip-smoke` 绕过发布检查。按 MAINTENANCE 运行相关检查，记录未覆盖的真机验证。文档整理不需要升级运行版本或重启 DSH。
- 本任务启动的命令、会话、模拟服务和临时目录都必须收尾；不得清理用户原有进程或资源。
- `prompt_cache_key` 默认开启是本分支明确需求（B11）；升级不能恢复为上游默认关闭，同时必须尊重显式 disabled/auto/enabled。
