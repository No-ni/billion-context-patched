// An explicit fork proves exactly which history belongs to the child. The
// rest of the parent's ref namespace stays reserved, but those raw ids have
// not been observed by the child and must not masquerade as its old history.
function __biliCopyForkTimestamps(child, parent, prefix) {
  const inherited = new Set(prefix.map(m => m.rawId));
  if (parent.state.tsStamps) {
    const entries = [];
    for (const id of inherited) {
      const ts = parent.state.tsStamps[id];
      if (Object.hasOwn(parent.state.tsStamps, id) && typeof ts === "number" && Number.isFinite(ts)) entries.push([id, ts]);
    }
    child.state.tsStamps = Object.fromEntries(entries);
  } else delete child.state.tsStamps;
  const visible = [...__biliForkTimestampVisibility(parent.state)].filter(id => inherited.has(id));
  if (visible.length) child.state.__biliForkTsVisible = visible;
  else delete child.state.__biliForkTsVisible;
  const pending = Object.keys(parent.state.messageRefs?.byRaw ?? {})
    .filter(id => !inherited.has(id) && id !== "bili:ref-floor");
  if (pending.length) child.state.__biliForkTsPending = pending;
  else delete child.state.__biliForkTsPending;
  delete child.state.suppressMintingOnce;
}

// A reserved ref may sit below the inherited high-water mark even though its
// message first arrived in this child. Remember only stamps already shown for
// those first sightings; replaying bare converter messages must keep their
// attributes. The proof set stays bounded by the issued raw-id namespace.
function __biliForkTimestampVisibility(state) {
  const known = state.messageRefs?.byRaw ?? {};
  const stamps = state.tsStamps ?? {};
  const visible = Array.isArray(state.__biliForkTsVisible) ? state.__biliForkTsVisible : [];
  return new Set(visible.filter(id => typeof id === "string" && id !== "bili:ref-floor" &&
    Object.hasOwn(known, id) && Object.hasOwn(stamps, id) &&
    typeof stamps[id] === "number" && Number.isFinite(stamps[id])));
}

// Consume first sightings even with timestamps disabled. Enabling the feature
// later must leave the already-observed child history honestly unstamped.
// Only an enabled pass whose output actually carried the recorded stamp proves
// visibility. A stored-but-unshown historical stamp never grants this bypass.
function __biliObserveForkTimestampIds(io, enabled = false) {
  const known = io.state.messageRefs?.byRaw ?? {};
  const previousPending = io.state.__biliForkTsPending;
  const pending = [...new Set((Array.isArray(previousPending) ? previousPending : [])
    .filter(id => typeof id === "string" && id !== "bili:ref-floor" && Object.hasOwn(known, id)))];
  const seen = new Set(io.messages.map(m => m.id));
  const remaining = pending.filter(id => !seen.has(id));
  const previousVisible = io.state.__biliForkTsVisible;
  const visible = __biliForkTimestampVisibility(io.state);
  if (enabled && pending.length) {
    const firstSight = new Set(pending);
    const stamps = io.state.tsStamps ?? {};
    for (const m of io.messages) {
      if (firstSight.has(m.id) && Object.hasOwn(stamps, m.id) &&
        typeof m.ts === "number" && Number.isFinite(m.ts) && stamps[m.id] === m.ts) visible.add(m.id);
    }
  }
  const visibleIds = [...visible];
  const unchanged = (before, after) => before === undefined ? after.length === 0 :
    Array.isArray(before) && before.length === after.length && before.every((id, i) => id === after[i]);
  if (unchanged(previousPending, remaining) && unchanged(previousVisible, visibleIds)) return io;
  const state = { ...io.state };
  if (remaining.length) state.__biliForkTsPending = remaining;
  else delete state.__biliForkTsPending;
  if (visibleIds.length) state.__biliForkTsVisible = visibleIds;
  else delete state.__biliForkTsVisible;
  return { ...io, state };
}
