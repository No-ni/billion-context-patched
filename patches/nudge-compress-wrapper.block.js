async function applyConfiguredCompression(input, ctx, callId, signal) {
  const gate = unpromptedGateOf(ctx.session);
  if (gate.compressionInFlight || gate.compressed) {
    const reason = gate.compressed
      ? "this nudge already completed a successful compression"
      : "a compression for this nudge is already in progress";
    ctx.log(`[acp-proxy: refused duplicate nudge compression: ${reason}]`);
    return compressResult(
      `[Compression REFUSED: ${reason}. Do not call compress again for this nudge; continue the task. A new compression nudge is required before another fold.]`,
      "refused",
      0,
      "nudge-compress-once",
    );
  }

  const nudgeId = gate.nudgeId;
  const ownsNudge = gate.armed && Number.isSafeInteger(nudgeId) && nudgeId > 0;
  const current = ctx.session.transient?.unpromptedGate;
  if (ownsNudge && current?.nudgeId === nudgeId) current.compressionInFlightNudgeId = nudgeId;

  try {
    const result = await applyConfiguredCompressionCore(input, ctx, callId, signal);
    if (ownsNudge && result?.blocksCreated > 0) {
      const latest = ctx.session.transient?.unpromptedGate;
      if (latest) {
        const completed = Number.isSafeInteger(latest.completedNudgeId) ? latest.completedNudgeId : 0;
        latest.completedNudgeId = Math.max(completed, nudgeId);
        if (latest.nudgeId === nudgeId) latest.credit = 0;
      }
    }
    return result;
  } finally {
    if (ownsNudge) {
      const latest = ctx.session.transient?.unpromptedGate;
      if (latest?.compressionInFlightNudgeId === nudgeId) latest.compressionInFlightNudgeId = 0;
    }
  }
}
