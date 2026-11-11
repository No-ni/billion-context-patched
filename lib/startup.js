import { guardEntry, suppressEntry } from "./merge.js";

/** Start the children only after every already-starting duplicate has stopped. */
export function mountMergedPlugins(ctx, children, upstreamIds) {
  let closed = false;
  const releases = new Map();
  const active = () => !closed && ctx.fiber?.uid !== null && ctx.fiber?.state !== 5;
  const guard = (entry) => {
    if (closed || entry === undefined || releases.has(entry)) return;
    releases.set(entry, guardEntry(entry, upstreamIds, active));
  };
  const entries = () => {
    const loader = ctx.get("loader");
    if (typeof loader?.entries === "function") return [...loader.entries()];
    return Object.values(loader?.store?.include?.subtree?.store ?? {});
  };
  const stop = (entry) => {
    guard(entry);
    return suppressEntry(entry, upstreamIds, { strict: true, isActive: active });
  };
  ctx.effect(() => () => {
    closed = true;
    for (const release of releases.values()) release();
    releases.clear();
  });
  ctx.on("loader/entry-init", (entry) => {
    // New entries announced while this wrapper runs can be stopped before their
    // first update. Initial boot constructs ALL entries before apply(), so that
    // boot also needs the awaited sweep below.
    guard(entry);
    queueMicrotask(() => {
      if (!closed) void stop(entry).catch(() => {});
    });
  });
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  queueMicrotask(async () => {
    let mounted = false;
    try {
      if (!active()) return;
      await Promise.all(entries().filter((entry) => upstreamIds.includes(entry.options?.id)).map(stop));
      if (!active()) return;
      for (const [plugin, config] of children) ctx.plugin(plugin, config);
      mounted = true;
    } catch (error) {
      console.warn("bili-context-patch: startup failed: " + error.message);
    } finally {
      resolveReady(mounted);
    }
  });
  return { ready, isActive: active };
}
