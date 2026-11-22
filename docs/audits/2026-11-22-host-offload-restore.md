# 宿主退役占位还原与上传超限兜底（IMG-12 / IMG-13）

2026-11-22。用户要求代理不再被 DSH 宿主的图片退役牵连，并在上游以 413 拒绝请求体体积时先压缩一次再重发。本文记录动机、证据、实现与验证边界。

## 1. 动机

0.7.5 删除了插件自己添加的图片处理：历史图片在每次请求里按上游行为重发。DSH 宿主仍会在请求组装阶段把超出图片预算的旧图退役成占位文本。两次实机会话复核提供了两端的事实：

- 会话 `session-38607dba-bfc1-4b39-9623-0dbe02413886`（1 turn / 71 step）里 `read_image` 成功 19 次、合计 916,216 字节；每次请求都重发历史图片，宿主到代理累计 87.7 MiB，代理到上游 20.8 MiB（约 4.2 倍压缩）。该会话峰值 prompt 174,980 / 350,000，恰好 19 张图，没有触发 `maxImagesPerRequest=20`，因此这次没有退役发生——退役的代价只能从代码和另一次会话取证。
- 会话 `session-ca89f71d` 的上游返回 `413 {"message":"Request body exceeds the upload size limit","type":"upload_limit"}`（`~/.dsh/logs/desktop-next-2026-11-21.0.jsonl` 第 467 行，turn1 step31 `agent.failed`，`LlmError` code `INVALID_REQUEST`）。代理侧的 `isMarkerlessOverflowReject` 只打一条 warn（`bili's overflow self-heal … CANNOT engage from this rejection`），随后把 413 透传给宿主。

用户的判断是：占位出现的时机、位置都是代理本来就能知道的信息，改写占位把缓存前缀拉回退役前的样子不改变语义，因此允许放开 0.7.5 时“插件不再解析或改写占位文本”的限制；同时要求 413 必须有兜底，且不记录任何上传软上限（渠道与同一渠道的上限都会变化）。

## 2. 宿主侧事实（只读参考）

- `llm-pi-ai` 在发出 HTTP 之前判定图片预算：`packages/llm/llm-pi-ai/src/context.ts` 抛 `IMAGE_OFFLOAD_REQUIRED`，调用点在 `adapter.ts`；`llm-deepseek` 走 `images.ts` 的 `prepareImages` → `assertImagesFit`。代理收不到这个失败请求，退役完全发生在宿主内部。
- 占位文本由 `packages/llm/llm/src/content.ts` 的 `offloadedImageText` 生成：`[image omitted to fit request image limits; <identity>. …]`，identity 为 `sha256:<64 hex>` 或 `"name" (sha256:<64 hex>)`。
- 同一文件里的 `requestImageHandleText` 生成图片前那段文字：`Image sha256:<64 hex>; request preview <W>x<H>px. …`，与图片 part 相邻。`llm-pi-ai/src/context.ts` 的 `userContent` 对每张图依次推入「说明文本 part + 图片 part」两段；退役后整块变成单个占位文本 part。
- 因此出站 body 里那一对 part 的顺序和字节是稳定的：只要代理记住退役前真正发出去的 JSON 对象，就能原样塞回。

## 3. 实现

新增 `patches/image-restore.block.js`（纯 ASCII，哨兵 `// <bili-image-restore>` … `// </bili-image-restore>`），由 `scripts/patch-bili-build.mjs` 的步骤 22 插入代理构建，并在两处挂钩：

- 初次发送前：读到 `wireBody` 之后、`shedEgressIfOverBudget` 之前调用 `__biliRestoreHostOffloads(wireBody, prepared, log)`。
- 重试路径：`finalizeEgress` 包装 `runEgress` 之前同样调用一次，保证 400/413 重试用的也是还原后的字节。

还原算法：

1. 快速子串判定：body 里出现 `; request preview `（说明文本）或 `image omitted to fit request image limits;`（占位）才 `JSON.parse`。
2. 捕获：栈式遍历所有数组，遇到含 `; request preview ` 且带 64 位十六进制 `sha256:` 的文本 part，取相邻的图片 part，按 `协议|sha256` 存入会话缓存。图片 part 的识别覆盖 `image_url`、`input_image`、`image`、`inlineData`、`inline_data`。
3. 还原：遇到含占位标记的文本 part，按同一 key 取出捕获的 `[说明文本, 图片]` 两段 `splice` 替换占位。只处理 `fit request image limits` 变体；`text-only` 等其他占位不动。
4. 缓存：模块级 Map，按会话保存，上限 96 张 / 64 MiB / 64 个会话，按插入顺序淘汰；首次成功还原记 info，之后记 debug；解析失败只 warn 并保留占位，绝不抛出。

开关是插件自己的顶层配置键 `imageRestoreHostOffload`（不是 DSH 设置）：默认开启，关闭时写入 `false`；环境变量 `BILI_IMAGE_RESTORE` 可覆盖，便于排障。图像预算卡新增一个复选框，勾选即从配置文件删除该键，只在用户选择关闭时记录。

413 兜底插在既有 `overflowRefold` 分支链里，位置在图片数量墙与上下文溢出分支之后：只有 `overflowInfo.imageCountCap === undefined`、`!overflowInfo.isOverflow`、`__biliUploadLimitReject(status, text)` 成立并且出站 body 是字符串时才进入。目标窗口 `__biliUploadRefoldTarget` 取「请求体估算（字节 / 4）、`session.stats.lastInputTokens`、模型窗口」三者最小值再乘系数，第一轮 0.6、第二轮 0.35，下限 1024 且必须小于模型窗口——小于当前估算才会真正触发预检折叠。折叠结果交给 `overflowRefold` 重跑准备管线，成功后用 `finalizeEgress` 重签再发同一上游；成功即替换 `upstreamResult` 并记 `[upload-413] … folded once to ~N tokens`，失败或不满足条件时把原 413 原样交给宿主。实现中没有任何学习或记忆上传上限的代码。

## 4. 验证

`scripts/check-e2e-mock.mjs` 增加三条实进程检查（真实候选代理 + 本地 mock 网关）：

- **还原逐字节一致**：同一会话先发「说明文本 + `image_url`」，再发把该处换成占位的新请求；断言线上那条消息的 `content` 与第一次完全相同（`deepEqual`），日志出现 `[image-restore] put 1 host-offloaded image`。
- **关闭开关**：配置 `imageRestoreHostOffload: false` 后同样两次请求，断言占位留在线上、没有 `image_url`。
- **413 兜底**：让本地网关对 `/v1/chat/completions` 先返回一次 `{"error":{"message":"Request body exceeds the upload size limit","type":"upload_limit"}}`，断言调用方仍拿到 200、同一路径至少发送两次、后一次更小，日志出现 `[upload-413]` 的 folded once 记录。

网关 fixture 为此补了两件事：`planPath` 支持 `{kind:"status", status, body}` 的脚本化状态码；对预检总结请求（system 含 `TASK: The conversation segment below`）返回可用的长摘要，否则折叠永远停在“摘要过短”的重试里，413 场景无法验证。

`scripts/check-image-card.mjs` 覆盖开关默认开启、关闭写入 `false`、再开启删除该键、配置里的 `false` 反映到复选框、恢复默认删除该键（55 项通过）。`scripts/check-upstream-ux.mjs` 的注册表迁移把 `imageRestoreHostOffload` 计入 IMAGE_CONFIG_KEYS，验证原五项白名单能迁移到新形态且幂等。`node scripts/check-all.mjs --offline` 全部通过（13 个脚本，e2e 26 项，image card 55 项）。

## 5. 边界与未覆盖

- 只能还原代理亲眼见过的字节。重启后缓存为空，宿主已经退役的占位在后续请求里保持占位；第一次还原之前的请求仍以占位发出。这是“不改写宿主历史”的直接代价。
- 还原让请求体重新变大，因此与 IMG-13 联动：还原后如果撞到上传限制，413 分支会强制折叠含图区间。两者都不改变宿主的 token 记账。
- 只识别 `fit request image limits` 占位；`text-only` 模型的占位与宿主其他改写不属于 IMG-12。
- 真机验证仍需一次真实的 DSH 图片退役：观察 `~/.dsh/logs/desktop-next.log` 是否出现 `[image-restore] put …`，以及上游缓存命中是否在退役前后保持稳定。按用户要求本轮把 0.7.5 安装到本机 DSH profile，但不重启正在运行的实例；未提交、未推送。
