# bili-context-patch

**当前版本：0.6.5** · [更新记录](CHANGELOG.md) · [使用说明](docs/USAGE.md)

面向 DSH 的上下文压缩与请求加速插件。基于 [billion-context](https://github.com/ranxianglei/billion-context)，内置[模型请求加速器](https://github.com/No-ni/dsh-plugin-model-request-accelerator)，安装一个包即可使用两组功能。

## 功能

- **长对话与 fork 继承**：上下文压缩、快照复用，补齐 fork 的父会话关系并继承已有压缩状态。快照渲染仍遵守标记与灰度开关。
- **请求加速**：支持请求体压缩、共享历史预传输和每次请求的耗时面板，按渠道配置。
- **图片减量**：图片成功发送后可折叠为占位说明，原图可按引用取回；首次发送按需缩放。当前回合上传的图片默认保留。
- **集中设置**：插件卡片承载两项功能，bili 面板和「模型请求加速」设置页分别管理各自配置。

## 安装与更新

在 DSH 插件商店安装 **bili-context-patch**，随后启用。也可在「设置 → 插件」使用 GitHub 安装源：

```text
github:No-ni/billion-context-patched
```

包内携带上游运行文件和必要解析器，无需先安装原版插件。

首次启用会自动停用原版 `billion-context` 和 `dsh-plugin-model-request-accelerator`，迁移旧加速器设置并保留已有选择；原版卡片如果仍显示，应处于关闭状态。

更新时在插件管理器更新本插件。DSH 提示重载或重启时按提示操作；加载本次宿主修复需要重载插件或重启 DSH，图片代理修复还需重新启动 bili 代理。手动安装与重启命令见[使用说明](docs/USAGE.md#手动安装)。

## 开始使用

在设置中打开 bili 面板查看上下文状态，在 bili 的「配置」页调整压缩与图片设置；渠道开关、请求压缩算法与耗时信息在「模型请求加速」页管理。

| 默认设置 | 行为 |
| --- | --- |
| 缓存钥匙 | 默认开启，保留显式的 enabled / auto / disabled 选择 |
| 压缩增长阈值 | 80,000 token，显式配置优先 |
| 图片 | 默认开启折叠、当前上传豁免与图像使用约定；首次发送长边上限 1200 |
| 指定中转渠道 | `www.didudidu.asia`、`154.219.111.56` 仅补缺失的开启与 auto 设置，auto 优先 br |

手动关闭、选择 gzip 或其他显式配置会保留。其他站点可在加速器设置中自行开启。详细配置与常见问题见[使用说明](docs/USAGE.md)。

## 0.6.5 更新

修复插件页安装后原版未停用、两个指定站点未补默认值的问题，并修复启动竞态、账本资源释放、安装依赖遗漏和 Windows 图片编码。完整变化见 [CHANGELOG](CHANGELOG.md)。

## 文档与维护

[文档目录](docs/README.md)提供使用说明、[行为规范](docs/SPEC.md)、[维护流程](docs/MAINTENANCE.md)、[实现历史](docs/PATCHES.md)和[本版核对记录](docs/audits/2026-11-12-release.md)。维护入口为 [AGENTS.md](AGENTS.md)。

## 许可

补丁与包装层采用 [MIT](LICENSE)。上游项目及内置 YAML、Zod 的来源与许可见[维护说明](docs/MAINTENANCE.md#1-两个来源分别锁定)。
