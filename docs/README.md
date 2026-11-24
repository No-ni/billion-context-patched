# 文档目录

安装入口与功能介绍见[仓库首页](../README.md)，版本变化见[更新记录](../CHANGELOG.md)。

| 文档 | 内容 |
| --- | --- |
| [使用说明](USAGE.md) | 安装、更新、默认值、设置与常见问题 |
| [独立修改与行为规范](SPEC.md) | 定制行为的唯一权威清单，维护前完整阅读 |
| [维护与接手](MAINTENANCE.md) | 上游基线、环境、实现/检查映射与升级步骤 |
| [发布流程](RELEASING.md) | 本地准备、提交审阅、CI 核验与失败重跑 |
| [实现历史](PATCHES.md) | 补丁细节、历史方案与测量记录 |
| [自修复记录](SELF-FIXES.md) | 上游尚未修复、由本仓库自行修复的行为，以及合并上游时的复核方法 |
| [客户端关闭语义与失败 arm 估算](audits/2026-11-24-self-fix-abort-arm.md) | B25/B26：终止帧后关闭不再记 abort、OpenAI `finish_reason` 视为终止；失败 arm 估算改为 token 口径 |
| [失效图片预算备份清理与卸载保护](audits/2026-11-22-image-budget-backup-cleanup.md) | IMG-10a 补两项收尾：删除 provider 后清理失效备份条目；宿主已销毁 settings 服务时卸载钩子不再抛错 |
| [宿主退役占位还原与上传超限兜底](audits/2026-11-22-host-offload-restore.md) | IMG-12 把宿主退役占位换回本会话已发出的字节以保住缓存前缀；IMG-13 对上传类 413 强制折叠一次再重发 |
| [重启后定制边界审计](audits/2026-11-22-restart-boundary-audit.md) | 重启后三路复核：字符串内容还原、413 语义与失败回滚、预算异常/并发/卸载边界 |
| [删除自加图片处理](audits/2026-11-21-remove-image-processing.md) | 0.7.5 删除 B12–B15/B17 行为与 IMG-01–09/11，只保留五项 DSH 原生预算注入 |
| [宿主图片配置误报警修复](audits/2026-11-15-native-image-config.md) | B16 双构建白名单、告警行为与旧产物迁移回归；仅推送，不发版 |
| [用量提醒与宿主图片兜底复核](audits/2026-11-18-image-offload-and-nudge.md) | 估算用量提醒 bug 根因、宿主占位适配、引用恢复和本地模拟验证边界 |
| [0.7.0 上游整合审计](audits/2026-11-18-upstream-0.7.0.md) | 固定上游基线、兼容更新、本地定制逐项复核、端到端验证与安装边界 |
| [重复图片引用根因与 0.7.1 本机更新](audits/2026-11-19-duplicate-image-ref-retention.md) | 多 ref 图片导致历史像素回发的本地根因、回归验证与 DSH 安装记录 |
| [同一提醒重复折叠根因与 0.7.2 本机更新](audits/2026-11-19-duplicate-nudge-compression.md) | 一次 T1 提醒后多次独立折叠的根因、并发/partial 防护、隔离验证与 DSH 安装记录 |
| [未指定渠道默认压缩修复](audits/2026-11-20-unspecified-compression-off.md) | B1 默认关闭压缩、保留渠道显式规则、旧构建迁移与离线验证 |
| [连续空工具结果修复核对](audits/2026-11-15-snapshot-tool-seam.md) | 快照拼接误配、连续旧画面复用、零新增范围的预检重建与验证边界 |
| [0.6.9 主线整合审计](audits/2026-11-15-upstream-integration.md) | 固定主线、上游优先与本地保留、SQLite 默认与 WAL 回归、全条款和验证边界 |
| [0.6.9 发布复核](audits/2026-11-15-release-0.6.9.md) | 最终独立扫描、相邻预检修复、本地模拟端到端及发布验收 |
| [0.6.8 上游吸收审计](audits/2026-11-13-upstream-0.6.8.md) | 固定来源、方案取舍、全条款核对、模拟测试、独立扫描与发布证据 |
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
