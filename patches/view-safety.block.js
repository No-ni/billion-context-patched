// The digest covers every field, including edits beyond the old 200-char probe.
function __biliPrefixDigest(messages, count) {
  const hash = require("node:crypto").createHash("sha256");
  for (let i = 0; i < count; i++) hash.update(JSON.stringify(messages[i])).update("\n");
  return hash.digest("hex");
}

// Compare only compression state that can change this prefix's coverage or
// anchor layout. Stats and blocks confined to a newly appended tail are inert.
function __biliPrefixBlockDigest(session, messages, count, view) {
  const blocks = session.state.blocks;
  const ids = new Set(messages.slice(0, count).map(m => m.id));
  const relevant = new Set(view.filter(m => m.id?.startsWith("acp_summary_"))
    .map(m => m.id.slice(12)));
  for (const b of blocks) {
    if (b.effectiveMessageIds.some(id => ids.has(id))) relevant.add(b.blockId);
  }
  const byId = new Map(blocks.map(b => [b.blockId, b]));
  const pending = [...relevant];
  for (let i = 0; i < pending.length; i++) {
    for (const id of byId.get(pending[i])?.directBlockIds ?? []) {
      if (!relevant.has(id)) { relevant.add(id); pending.push(id); }
    }
  }
  const layout = blocks.filter(b => relevant.has(b.blockId)).map(b => ({
    id: b.blockId, active: b.active === true, retired: b.retired === true,
    expanded: b.expanded === true, restoredInline: b.restoredInline === true,
    tier: b.tier, summary: b.summary, rewrittenAt: b.rewrittenAt,
    directMessageIds: b.directMessageIds, effectiveMessageIds: b.effectiveMessageIds,
    directBlockIds: b.directBlockIds, startRef: b.startRef, endRef: b.endRef,
    startSeq: b.startSeq, endSeq: b.endSeq,
  }));
  return require("node:crypto").createHash("sha256")
    .update(JSON.stringify(layout)).digest("hex");
}

function __biliPinMatches(session, messages, pin) {
  if (!pin || !Array.isArray(messages) || messages.length < pin.count) return false;
  if (__biliPrefixDigest(messages, pin.count) !== pin.digest) return false;
  if (__biliPrefixBlockDigest(session, messages, pin.count, pin.view) !== pin.blocksDigest) return false;
  // A pin holds summary placeholders. An inactive/removed block can no longer
  // fill its placeholder after a re-compression, even if the raw prefix matches.
  const active = new Set(session.state.blocks.filter(b => b.active).map(b => b.blockId));
  return pin.view.every(m => !m.id?.startsWith("acp_summary_") || active.has(m.id.slice(12)));
}

function __biliPinViewRecord(session, clientMsgs, view) {
  try {
    if (!session || typeof session.id !== "string" || !Array.isArray(clientMsgs) || !Array.isArray(view) || !view.length) return;
    const pin = {view: JSON.parse(JSON.stringify(view)), count: clientMsgs.length,
      digest: __biliPrefixDigest(clientMsgs, clientMsgs.length),
      blocksDigest: __biliPrefixBlockDigest(session, clientMsgs, clientMsgs.length, view)};
    __biliPinnedViews.delete(session.id);
    __biliPinnedViews.set(session.id, pin);
    while (__biliPinnedViews.size > 8) __biliPinnedViews.delete(__biliPinnedViews.keys().next().value);
  } catch {}
}

function __biliForkPinView(session, clientMsgs, deps) {
  try {
    const md = session?.metadata;
    if (!md || md.__biliForkPinned || typeof md.parentConversationId !== "string") return null;
    const pin = __biliPinnedViews.get(md.parentConversationId);
    if (!__biliPinMatches(session, clientMsgs, pin)) return null;
    const extra = clientMsgs.slice(pin.count);
    if (extra.length > 8 || extra[0]?.role === "tool") return null;
    const msgs = pin.view.concat(extra);
    session.metadata.snapshotRenderTailStart = pin.view.length;
    __biliPinViewRecord(session, clientMsgs, msgs);
    md.__biliForkPinned = true;
    __biliPinLog(deps, "[snapshot-render] fork-pin active parent=" + md.parentConversationId.slice(0,8) + " pinned=" + pin.view.length + " appended=" + extra.length);
    return msgs;
  } catch { return null; }
}

function __biliStickyView(session, clientMsgs, deps, reason) {
  try {
    if (!deps?.pluginMode) return null;
    const pin = session && __biliPinnedViews.get(session.id);
    if (!__biliPinMatches(session, clientMsgs, pin)) return null;
    const extra = clientMsgs.slice(pin.count);
    if (extra.length > 8 || extra[0]?.role === "tool") return null;
    session.metadata.snapshotRenderTailStart = pin.view.length;
    __biliPinLog(deps, "[snapshot-render] sticky view (" + reason + "): pinned=" + pin.view.length + " appended=" + extra.length);
    return pin.view.concat(extra);
  } catch { return null; }
}

// Block creation order does not prove that its messages lie after the seam.
// Relax the missing-row check only when every covered message survives raw.
function __biliSkippedCoverage(session, blockSeeds, tailMsgs) {
  const anchored = new Set(blockSeeds.map(b => b.blockId));
  const tailIds = new Set(tailMsgs.map(m => m.id));
  return session.state.blocks.filter(b => b.active && !anchored.has(b.blockId))
    .every(b => b.effectiveMessageIds.length > 0 && b.effectiveMessageIds.every(id => tailIds.has(id)));
}
