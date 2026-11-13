// <bili-stream-errors begin>
function __biliStreamErrorInfo(message) {
  const detail = typeof message === "string" ? message : String(message ?? "");
  const visible = /exceeds|too large|payload.*limit/i.test(detail)
    ? "\u8bf7\u6c42\u5185\u5bb9\u8fc7\u5927\uff0c\u8bf7\u51cf\u5c11\u5386\u53f2\u6216\u56fe\u7247\u540e\u91cd\u8bd5\u3002"
    : /truncat|without.*terminal|no completion|ended before/i.test(detail)
      ? "\u4e0a\u6e38\u54cd\u5e94\u4e2d\u65ad\uff0c\u8fd9\u4e00\u8f6e\u53ef\u80fd\u4e0d\u5b8c\u6574\uff0cDSH \u4f1a\u81ea\u52a8\u91cd\u8bd5\u3002"
      : "\u6a21\u578b\u8bf7\u6c42\u5931\u8d25\uff0cDSH \u4f1a\u81ea\u52a8\u91cd\u8bd5\u3002";
  return { message: visible, detail };
}

function nativeErrorChunk(protocol, message, detail) {
  const error = { type: "server_error", code: "stream_error", message, detail };
  if (protocol === "openai") return `data: ${JSON.stringify({error})}\n\ndata: [DONE]\n\n`;
  if (protocol === "responses") return `event: error\ndata: ${JSON.stringify({type:"error",code:error.code,message,detail})}\n\n`;
  if (protocol === "google") return `data: ${JSON.stringify({error:{code:502,message,status:"INTERNAL",detail}})}\n\n`;
  if (protocol === "commandcode") return `${JSON.stringify({type:"error",error:"acp_proxy_error",message,detail})}\n`;
  return `event: error\ndata: ${JSON.stringify({type:"error",error})}\n\n`;
}

function emitStreamError(res, protocol, message, log2, errorShape = "protocol", state7) {
  const info = __biliStreamErrorInfo(message);
  log2?.(`[acp-proxy: stream aborted mid-response: ${info.detail}]`);
  const chunk = errorShape === "protocol"
    ? nativeErrorChunk(protocol, info.message, info.detail)
    : legacyCompletionChunk(protocol, `\n\u274c [ACP] ${info.message}`, state7, info.detail);
  try { safeWrite(res, chunk); }
  finally { try { res.end(); } catch {} }
}
// <bili-stream-errors end>
