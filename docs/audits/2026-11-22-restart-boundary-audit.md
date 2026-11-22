# 重启后定制边界审计（2026-11-22）

用户重启 DSH 后要求继续排查定制功能未覆盖的场景与边界，并核查日志。本轮只读审计分三路：图片还原（IMG-12/13）、预算写入（IMG-10a）、真实运行日志。结论全部落到实现与检查，未发现需要恢复已删除图片功能的新证据。

## 运行态基线

- DSH 2.0.24-next，host pid 38791，2026-11-22T07:29:38Z 启动；插件 entries 217 / active 187 / failed 0。
- 代理 pid 33646 跨宿主重启存活，监听 127.0.0.1:18800；实例 a86ac47b-50d8-4a92-a023-e7d01b65edfc；/__bili/status 版本 0.1.216、commit 548e396、storage/integrity ok、conflicts 全 0、snapshotShadow enabled。
- 备份文件启动后只剩 `ylinkimi`、`test` 两条，各三字段带 `name`；四个空 provider 没有回流；当日 `SETTINGS_CONFLICT` 为 0（最后一条在 2026-11-21T19:44:44Z）。
- 代理日志中 `image-restore` 与 `upload-413` 触发数均为 0，说明这两条只在隔离 mock 中验证过，真实流量尚未覆盖；不能把离线结果当作真实链路验收。

## 发现与修复

### P0 IMG-12 在 OpenAI Chat 主路径失效

宿主 `llm-pi-ai/src/context.ts:96` 在只剩文本时把 blocks 用 `join("")` 合并成字符串。旧实现只遍历数组，字符串里的占位永远不会被替换；e2e 用数组请求绕过了这个真实形状。修复为按占位切分字符串、用 token 取回缓存条目、保留当前文本与 `<acp …>` 引用后重建数组。同步加入 256 MiB 全局缓存上限。

### P1 IMG-13 泛化标记与失败记账

- `request_too_large` 被 `CONTEXT_OVERFLOW_PATTERNS` 判为溢出，旧分支又要求 `!overflowInfo.isOverflow`，因此上传类 413 走不进兜底；中文“请求体过大/上传超限”也不匹配。现在分支接受“具体上传措辞”，或“泛化 `request_too_large` 且解析不到上下文窗口”；中文文案加入正则。
- 两次重发失败后，`stats.requests` 仍增加 1～2，且 `pendingForward.prepared` 已被折叠后的视图替换。新增 `overflowRefold.reset`，失败时恢复原始 body/prepared/requests，成功才保留计数。

### P1 IMG-10a 预算异常路径

- 配置 JSON 解析失败会让整轮 `flush` 中止，坏文件存在期间永久停写；现在回退内建默认值并只告警一次，修复后 watcher 自动续写。
- 单条路由的非冲突错误会结束整轮，后续 provider 饿死；现在逐路由捕获，只有该路由失败。
- 销毁与在途 `mutate` 竞态会留下未记录备份的预算值；现在卸载先等 flush 结束再恢复。
- 备份损坏会静默清空、下一次写入覆盖证据；现在改名 `.corrupt-<时间戳>` 并告警。备份写回改为读-合并-唯一临时文件-rename，删除只删本进程记录的键，避免同 HOME 多进程互相覆盖；写失败不阻断预算，`unlink` 失败不再产生 rejected promise。

### P2 B16 native 注册表缺开关

代理构建已登记 `imageRestoreHostOffload`，native agent 的 `KNOWN_TOP_LEVEL_KEYS` 只有五项预算键，真实构建会对该开关报未知键。补登并把上一版五项 patched 串作为 legacy anchor 迁移。

## 验证

- `node scripts/check-image-budget.mjs`：24 项通过。新增坏配置回退并恢复、单路由失败不阻断、在途写入时销毁仍恢复并删除备份。
- `node scripts/check-e2e-mock.mjs --bili <candidate>`：29 项通过、0 跳过。新增字符串合并内容还原、泛化 `request_too_large`、中文“请求体过大”三种 413。字符串断言忽略 accelerator 的 `<acp …>` 引用差异，比较可见文本与图片结构。
- `node scripts/check-upstream-ux.mjs`：通过；native 配置样例六键、旧五项注册表迁移与幂等均覆盖。
- 反向验证（各删除一处后复跑，均 exit 1）：字符串分支改成返回零结果，e2e 以 `the joined string must regain the cached text and image parts` 失败；effect 的 idle 等待改成直接恢复，预算检查以 `the in-flight profile must be recorded and restored, not leaked` 失败；逐路由 catch 改成重新抛出，预算检查以 `timed out while applying native image budget` 失败。
- `node scripts/check-all.mjs --offline`：exit 0，13 个脚本全量通过；`check-maintenance` 为 48 个稳定 ID、31 份文档、137 条本地链接，预算检查 24 项，mock E2E 29 项（0 跳过，gateway HTTP 61 / WS 5），preflight 21 项，storage 19 项，outbound-encoding 47 项，smoke 3 项。
- 安装：`node scripts/install.mjs` exit 0，写入 `~/.dsh/profiles/desktop/plugins/bili-context-patch`；安装副本与工作树逐字节一致：`dist/index.js` sha256 14799caa708000690c56533220ef74762a1e64748e999dfa93472903c9333178，`dist/agent/dsh-native.js` sha256 a221d5e64984aadaf4efa45e688002a84fe06b54dfd44ac9ecf566bd742ef65c，`lib/defaults.js` sha256 b6c82c6199dc677aa5cfc9de0e2d316b596261522d36dc20c3f7684491e2fc13；版本仍为 0.7.5。
- 代理：`node scripts/restart.mjs` 停掉旧 pid 33646，新进程 pid 43671 监听 127.0.0.1:18800，health/status 正常；重启后真实请求日志首次出现本构建的 `[image-restore] 2 host image placeholder(s) had no captured wire bytes; left as text`，说明还原代码已在运行，但缓存随进程重启清空，旧占位没有可还原字节属于预期。
- 宿主尚未重启：正在运行的 2.0.24-next 仍加载安装前的 `lib/defaults.js` 与 native agent，IMG-10a 的异常路径与六键注册要等用户重启宿主后才在真实进程生效；代理侧新构建（含 IMG-12 字符串还原与 IMG-13 回滚）已生效。

## 边界

- Responses WebSocket 不经过 `__biliRestoreHostOffloads`，本轮未改；该 lane 当前无图片历史。
- “先还原、后按 10 MiB 总量重新换占位”的顺序未改，只在超大请求出现；没有真流量证据时不动。
- 代理 DNS 解析陈旧、宿主重启时双实例共用会话库、会话库 864.8 MiB 属于上游/运行拓扑，不在本补丁范围。
