# 维护本仓库

本仓库是可独立检出的 `No-ni/billion-context-patched`，插件包名为 `bili-context-patch`。规则、定制要求、来源和操作入口均随 Git 保存；不能依赖聊天记录、外层工作区、某台电脑或某个 AI 的记忆。

## 每次更新、修复、合并或升级前必读

1. 完整阅读 [docs/SPEC.md](docs/SPEC.md)：这是独立修改与既定行为的唯一权威清单，包含 B1–B22、W1–W7、I1–I5 和 PCK-01–PCK-05。
2. 阅读 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)，再按改动范围阅读 [docs/PATCHES.md](docs/PATCHES.md) 和相关 `docs/audits/`。发布另读 [docs/RELEASING.md](docs/RELEASING.md)。
3. 现场核对 `git status`、分支、远端、日志及标签，识别已有用户改动。不得擅自覆盖、回退、暂存隐藏或删除它们。

普通修复按相关条款验证并说明其他条款未受影响的依据；merge、rebase、cherry-pick、PR 合并、复制上游文件或替换 vendor，必须在前后按 SPEC 第 7 节核对全部稳定条款，纯文档合并也不例外。

代码、上游默认或历史说明与 SPEC 冲突时，登记并修复偏差，不能反向改规范迁就代码。需求变更须有用户明确指示或已记录的决定，并同步规范、实现和检查。被上游等价实现替代也保留稳定编号与依据。有已知偏差不得宣称验收通过或发布。

## 文档分工

- `README.md`：稳定项目概览、安装和导航，不手写当前版本或逐版摘要。
- `CHANGELOG.md`：用户可感知的更新，顶部保留 `## Unreleased`；Release 正文从对应版本提取。
- `docs/SPEC.md`：独立修改和行为要求；不另建一份重复清单。
- `docs/MAINTENANCE.md`：来源、环境、实现与检查映射、维护步骤。
- `docs/PATCHES.md`：实现理由、故障分析与被替代的历史方案。
- `docs/audits/`：逐次条款核对、实际验证结果和未覆盖项；历史记录不冒充当前状态。

新增或修改独立行为时同步 SPEC；调整实现和来源时同步维护映射；用户变化记入 Unreleased；证据写入审计。状态以实际 Git/GitHub 查询为准，不维护另一份容易过期的手写状态总表。

## 实现、验证与交付

- `vendor/billion-context/dist/index.js` 只由 `scripts/patch-bili-build.mjs` 修改。`lib/client.js`、`lib/upstream.js` 和根 `dsh.bundle.patch.yml` 由 `node scripts/install.mjs --build` 生成。
- 修改补丁块后，`already patched` 不证明函数体已更新。须从选定干净上游重打或提供旧版迁移，再验证最终产物、字节一致与幂等；锚点命中不等于行为兼容。
- 先构建候选，再检查最终生成物；统一入口为 `node scripts/check-all.mjs --offline`。host 检查显式提供 `--host-modules`，缺依赖必须报告未运行，不能算通过。禁止使用 `--skip-smoke` 绕过发布检查。
- 不要把机器上的配置写成插件默认值；用户明确要求的默认变更须先在 SPEC 决策记录登记。
- `prompt_cache_key` 默认开启是明确需求（B11），不得恢复上游默认关闭，仍须尊重显式 disabled/auto/enabled。
- 生成物随仓库交付，`main` 必须可安装；同版 `patchBuild` 也会触发更新，未准备交付的工作放功能分支。普通拉取用 `git pull --ff-only`，上游合并保留来源历史，不 force push 或改写旧标签。
- 只向用户自己的 `origin` 推送；默认不开 issue、不向上游提 PR、不发布 npm。提交说明用中文，提交前给用户简短审阅摘要；提交、推送、打标签与发布须在当前任务授权范围内。
- 发布准备助手只生成本地候选供审阅，不自动提交或推送。新版本由 GitHub Actions 统一构建、核验附件后公开 Release；失败允许按同一标签重跑。仅提交、推送或有 tag 均不等于发布完成。
- 不因维护仓库就安装或重启用户插件；安装、运行配置、数据库和旧检出按实际任务范围处理。自动检查与实际宿主模块检查均不能冒充真实 DSH、真实模型或网关验证。

## 任务收尾

跟踪本任务启动的所有命令、执行会话、子进程、模拟服务及临时资源，直到明确退出或有意保留。超时、工具异常或中断后核查实际进程；只按精确句柄终止本任务不再需要的进程，不接管用户原有服务。

交付前核对请求完成、检查边界、工作树和远端状态，清理本任务临时资源。仍有运行会话或未清理资源时不得宣称完成；有意保留服务须报告用途、PID、端口、日志和停止方式（能获得时）。
