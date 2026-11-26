# 折叠后被裁剪的常驻尾巴（2026-11-26，B27 重写）

## 现象

`session-6a2bbccf` 一天内三次折叠（10:55、11:21、11:52），每次折叠后的第一条请求都发出未压缩历史：

- 10:55:33 `request: 201 msgs, inbound=777.8KiB, outbound=789.8KiB`，上游回 `[acp-usage] input=217755 cached=20480 (cache hit 9%) fold=new`；
- 11:21 与 11:52 同形，后者 `input=577173 cached=404608`，距 700K 窗口已用 82%。

同会话日志：`[snapshot-render] legacy fallback (block-unanchored)` → `[snapshot-recovery] re-prepared once; rendered=false` → 原文发出。

## 排查方法

不改代码，直接查最终状态数据库 `~/.local/share/billion-context/sessions/index.db`：

1. `blocks.payload_json.effectiveMessageIds` 取块覆盖的 id；
2. `messages`（`retired_at IS NULL`）取全量行 id；
3. `sessions.tail_json` 取渲染实际使用的尾巴指针；
4. 分别求交集。

## 读数

| 对象 | 数值 |
| --- | --- |
| 块 b1 覆盖 | seq 5–272，260 id |
| 全量 transcript 命中 | 259 / 260（1 个 retired） |
| 尾巴指针命中 | **0 / 260** |
| 该会话指针 | `tailFolded=true`，`tailSeqs=[268,372,373,374]`（4 条），全量行 379 条 |
| 对照会话 6a2bbccf | `tailFolded=false`，指针 1563 条，块命中 1331/1332，渲染正常 |

结论：id 从未失效，失效的是渲染所用的行窗口。`loadTranscriptBase` 用「全量行 ∩ 尾巴指针」作行集合；折叠提交调用 `foldResidentTail` → `boundedFoldedSnapshot` 把常驻尾巴裁到预算内并置 `lastMessagesFolded=true`，指针因此不再覆盖块区间。

日志规模：`block-unanchored` 526、`sticky view` 498、`legacy fallback` 18、`active` 4。0.8.1 的区间兜底 `seq-anchor` 全程 0 次——它读的是同一份 4 行，闸门 `>= expected/2 = 130` 必然拒绝。

## 修法

步骤 9b 重写：`lastMessagesFolded === true` 或 `tailSeqs.length * 2 < 全量行数` 时，渲染行集合改用全量 `unifiedMessageIdRows`；块锚定、区间计算、未覆盖尾巴都从同一行集合得出。健康会话（指针即全量）行为不变。删除 `__biliSeqAnchor` 及其闸门，脚本保留迁移分支（检测到助手函数即剥离并恢复调用点）；保留 base id 比较。

## 验证

- `node scripts/check-views.mjs`：33 项通过，新增「折叠尾巴渲染全量」「仅指针裁剪渲染全量」两项；原有 base 口径用例仍通过。
- 对 HEAD 旧构建重打：`git show HEAD:vendor/billion-context/dist/index.js` → 新脚本 → 与仓库产物 `cmp` 一致（sha256 `db0d2424e3fb7ba473a7ebee0de2706e5f0a707752e96dafc3e3e55b570d0de4`），二次运行字节不变，无 `__biliSeqAnchor` 残留。
- 待真机：下一次折叠的首条请求 outbound 应回到 170–200KiB 量级，且不再出现 `block-unanchored`。

## 未覆盖

- 真实网关缓存命中是否恢复（要看折叠后首条的 `[acp-usage]` 行）。
- `pluginSnapshot` 非空时的 pin 复用路径未改。
- MySQL 后端的 `tail_json` 形态未验证。
