// <bili-aux-image-egress begin>
// Every additional send owns its receipt. Inspect the final plaintext after
// user transforms; shed images are never credited as accepted pixels.
async function __biliPrepareAuxImageEgress(body, protocol, session, opts = {}) {
  const attempt = {};
  let finalBody = body;
  if (session && protocol) {
    const images = await biliRetentionApply(finalBody, protocol, session, {
      phase: opts.phase || "retry", log: opts.log, attempt,
    });
    finalBody = images.body;
    if (typeof finalBody === "string") {
      const shed = await shedEgressIfOverBudget(finalBody, protocol, {
        sessionId: session.id, session, log: opts.log, phase: opts.phase || "retry",
      });
      finalBody = shed.body;
      const cap = opts.upstreamUrl && session.stats.imageCountCaps?.[normalizeUpstreamOrigin(opts.upstreamUrl)];
      if (typeof cap === "number" && cap > 0) {
        finalBody = (await shedWireImagesToCount(finalBody, protocol, cap - 1, {
          resolveRef: (mediaType, base64) => refForItemBytes(session, mediaType, base64),
        })).body;
      }
    }
  }
  if (opts.egress) finalBody = await opts.egress(finalBody, opts.headers);
  const receipt = session && protocol
    ? biliRetentionFinalize(finalBody, protocol, session, attempt) : undefined;
  return { body: finalBody, receipt };
}
// <bili-aux-image-egress end>
