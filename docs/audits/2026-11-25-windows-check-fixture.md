# 0.8.0 发布前的 Windows 检查夹具修正（2026-11-25）

推送 `main` 触发的 `.github/workflows/check.yml` 里，只有 `windows-latest / Node 24` 失败，其余平台与 `host integration (published DSH)` 通过：`node scripts/install.mjs --build` 的冒烟阶段跑 `scripts/check-image-budget.mjs` 时报

```
AssertionError [ERR_ASSERTION]: a failed backup write must be reported
    at file:///D:/a/billion-context-patched/billion-context-patched/scripts/check-image-budget.mjs:695:7
smoke test failed; D:\\a\\billion-context-patched\\billion-context-patched\\vendor\\billion-context\\dist\\index.js was left untouched
```

## 根因

IMG-10a 的两个失败注入用例用 `chmodSync(目录, 0o555)` 制造只读目录。POSIX 上这样能挡住临时文件创建（写失败用例）和 `unlink`（删除失败用例）；Windows 只实现文件级只读属性、忽略目录模式，两处失败都不发生：

- 写失败用例：备份其实写成功，没有「could not write the image budget backup」告警，断言失败。
- 删除失败用例：删除成功，`a backup that cannot be deleted must stay in place` 会失败，只是被前一条先挡住、未跑到。

这是夹具的平台假设问题，不是插件行为回归：`lib/defaults.js` 的 `writePiImageBackups()` 在临时文件+rename 失败时仍会告警、删除临时文件并把预算写进 provider。

## 修正

**写失败用例**改成按平台注入等价失败，断言口径加强：

| 平台 | 注入方式 | 说明 |
| --- | --- | --- |
| POSIX | 父目录 `0o555` | 临时文件创建返回 EACCES |
| Windows | 目标备份文件 `0o444` | `MoveFileEx` 拒绝替换只读目标 |

用例先写一份 `{"version":1,"entries":[]}` 的空备份，再注入失败，因此除「告警一次」外还断言旧备份字节不变、目录里没有 `.tmp` 残留。

**删除失败用例**保持 POSIX 的只读目录注入，在 Windows 上显式跳过并打印原因：libuv 的 `uv_fs_unlink` 遇到只读属性会先清除再重试 `DeleteFile`，而换成目录等不可读的备份路径又会被插件当作损坏备份改名为 `.corrupt-<timestamp>` 移走，路径在删除前就空了，Windows 上无法用文件系统制造 `unlink` 失败。跳过不静默：日志出现 `SKIP a failed backup delete is swallowed (win32: the unlink cannot be made to fail)`，Windows 的用例数为 26，其他平台 27。

## 验证边界

- 本地 macOS（Node v24.19.0）：`node scripts/check-image-budget.mjs` → `image budget: 27 checks passed`；`node scripts/check-all.mjs --offline` 通过。
- 写失败用例的 Windows 分支已由 `windows-latest` 实跑通过（run 45579261898 越过该用例后在删除用例的恢复处报 ENOENT，这次失败促成了上面的跳过决定）。
- 删除失败用例在 Windows 没有等价覆盖，属已知缺口；它在 Linux 与 macOS 上仍然运行。
- 未改动 `lib/`、`vendor/` 或生成物，`patchBuild` 不变；该修正只影响离线检查。
