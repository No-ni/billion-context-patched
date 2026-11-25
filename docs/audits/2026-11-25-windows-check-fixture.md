# 0.8.0 发布前的 Windows 检查夹具修正（2026-11-25）

推送 `main`（`8a99904`）触发的 `.github/workflows/check.yml` run 45577814070 里，只有 `windows-latest / Node 24` 失败：`node scripts/install.mjs --build` 的冒烟阶段在 `scripts/check-image-budget.mjs` 抛出

```
AssertionError [ERR_ASSERTION]: a failed backup write must be reported
    at file:///D:/a/billion-context-patched/billion-context-patched/scripts/check-image-budget.mjs:695:7
smoke test failed; D:\\a\\billion-context-patched\\billion-context-patched\\vendor\\billion-context\\dist\\index.js was left untouched
```

`ubuntu-latest`（Node 22/24）、`macos-latest` 与 `host integration (published DSH)` 均通过。

## 根因

IMG-10a 的两个失败注入用例用 `chmodSync(目录, 0o555)` 制造只读目录。POSIX 上这样能挡住临时文件创建（写失败用例）和 `unlink`（删除失败用例）；Windows 只实现文件级别的只读属性，目录模式被忽略，两处失败都不发生：

- `check-image-budget.mjs:695`：备份其实写成功，没有「could not write the image budget backup」告警，断言失败。
- 紧随其后的删除失败用例（`a backup that cannot be deleted must stay in place`）会因删除成功而在断言处失败，只是被前一条先挡住、未跑到。

这是夹具的平台假设问题，不是插件行为回归：`lib/defaults.js` 的 `writePiImageBackups()` 在临时文件+rename 失败时仍会告警、删除临时文件并把预算写进 provider。

## 修正

两个用例改成按平台注入等价的失败，断言口径与原来一致：

| 用例 | POSIX | Windows |
| --- | --- | --- |
| 备份写入失败 | 父目录只读（临时文件创建失败） | 目标备份文件只读（`MoveFileEx` 拒绝替换只读目标） |
| 备份删除失败 | 父目录只读（`unlink` 拒绝） | 备份文件只读（`DeleteFile` 拒绝只读文件） |

写失败用例先写一份 `{"version":1,"entries":[]}` 的备份再注入失败，因此还能断言「旧备份字节不变」与「没有 `.tmp` 残留」；删除失败用例保持带幽灵记录的备份文件，断言没有 `unhandledRejection` 且备份仍在。用例数仍为 27。

## 验证边界

- 本地 macOS（Node v24.19.0）：`node scripts/check-image-budget.mjs` → `image budget: 27 checks passed`；`node scripts/check-all.mjs --offline` 通过。
- Windows 分支没有真机手工复核，只有 CI 的 `windows-latest` 结果能证明它成立；本轮以重新推送后 check.yml 的结论为准，未通过就不打标签。
- 未改动 `lib/`、`vendor/` 或生成物，`patchBuild` 不变；该修正只影响离线检查。
