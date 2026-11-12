# 文档目录

安装入口与功能介绍见[仓库首页](../README.md)，版本变化见[更新记录](../CHANGELOG.md)。

| 文档 | 内容 |
| --- | --- |
| [使用说明](USAGE.md) | 安装、更新、默认值、设置与常见问题 |
| [独立修改与行为规范](SPEC.md) | 定制行为的唯一权威清单，维护前完整阅读 |
| [维护与接手](MAINTENANCE.md) | 上游基线、环境、实现/检查映射与升级步骤 |
| [发布流程](RELEASING.md) | 本地准备、提交审阅、CI 核验与失败重跑 |
| [实现历史](PATCHES.md) | 补丁细节、历史方案与测量记录 |
| [维护与发布核对](audits/2026-11-12-maintenance-release.md) | 文档分工、统一检查、CI 与本轮交付证据 |
| [0.6.5 修复核对](audits/2026-11-12-bugfix.md) | 该轮修复的逐项证据与验证边界 |
| [0.6.5 发布核对](audits/2026-11-12-release.md) | 仓库整理、发布检查与交付结果 |
| [熔断与横幅移除](audits/2026-11-12-upstream-ux.md) | B19–B21：去熔断、去上游横幅、失败文案中文化（0.6.6） |
| [预检超窗审计](audits/2026-11-12-preflight-compression.md) | 0.6.6 的故障证据、原分析修正与修复边界 |
| [0.6.7 预检修复核对](audits/2026-11-12-preflight-fix.md) | 有界快照恢复、重试标记、四协议报错与验证范围 |

维护者先阅读根目录 [AGENTS.md](../AGENTS.md)，再按规范检查。文中的代码路径和命令均相对于仓库根目录。

## 代码目录

| 路径 | 用途 |
| --- | --- |
| `lib/` | 包装包宿主代码及合并客户端 |
| `vendor/` | 选定的上游运行文件与 YAML、Zod 解析器 |
| `patches/` | bili 补丁块与加速器账本兼容片段 |
| `scripts/` | 构建、安装、重启和验证脚本 |
| `dsh.bundle.patch.yml` | DSH 插件组合层 |

运行文件和生成物随仓库提交，插件管理器安装后即可加载。生成物的修改规则见[维护流程](MAINTENANCE.md#4-修改文件时的来源规则)。

## 第三方来源

billion-context 与模型请求加速器的基线见[维护说明](MAINTENANCE.md#1-两个来源分别锁定)。内置解析器的分发范围及许可分别见 [YAML](../vendor/yaml/SOURCE.md) 和 [Zod](../vendor/zod/SOURCE.md)；本仓库许可见 [LICENSE](../LICENSE)。
