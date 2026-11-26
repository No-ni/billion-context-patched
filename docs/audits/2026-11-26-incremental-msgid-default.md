# 0.8.2 增量消息 ID 默认值与本机安装

- 首次安装的 0.8.2 沿用了上游 100% 的默认比例。用户纠正方向后，R1 将 `pluginMsgIdIncremental` 默认比例改为 0%，绕过折叠后增量 ID 漂移导致的全文回退。保留配置文件和环境变量的显式覆盖。
- 与 0.8.1 比较，代理构建只改动这一处默认比例。检查实际 rollout 解析函数，缺省关闭、显式开启以及环境变量优先均通过。
- `node scripts/install.mjs --build`、`node scripts/check-all.mjs --offline` 和 `git diff --check` 通过。离线检查共 15 个入口，模拟端到端通过 35 项。此次未运行单独的宿主模块测试或真实模型请求。
- 通过安装脚本更新本机 `desktop` profile。已安装清单为 0.8.2，构建标识和代理构建与候选一致。运行中代理读取到显式的 `rollout.features.pluginMsgIdIncremental: false`，无环境变量覆盖，健康检查通过。DSH 和代理继续运行，下次启动会读取已更新的构建。
