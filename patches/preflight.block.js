// <bili-preflight begin>
function __biliSnapshotDegraded(prepared) {
  const session = prepared.session;
  if (prepared.sidePassthrough || !featureEnabled("snapshotRender") ||
      (prepared.pluginMode && !__biliPluginLaneSnapshot()) ||
      typeof session.metadata.snapshotRenderTailStart === "number" ||
      !session.state.blocks.some(block => block.active)) return null;
  const reason = session.metadata.snapshotRenderDegradeReason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

async function __biliRecoverSnapshot(prepared, runPrepare, res, log2) {
  const reason = __biliSnapshotDegraded(prepared);
  if (reason === null) return prepared;
  if (res.destroyed || res.writableEnded) return null;
  const session = prepared.session;
  // The first prepare has already scheduled this session's save. Wait for that
  // save, not a global flush, and never hold a request indefinitely on storage.
  const settled = await new Promise(resolve => {
    const finish = ok => {
      clearTimeout(timer);
      res.removeListener("close", closed);
      resolve(ok === true);
    };
    const closed = () => finish(false);
    const timer = setTimeout(() => finish(false), 1000);
    res.once("close", closed);
    try {
      Promise.resolve(getStore().afterNextFlush(session.id)).then(finish, () => finish(false));
    } catch {
      finish(false);
    }
  });
  if (res.destroyed || res.writableEnded) return null;
  if (!settled) return prepared;
  const requests = session.stats.requests;
  // The pipeline holds the session lock. Replaying its existing preparation
  // retains the normal coverage checks and must not count a second request.
  try {
    const rebuilt = await runPrepare();
    log2("info", `[${session.id}] [snapshot-recovery] re-prepared once after ${reason}; rendered=${typeof session.metadata.snapshotRenderTailStart === "number"}`);
    return rebuilt;
  } finally {
    session.stats.requests = requests;
  }
}

function __biliSnapshotRetryable(prepared) {
  return ["block-unanchored", "store-unavailable", "transcript-empty",
    "transcript-error", "view-pointer-missing-row"].includes(__biliSnapshotDegraded(prepared));
}

function __biliPreflightError(error) {
  const tooLarge = error.status === 413;
  const retryable = !tooLarge && error.retryable === true;
  const message = tooLarge
    ? "请求内容过大，请缩短历史或减少单条消息、图片后重试。"
    : retryable
      ? "上下文准备暂未完成，DSH 会自动重试。"
      : "上下文压缩后仍超出模型窗口，请精简内容或改用更大窗口的模型。";
  return { type: "server_error", code: "preflight_compress_failed", message,
    detail: error.message, retryable };
}

function __biliReplyPreflight(res, error) {
  if (!res.headersSent) res.writeHead(error.status === 413 ? 413 : 502,
    { "content-type": "application/json" });
  res.end(JSON.stringify({ error: __biliPreflightError(error) }));
}
// <bili-preflight end>
