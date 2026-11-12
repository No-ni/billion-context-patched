# 维护与发布核对：2026-11-12

用户已授权将预检修复及维护方案提交、推送并整理自己的 GitHub 仓库；本轮不安装或重启已安装插件，不修改旧检出、用户配置、日志与数据库。之前的[预检修复记录](2026-11-12-preflight-fix.md)是本地修复阶段的历史状态；本记录接续该阶段。

## 来源与范围

起点为 `9e770a6b48dbe26b24561b28875a858e0feacc0c`（0.6.6）。未合并或升级上游，bili 与加速器仍使用 MAINTENANCE 中的锁定提交。准备分支为 `maintenance/preflight-release`，最终交付以 Git/GitHub 实际状态为准。

- README 保留概览，CHANGELOG 加 Unreleased 并清理内部细节；SPEC 为独立修改唯一清单，AGENTS 强制维护前阅读。
- MAINTENANCE 保留所有稳定 ID 的实现/检查映射，补新电脑环境与参数；PATCHES 管历史，审计管证据，RELEASING 管交付。
- 统一 offline/host 检查、文档完整性和版本一致性检查；CI 先构建再核对最终生成物。
- 本地助手只准备文件；新版本 CI 草稿上传并下载核验后公开，已公开版本重跑不覆盖。
- 0.6.6 缺失的 Release 按原标签补录；0.6.7 按新流程交付。后续实际验证与远端结果补记于本记录。

## 全部稳定条款核对

| 条款 | 结果与依据 |
| --- | --- |
| B1–B7 | 保留；补丁源与运行实现未因维护整理改变，视图/传输检查继续覆盖；B2/B3/B5 真机边界明确保留 |
| B8–B10 | 保留全部旧画面及覆盖拒绝条件，预检恢复不改写引用或放宽渲染；views 与 preflight 检查覆盖 |
| B11、PCK-01–PCK-05 | 保留默认 enabled、显式三档、优先级和页面；映射去重没有删除要求；迁移及幂等证据仍需在最终产物核对 |
| B12–B18 | 保留图片四协议、编码、记账、配置页与 80k 默认；维护表只定位实现，行为继续在 SPEC；图片/页面/视图检查覆盖 |
| B19–B21 | 保留去熔断/去横幅，并随预检修复补齐中文和 retryable；真实上游限流语义保持 |
| B22 | 新增的有界恢复按前阶段记录交付；不循环、不绕过完整性、不直接放行超窗 |
| W1–W5、W7 | 宿主/血缘/客户端/组合层实现未因维护整理改变；offline wrapper 与实际宿主模块检查验证范围明确 |
| W6 | 0.6.7 候选及稳定 patchBuild 随最终构建生成，构建与输出幂等需验证；新发布工具不调用用户更新接口 |
| I1–I4 | 来源、候选检查、迁移及渠道默认未弱化；统一入口仍调用原检查；不访问真实 profile |
| I5 | 重启脚本不变，仅模拟实例检查；临时资源和执行会话须全部收尾，不改用户服务 |

覆盖 34 个功能 ID 与全部 PCK 条款，无上游等价替代、既定功能移除或为迁就实现修改需求。文档结构变化是用户明确要求。

## 验证与交付证据

本地 Node v24.19.0 / macOS 验证通过：

- 21 个维护脚本/新补丁块语法检查；两份 workflow 用内置 YAML 解析器读取成功。
- `check-maintenance`：34 个稳定 ID、16 份 Markdown、88 个本地链接/标题锚点；版本提取器的版本/标签错配、空说明、待发布内容拒绝与稳定版本格式自检通过。
- `node scripts/install.mjs --build` 候选链全部通过；随后 `node scripts/check-all.mjs --offline` 的 10 个脚本全部通过，包含 18 项 views、图片真实 sips 编码、页面/假 DOM、UX、10 组 preflight、三路传输、实例重启模拟和 wrapper。
- `node scripts/check-all.mjs --host --host-modules <任务临时模块目录>` 两脚本通过。实际应用只读提取 32 包、1623 文件、9,441,766 字节并核验 ASAR 内置 SHA256；执行真实 Cordis/Loader/SettingsForms/Storage/DomainFacility/atomic-write，替身边界见脚本开头；临时目录已清理。
- 发布助手在隔离 Git 副本验证：工作树不干净、空 Unreleased、版本不递增、标签错配和缺 host 参数均拒绝；合法的下一版本实际构建并跑完整 offline 链，只准备文件，没有自动 commit/tag/push/publish。隔离副本已清理。
- 打包助手生成的 ZIP 只包含标签已提交文件，根目录、清单、版本和 dist 字节核对通过；SHA256SUMS 正确，重复生成字节一致；附件目录被忽略。隔离副本及产物已清理。
- 独立 `--build --out` 的 package/dist/client/upstream/组合层与根最终产物逐字节一致，根文件未变；从 v0.6.5 和 v0.6.6 迁移至最终 dist 均字节一致，二次应用幂等，临时目录已清理。

本轮 package 增加维护入口及 Node 支持范围，最终 `patchBuild.id` 为 `4098655f8b7cf21ae0f9bbac06b31c740d1aa5824fc1327c7e027293a26c5ab5`，`createdAt` 为 `2026-11-12T10:10:53.848Z`；最终 dist SHA256 仍为 `6f8385a28f85c0f315b8b6600fc631236223366bb8d3b226c1d1b46908ccd5a6`。前阶段审计的旧 patchBuild 是当时证据，不是另一份当前版本来源。

## GitHub 核对证据

- 修复和维护提交 `0a8c8c92b2e435b20f5f50e2c170b77966571d1e` 已推送维护分支。[检查 43199221589](https://github.com/No-ni/billion-context-patched/actions/runs/43199221589) 成功，Ubuntu Node 22/24、Windows Node 24、macOS Node 24 四个组合全部完成。随后仅补充接手与交付证据，不修改已通过的运行实现。
- [v0.6.6 Release](https://github.com/No-ni/billion-context-patched/releases/tag/v0.6.6) 已从原提交 `9e770a6b48dbe26b24561b28875a858e0feacc0c` 一次性补录；旧标签未移动，ZIP 清单与版本/dist 均按旧提交核对。草稿上传后重新下载，ZIP 与本地产物字节一致，校验和为 `532c7bba9888b013c3980870057499e08019f721f404ec06ec5717b5af133e7b`，确认非草稿且包含 ZIP/SHA256SUMS；未把该历史版本设为 Latest，临时打包/下载目录已清理。
- 0.6.7 的正式交付入口为 [v0.6.7 Release](https://github.com/No-ni/billion-context-patched/releases/tag/v0.6.7)。最终版本标签、main 提交及工作流完成状态按 [RELEASING.md](../RELEASING.md) 查询 [Actions](https://github.com/No-ni/billion-context-patched/actions)，不另维护一份会过期的状态清单；仅有提交或 tag 不能宣称已发布。

真实 DSH 冷加载/切模型、浏览器操作、真实摘要/模型、网关重试与缓存命中不在本轮自动检查范围内。已安装插件及旧检出不随仓库发布自动升级。
