# 2026-11-19：重复图片引用导致历史图回发

## 结论

缓存接缝由本地图片折叠跳过造成，不是本次调查范围内的上游缓存丢失。已成功发送的图片仍在 `biliImageSeen` 中，但同一媒体在会话中有多个 ref 时，上游 `refForItemBytes` 按其保守契约返回 `undefined`。`biliRetentionApply` 只有拿到可取回 ref 才会将已看过的图片折叠，因此旧历史恢复为内联像素，并改变出站中段。

## 事故证据

- 报告中 `m01429` / `m01595` 的媒体哈希一致、均为 24,936 字节；`m01431` / `m01601` 的媒体哈希一致、均为 79,316 字节。它们是相同图片字节的多 ref，不是不同内容的哈希碰撞。
- #493 与 #494 的出站差异位置由 356.6 KB 后移至 381.5 KB，约增加 24.9 KB，与第一组重新出现的图片大小相符。
- debug 日志中图片折叠数从 12 降到 11、再到 10；出站体积随之增加。后续不再出现新的重复图片后折叠数稳定在 10，报告 #495 的命中率回到 99.1%。
- 11:27 前后没有 `acp_read_original_image` 调用；日志中唯一一次调用为 09:17 对 `m00002` 的读取。这排除了这些接缝由模型主动取回图片触发的解释。
- 仓库既有回归把“多 ref 对应相同原图”作为拒绝折叠的场景，未覆盖折叠路径可以安全选用一个经验证 ref 的情况。

## 修复与边界

`biliRetentionResolveRef` 只供本地折叠路径使用。它按 ref 字符顺序逐个调用上游 resolver，并只验证每个 ref 的首条存储记录；该首条记录正是原图工具实际读取的条目。只有 MIME、字节长度和完整 base64 内容都通过上游 resolver 校验时，才采用该 ref。无索引时仍沿用原 resolver；不可读、失效或不匹配的候选仍保留原图。

通用 `refForItemBytes` 未修改，压缩路径仍保持其原行为。IMG-03 最后一条普通 user 图片豁免按消息位置保留：同一请求中的旧图折叠，当前上传仍保留像素，后续再追加消息时这张图才折叠。IMG-11 宿主 SHA-256 回填的唯一映射要求也未放宽。

## 验证

- `node scripts/install.mjs --build`：候选构建通过，图片保留检查 345 项断言通过，宿主图片兜底与其它构建 smoke 检查通过。
- 修复最初以 `0.7.0` 候选构建验证，`patchBuild.id` 为 `dab7a97f88d1366c65234353b79da6948572724c4abf78129e46555a4ac819fd`；该构建 bili bundle SHA-256 为 `f3a7ece60c6848ba7308d1ec281d00db8893768412ff4aeec7cddb6f49640053`。随后用户明确要求本地升为 `0.7.1` 并安装到 DSH，最终安装状态见下节。
- `node scripts/check-all.mjs --offline`：15 个检查入口通过；mock E2E 25 项通过，使用 localhost 模拟网关完成 60 次 HTTP 与 5 次 WS。E2E 清理确认子进程退出、socket 关闭、隔离文件移除。
- 回归序列覆盖首次成功记账、追加相同图片、再追加普通 user 消息；并核实旧图先折叠、最后用户图片豁免、下一请求不重新展开、引用选择稳定且工具能读回原字节。上游 resolver 仍对多 ref 直接返回 `undefined`。
- 根因修复初次验收时未运行 host modules、真实 DSH、真实模型或外部网关缓存验证；也未安装、重启、提交、推送、打标签或发布。之后仅获准本地升版并安装，不因此扩大真实模型/网关验证范围。

## 0.7.1 本机安装

用户明确授权以 `0.7.1` 更新默认 profile。先将包装包版本和 CHANGELOG 设为 `0.7.1`，再执行候选构建、离线门禁和显式 profile 安装。

- 安装命令：`node scripts/install.mjs --profile /Users/senno/.dsh/profiles/desktop`；成功，profile 依赖及 patch 配置已是预期状态。
- 源码与 profile 包版本均为 `0.7.1`，`patchBuild.id=f741db4070fe8d87c61b9fdbf8fa9afc041af14715f8973842f2115f7aa619ec`，`createdAt=2026-11-19T04:56:33.033Z`；`patchRepo` 指向本工作树，billion-context 为 `0.1.216`。
- 源码和 profile 中的 `vendor/billion-context/dist/index.js` SHA-256 均为 `f3a7ece60c6848ba7308d1ec281d00db8893768412ff4aeec7cddb6f49640053`；安装包中已存在 `biliRetentionResolveRef`。配置 bundle 和 client bundle SHA-256 分别均为 `b7fb6650ff70cc101b9f91b3657aca0aa055842c8d0f60840f05968f0fb310bb` 与 `4aa48272fb0b6284a9e40c4764667026dc778b4518decae36d1fe2b4e07c60a0`。
- 当前 bili 代理 PID `59908`（`127.0.0.1:18797`）在安装前已运行且本轮未重启；它仍加载旧内存版本。下次用户重启 DSH 后才会加载磁盘上的 `0.7.1`。
- 本轮未提交、推送、打标签或发布；真实 DSH 会话行为、真实模型和外部网关缓存命中未验证。
