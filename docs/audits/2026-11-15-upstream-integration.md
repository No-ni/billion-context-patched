# 2026-11-15 主线整合审计（0.6.9 候选）

## 来源与范围

用户授权：尽可能保持主线功能，整合自己的修改和优化；主线已等价修复时采用主线。正式检出起点为 `fix/snapshot-tool-seam` / `c8ca141`（0.6.8），工作树已有第 29 节的 0.6.9 超窗修复及维护记录，本次完整保留。先复制这些未提交内容到隔离候选，再构建适配；没有暂存、回退或覆盖用户原有改动。

- bili 从 `0d94a8a240fa0f7648f84032b03150f6b1891167` / kernel 0.0.196 升至固定主线 [`e7a42babec704a80678ca84eb4b4110273d3b993`](https://github.com/ranxianglei/billion-context/commit/e7a42babec704a80678ca84eb4b4110273d3b993)，manifest 0.1.214、kernel 0.0.198。已发布 v0.1.214 标签是 `c26e001b6c4b0968f1efd703bfeaa9d745de5a56`，不能把本候选误写成只吸收该发布标签。
- 采用完整已检查主线，保留成组修复的依赖，随后冻结来源，不在适配中追逐新的 master。
- accelerator 仍为 2.3.0 / `e8c30af1f2b5cffa6749d032f0f296e17d4e26d0`，远端没有新增提交；既有账本生命周期补丁保留。
- 上游 tarball SHA-256：`af4815217ac528c60d1a328d3cfbdd4de33df2db92fe494aeb1682dd928148e4`。随后取得同一 Git 提交，源码工作树干净。Node v24.19.0、npm 11.17.0 执行 `npm ci --no-audit --no-fund`（618 个依赖）和 `npm run build`，build-info 为 `e7a42ba`。
- 只交付 DSH 包装包选定的七个来源文件；代理/native/client 通过现有补丁器，根 client/upstream/组合层通过 installer 生成。没有安装、重启真实 DSH、修改配置/数据库、提交、推送或发布。

## 采用与保留的依据

| 范围 | 决定与依据 |
| --- | --- |
| 零折叠校准与图片预算 | 采用主线 `f75e45f2874f64dbb1548bd0d783ee694b8463ad`、`87082004b017fa00490cd4aa160f5a935f940717`；与本地零新增范围重建互补 |
| 增量重复内容身份 | 采用 `19ba8ad0968966b9d715b9011178e47624c3d4bf`；包含 occurrence ID 延续与 cacheControls 对齐，不能取代快照 seam 的 toolCallId 校验 |
| BLOCKED 伙伴合并 | 采用 `399cd2b8c0b1370a12a4a791dbfa2dd1fef9a0f6` / kernel 0.0.198；内容已移除的伙伴可合并，活工具/媒体保护仍在 |
| writer-off 性能 | 采用 `f87c45b3c354b40db377ae07d70fa9561b270520` 和修订 `274ead0f1bd5a15eb8cb611c2445c4b0233d9e2b`；保留严格失效和单次消费，不单挑第一版 |
| 存储默认 | 按本轮用户授权采用 `5a80e2b8eaee5758b166d434dd6bdde4dadc42c7` 的纯 SQLite 默认；显式 full 默认双写，显式 writer 优先；SPEC 第 9 节登记 |
| 工具失败与断流诊断 | 采用主线首行 FAILED 判断及诊断只进本地日志；更新实际函数检查，证明正文引用不误报、错误首行仍失败、日志诊断未丢 |
| 本次超窗故障 | 上游 signature 仍缺 toolCallId，且没有等价 sticky 推进/零范围重建；保留 B8/B10/B22 三项修复、完整前缀/摘要校验、8 条单轮上限和拒绝条件 |
| WAL 识别 | 原 helper 对真实 WAL 的 2,2 头返回 false；在共享 helper 修复为 100 字节有限读取和 finally 关闭，加入最终产物回归；不声称旧判断必然导致启动失败 |

其他主线协议、工具轮次、Responses 媒体归属、长历史参数安全与存储改进保留在完整构建中，未记作本地原创功能。具体实现历史见 [PATCHES 第 30 节](../PATCHES.md#30-2026-11-15保留主线功能的整体整合069-候选)。

## 全部稳定条款核对

“保留”表示实现和相应自动范围通过，不代表真实 DSH/网关验收；人工边界仍按 SPEC / MAINTENANCE 明示。

| ID | 合并后结果与证据 |
| --- | --- |
| B1 | 保留；off/gzip/br、头所有权、重放和回执；37 组编码、107 次 localhost 发送及 E2E |
| B2 | 保留插件道标记与 live/shadow gate；预检开关回归，真实开关联动未测 |
| B3 | 保留父记录首轮借用；真实候选 fork/保存/冷恢复 E2E |
| B4 | 保留首次 pin、子 pin 与 8 条上限；views 的前缀编辑/一次性/表上限 |
| B5 | 保留原诊断标记控制的 helper；补丁体一致性及差异检查，实际落盘开关未测 |
| B6 | 保留父有效 key 的多代继承及 512 上限；views 和 E2E 父子请求 |
| B7 | 保留 proven prefix、子时钟、克隆与持久化；适配 fork 局部别名，views/native E2E |
| B8 | 保留本轮成功推进 sticky pin 的修复；连续多轮与推进后重新校验仍通过 |
| B9 | 保留最新缺行有限例外；老块、单块和部分缺行拒绝仍通过 |
| B10 | 保留完整 digest、摘要布局指纹、toolCallId 和 WS 覆盖；相同空结果回归及生命周期 E2E |
| B11 | 保留默认 enabled 与显式三档；PCK-01–05 分项见下 |
| B12 | 保留只发一次、四协议/工具回图/原图取回；图片专项与 E2E |
| B13 | 保留三平台系统编码器；本机 macOS 实际编码通过，其余平台本次未运行 |
| B14 | 保留恒定图片约定及开关；图片专项 |
| B15 | 保留请求独立回执及成功后记账；并发、失败、变换、gzip 和循环 E2E |
| B16 | 保留配置键登记与环境覆盖；图片专项 |
| B17 | 保留 Web 图像卡；整页解析与假 DOM 交互，真实页面未测 |
| B18 | 保留 80000 floor/cap、页面默认与双语提示；views/image-card |
| B19 | 保留不自行熔断；重复失败仍为中文 502、健康重试成功的 E2E |
| B20 | 保留合并客户端去横幅；真实工厂检查与幂等，实际 shell 未测 |
| B21 | 保留中文和 413/502/协议契约；采用主线首行失败与本地诊断日志边界；实际 HTTP/SSE/WS/reader/codec/side 分支 |
| B22 | 保留一次有界保存恢复、暂时 miss 状态保护及零新增范围重建；19 组预检及真实 SQLite 读故障/计数 E2E |
| W1 | 保留三子插件组合与 Config/活访问器；host runtime，实际单卡 UI 未测 |
| W2 | 保留完整客户端工厂合并与注入并集；installer 和完整 --out 一致性 |
| W3 | 保留 compaction-basic、四 preset gate、两 retryPolicy；最终层与来源去除 insert 后语义相同，仅添加包装 guard |
| W4 | 保留冷/热两种加载顺序、迟到账本释放与销毁；wrapper 和实际 host Loader/ledger |
| W5 | 保留并发 fork 父关系、非 seeded 和恢复；wrapper/host runtime/native E2E |
| W6 | 保留版本入口、同版构建识别和更新串行；wrapper，重复构建元数据稳定 |
| W7 | 与 B17 同一实现；没有新增独立配置接口 |
| I1 | 七文件同一固定来源；自带 YAML/Zod、显式来源；WAL 和存储默认检查通过 |
| I2 | 候选检查后替换；坏 WAL/fork 锚点失败不写，installer 不兼容输入不替换；不声称多文件事务化 |
| I3 | 保留 YAML/旧配置、disabled、锁/并发/备份/失败重载行为；wrapper/host runtime |
| I4 | 保留两主机逐字段补缺与显式设置；wrapper/实际 SettingsForms |
| I5 | 自动检查自己启动的进程与 socket 均退出；未动用户服务；真实代理重启未运行 |

PCK-01：默认 enabled、环境先选再解析以及坏/空值回落的配置加载逻辑保留，解析函数组合表通过。PCK-02：显式 disabled/auto/enabled 保留，wrapper 重装/配置保留通过；网关缓存命中未测。PCK-03：页面缺省选中 enabled、中英文默认文案与显式三档通过。PCK-04：从选定干净来源重打，与最终产物相同，二次应用不变，不兼容锚点失败且不写。此次换源通过完整七文件重建，未把旧基线二进制原地迁移冒充新上游构建。PCK-05：最终候选 views、预检、完整 offline 及构建一致性证据全部保留。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 固定源码构建及 TypeScript 检查 | `npm run build`、`tsc --noEmit --project tsconfig.json` 通过；源码保持干净 |
| 上游定向检查 | 15 文件、88 项通过，0 skip；覆盖 preflight 校准/图片/压缩、增量身份、writer-off/dedup、水位、工具顺序、媒体和存储 |
| 上游 kernel BLOCKED 合并 | `issue5919-shredded-merge.test.ts` 8 项通过，0 skip，包括 content-free 与活工具/媒体 lockstep |
| 最终候选专项 | views 29 项、preflight 19 组、图片 338 assertions、storage 18 场景通过 |
| 完整 offline | 13 入口通过；含 37 编码组/107 次 localhost 发送 |
| 完整模拟 E2E | 25 项通过，0 skip；HTTP 60、WS 5；默认 SQLite 冷恢复、显式 legacy/shadow/full、坏 KV 回退及在线备份全部通过 |
| 实际宿主模块 | 从应用 ASAR 只读提取有限 15 包/1268 文件，runtime 与 ledger-runtime 两入口通过；模型/持久化介质/路由仍有替身 |
| 重打和幂等 | 干净来源重打与最终七文件相同；service/native/client 二次应用不变；改坏 WAL 和 fork 锚点均失败且原输入不变 |
| 重复构建与独立 out | 重复 build 的包元数据保持，独立 --out 的 212 文件逐字节相同，显式外部来源未被改写 |

代理 SHA-256：`c2c87c15ff3de3949558fd47a7b6b9c2165f5563c0f915101e3ade310fd1adbb`。native SHA-256：`6bce0923f4f4b68fac42f9654d30404223cac6994844e3efe95488c9d053e654`。构建标识和时间以根 package.json 的 patchBuild 为准；源码/最终七文件哈希与完整日志另留本次交付证据，不复制用户会话内容。

维护检查已纳入 `check-storage.mjs`；installer 替换前、统一 offline、PR 和 release CI 沿用同一检查链。断流诊断用“日志仍含完整 diag + SSE 不含 meta”的等价检查代替旧的 meta 外发断言；保留中文/终止事件。其他历史用例未删除、未跳过，也未降低 seam 或覆盖拒绝条件。

## 覆盖边界与交付状态

本次完成的是本地候选整合，不是发布或装机。未运行真实 DSH 的单卡/开关/热重载/页面交互、真实冷加载或切模型、真实模型/网关/缓存命中；本机为 macOS/Node 24，其他平台与 Node 22 留待既有 CI。上游完整测试矩阵未运行；本次上游证据是定向源码检查，包装包完整离线检查则针对最终产物。

没有已知未修复的 SPEC 偏差；未覆盖的集成边界不冒充通过。换源没有删除已有数据或副本，也不承诺在原文永久不可读、历史持续超过窗口时仍能发送。正式工作树的更新与任务临时资源收尾完成后才交付，禁止凭候选通过就宣称发布完成。
