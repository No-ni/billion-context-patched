// Test-only opt-in transform: remove pixels from the first send, keeping the
// candidate's stored history intact so a real loop rebuild can send them later.
export default {
  id: "local-e2e-image-final-body",
  transform(ctx) {
    if (!/^e2e-image-(?:egress|loop)-/.test(ctx.sessionId ?? "")) return;
    const headers = { "x-e2e-transform-stage": ctx.stage };
    if (ctx.stage !== "initial") return { headers };
    const parsed = JSON.parse(Buffer.isBuffer(ctx.body) ? ctx.body.toString("utf8") : ctx.body);
    let removed = 0;
    for (const message of parsed.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      const kept = message.content.filter(part => {
        if (part?.type !== "image_url") return true;
        removed++; return false;
      });
      if (kept.length !== message.content.length) {
        message.content = [...kept, { type: "text", text: "E2E_OUTBOUND_IMAGE_REMOVED: pixels were removed only from this final outbound copy." }];
      }
    }
    return removed ? { body: JSON.stringify(parsed), headers, reason: "isolated mock removed pixels from the first outbound send" } : { headers };
  },
};
