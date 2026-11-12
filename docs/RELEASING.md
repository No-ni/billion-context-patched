# 发布与补全流程

先读 [AGENTS.md](../AGENTS.md)、[SPEC.md](SPEC.md) 与 [MAINTENANCE.md](MAINTENANCE.md)。本文全部路径相对于仓库根目录；版本以 `package.json` 为准，用户说明只在 CHANGELOG 维护。提交、推送与发布应在本次任务授权内，不能把准备脚本当成授权。

## 1. 准备与审阅

1. 现场核对工作树、分支、来源、`origin` 和已有标签，先 `git fetch origin --tags`。保留用户已有改动；不自动 stash/reset、不 force push、不改旧标签。
2. 开功能分支，修复及用户变化记入 `CHANGELOG.md` 的 Unreleased，独立行为同步 SPEC，来源/实现映射同步 MAINTENANCE，证据入 audits。README 不增版本摘要。
3. 功能提交审阅并提交后，从干净工作树准备新版本：

   ```sh
   node scripts/release.mjs X.Y.Z
   ```

   助手验证版本递增、Unreleased 非空、本地已合入所 fetch 的 origin/main 且标签不存在，提升 package 版本，把 Unreleased 转成带日期的版本节，顶部留下空 Unreleased；随后先构建候选再跑全部 offline 检查。它不 commit/tag/push/publish，也不安装用户插件。失败保留候选供修复审阅，不自动回退文件。
4. 审阅 `package.json`、CHANGELOG 及生成物。记录 host 检查和真实 DSH 的已验证/未覆盖范围；有已知偏差先修复。通常把版本准备单独提交为中文发布提交；0.6.7 是旧流程已经准备的候选，首次引入此流程不为凑提交顺序反向撤销修复。

重复构建应保持 patchBuild 的 id/createdAt 和生成物不变。先构建再检查，不能只检查旧产物。没有修改运行文件的文档整理不必升版，但 main 上任一构建变化都必须是可交付状态。

## 2. 提交与分支检查

推送功能分支后，等待 `.github/workflows/check.yml` 的全部平台完成；不能把已触发当作通过。它在 Ubuntu Node 22/24、Windows/macOS Node 24 构建、核对生成物并运行 offline 检查。

```sh
gh run list --repo No-ni/billion-context-patched --branch <功能分支>
gh run view <run-id> --repo No-ni/billion-context-patched
```

本地 host 检查用 `node scripts/check-all.mjs --host --host-modules <实际模块目录>`，缺依赖明确未运行。offline 允许本机端口和临时资源，不调用真实模型。CI 通过不等于真机验证已完成。

## 3. 合入与打标签

在现有授权下审阅并合入；本仓库默认直接向自己的 origin 维护，不自动开 PR。发布前再次 fetch，确认远端无未审阅的新提交，`main` 可快进到已检查的提交；若远端变更，先合入并重新检查。普通合并按 SPEC 第 7 节核对，不改写来源历史。

```sh
git switch main
git merge --ff-only <已检查分支>
git tag -a vX.Y.Z -m '发布 vX.Y.Z'
git push --atomic origin main vX.Y.Z
```

原子推送只保证提交与标签一起到达 GitHub，不保证 Release 已建立。不得因最后一步成功就报告发布完成。

## 4. CI 交付

`.github/workflows/release.yml` 是包含新流程的版本的唯一发布者。标签推送触发，也可手动指定已有 tag 补全失败流程：

```sh
gh workflow run release.yml --repo No-ni/billion-context-patched --ref main -f tag=vX.Y.Z
```

工作流依次：

1. 检出标签，确认标签指向 HEAD、package/CHANGELOG/tag 一致且 Unreleased 为空。
2. 构建最终产物、要求生成物无差异、运行全部 offline 检查。
3. `git archive HEAD` 生成 `bili-context-patch-X.Y.Z.zip`（根目录为 `bili-context-patch/`），生成 SHA256SUMS 和从版本节提取的正文，只打包已提交文件，不夹带本机配置或临时目录。
4. 新建草稿 Release，更新正文并上传 ZIP 与 SHA256SUMS；下载附件，比较清单并核验 ZIP 哈希，通过后再公开。
5. 已公开的相同版本重跑只校验已发布说明和附件，不覆盖；草稿允许补齐失败的上传。若公开附件与标签不一致则失败，先调查，不自动替换已公开文件。

本地 `node scripts/package-release.mjs --tag vX.Y.Z` 可在干净标签上生成同样文件供核验，但不上传；输出目录 `release-artifacts/` 已忽略，不提交到 Git。版本脚本不会自行 fetch，第一步须确保 origin/main 新鲜。

## 5. 核验与失败收尾

```sh
gh run list --repo No-ni/billion-context-patched --limit 10
gh release view vX.Y.Z --repo No-ni/billion-context-patched --json url,tagName,isDraft,body,assets
git status --short --branch
git ls-remote origin refs/heads/main refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'
```

等待本轮启动的所有检查和发布到明确最终状态；核对本地/远端提交、标签解引用、非草稿 Release、中文正文和 ZIP/SHA256SUMS。失败可按同一标签重跑，不能重打标签掩盖问题。受环境限制没有完成的检查与真实 DSH 未覆盖项如实写入审计。

清理本任务临时打包/下载/宿主提取目录和本机模拟服务，确认无残留执行会话；不停止原有用户进程、不改已安装插件。发布结果的后续状态以 Git/GitHub 查询为准；审计保存当次证据，不能当作永远不变的状态。

## 6. 0.6.6 历史补录例外

旧 `v0.6.6` 已存在但没有 Release，且该标签不包含新工作流。仅本次从该旧标签 `git archive` 打 ZIP，取 CHANGELOG 对应版本的用户说明，创建草稿、上传并下载核对哈希后公开，保持旧标签指向不变且不取代较新版本的 Latest。这是历史修复，不保留第二套日常自动发布者；不能用本地 0.6.7 工作树冒充旧版本附件。
