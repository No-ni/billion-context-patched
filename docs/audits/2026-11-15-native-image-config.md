# 2026-11-15 宿主图片配置误报警修复

## 来源与范围

起点为已发布 0.6.9 的 `90f9db3`，工作树干净。用户仅授权修复宿主将合法图片配置误报为未知键的问题，修复后推送自己的 GitHub，不发版。保留版本 0.6.9，由构建更新 `patchBuild`；不创建标签或 Release，不安装或重启真实插件，不处理其他告警。两个上游来源保持 [维护清单](../MAINTENANCE.md#1-两个来源分别锁定) 所列提交。

## 根因与修复

B16 的代理补丁已登记 `imageRescaleMaxDim`、`imageRetention`、`imageRetentionKeepLastUser`、`imageRetentionMaxDim`、`imagePrompt`，native 宿主却仍使用缺这五键的白名单。宿主告警函数因此误报，实际配置对象没有被删键，代理端图片行为不因该告警失效。

在 `scripts/patch-bili-agent.mjs` 的候选阶段增加同样的五键登记，兼容原始 native 构建与已有 WS 补丁的旧构建。锚点不存在或重复时拒绝返回候选；重复应用不变。由 `scripts/install.mjs --build` 生成正式产物，未手改 vendor。

回归加入现有 `check-upstream-ux.mjs`：从代理和宿主实际构建提取白名单及 `warnUnknownTopLevelKeys` 执行，合法五键不告警，拼错的键仍告警且去重；验证旧宿主迁移与坏锚点拒绝。宿主检查由 installer 替换前和 wrapper 完整包检查执行，纳入既有离线与 CI 流程。

## 条款核对

| 条款 | 结果与依据 |
| --- | --- |
| B16 / IMG-08 | 修复双构建登记遗漏；两个真实告警函数及迁移、幂等、坏锚点由回归检查覆盖 |
| B1–B15、B17–B22 | 保留；代理 `dist/index.js` 字节不变，图片处理、快照、预检及出站流程未修改 |
| W1–W5、W7 | 保留；包装宿主、合并客户端、组合层字节不变；native WS 补丁字节不变 |
| W6 | 保留 0.6.9，只有构建内容标识与时间随生成物更新；不发版是本轮用户明确要求 |
| I1–I2 | 来源不变，通过原有候选生成与检查后替换；native 产物相对起点只新增五个配置键，其余字节完全一致 |
| I3–I5 | 安装、配置迁移、渠道默认及重启逻辑不变；不操作用户运行态，检查资源仍按原流程清理 |
| PCK-01–PCK-05 | 保留；代理、设置页、routing 与优先级逻辑未修改 |

## 验证

- 修复前：新增检查对原宿主构建以 `native agent must accept all five image config keys without warnings` 失败，实际记录了一条误报警。
- `node scripts/install.mjs --build`：通过；包含实际宿主检查、views 29 项、图片 338 断言、preflight 21 组和 storage 18 场景等原有替换前检查。
- `node scripts/check-upstream-ux.mjs vendor/billion-context/dist/index.js lib/client.js vendor/billion-context/dist/agent/dsh-native.js`：通过，含两端配置告警、宿主旧产物迁移与已有 WS 回归。
- 与起点逐字节比较：native 产物只增加五个配置键；代理、合并客户端、包装组合层、上游清单及 build-info 均不变；根清单仅 `patchBuild` 更新。
- `node scripts/check-all.mjs --offline`：13 个入口全部通过；其中 mock E2E 25 场景、0 skip，本地模拟网关 HTTP 60 次、WS 5 次，所有候选子进程、连接和隔离文件已由检查清理。
- wrapper 检查的独立 `--build --out` 连续构建通过，构建标识与时间保持稳定；宿主补丁重复应用字节不变。
- 最终构建标识：`1c41e0429f4254ea9097b60a47ca2900c00017ba1b6bb48803d546cf927477d1`。版本仍为 0.6.9，更新记录放在 Unreleased，不改已发布的 0.6.9 条目。

## 验证边界

本轮使用构建中的真实告警函数与隔离的配置/日志容器，没有启动真实 DSH、调用真实模型或修改用户配置、数据库及已安装插件。消除用户当前进程中的启动告警需要之后实际更新插件；本轮只交付仓库修复。
