#!/usr/bin/env node
// Exercise shipped rendering, preflight and response functions with an isolated
// transcript/store and summary service. No user database or model is contacted.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext, Script } from "node:vm";
import { createGunzip, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { uniqueBlockSpan } from "./patch-bili-client.mjs";
import { assertResponsesWsLocalErrors } from "./fixtures/ux-ws-local-errors.mjs";

const source = readFileSync(process.argv[2] ?? new URL("../vendor/billion-context/dist/index.js", import.meta.url), "latin1");
const span = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, "missing build span: " + start);
  return source.slice(a, b);
};
// Read the shipped seam knobs instead of injecting literals: B10 forbids proving
// image integrity by lowering the minimum seam run, so the harness has to judge
// the value the build actually ships.
const buildKnob = (name) => {
  const text = source.match(new RegExp("(?<![\\w$])" + name + "=[^,;]*"));
  assert(text, "missing build constant " + name);
  return runInNewContext(source.slice(text.index + name.length + 1, text.index + text[0].length));
};
const helpers = span("// <bili-preflight begin>", "// <bili-preflight end>") + "// <bili-preflight end>";
const block = readFileSync(new URL("../patches/preflight.block.js", import.meta.url), "utf8").trimEnd();
const escaped = block.replace(/[^ -~\n]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase());
assert.equal(helpers, escaped, "shipped helpers must match the replaceable block");
const rendering = uniqueBlockSpan(source, "message identity", "function identitySig(", { expression: true }).block +
  span("function __biliPrefixDigest(", "const __biliPinnedViews=") +
  "const __biliPinnedViews=new Map();" +
  span("function legacyFor(", "function parseRow(") +
  span("function parseRow(", "var SnapshotAnchorFallbackError=") +
  span("function buildAnchoredView(", "function __biliPluginLaneSnapshot(") +
  span("function maybeSnapshotView(", "function shadowLaneEnabled(");
// The preflight body measures the Responses wire directly; those two helpers
// live just above it and are part of the same behaviour (#7537 wire meter).
const preflight = span("function measuredOutbound(", "async function preflightCompressIfNeeded(") +
  span("async function preflightCompressIfNeeded(", "var CONTEXTUAL_USER_FRAGMENT_MARKERS=");
const compression = uniqueBlockSpan(source, "preflight compressor", "async function preflightCompress(", { expression: true }).block;
const responses = span("function emitPreflightError(", "var reports=");
class Response extends EventEmitter {
  headersSent = false; writableEnded = false; destroyed = false;
  headers = {}; chunks = [];
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(chunk) { this.chunks.push(chunk); }
  end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
  close() { this.destroyed = true; this.emit("close"); }
}
const msg = id => ({ id, role: "user", contentType: "text", text: id });
const all = ["a", "b", "c", "d"].map(msg);
const old = { blockId: "old", effectiveMessageIds: ["a", "b"], active: true };
function fixture(options = {}) {
  let db = options.db ?? all.slice(2), waits = 0, prepares = 0, compressions = 0;
  const rows = () => db.map((m, seq) => ({ seq, msgId: m.id, content: JSON.stringify(m) }));
  const session = { id: "test", metadata: {}, stats: { requests: 0, lastInputTokens: options.anonymous ? 0 : 80, lastInputTokensSource: "usage" },
    state: { blocks: [{ ...old }] } };
  // A stated wall is upstream evidence (an overflow arm already proved the
  // window); without it the preflight forwards once instead of refusing (#7537).
  if (options.arm > 0) session.stats.overflowArmTokens = options.arm;
  const store = {
    unifiedMessageIdRows: rows, unifiedMessageRows: rows,
    unifiedTailSeqs: () => db.map((_, seq) => seq),
    unifiedUncoveredRows: (_, intervals) => rows().filter(r => !intervals.some(([a, b]) => r.seq >= a && r.seq <= b)),
    afterNextFlush: id => {
      assert.equal(id, session.id); waits++;
      if (options.flush) return options.flush();
      if (options.recover) db = all;
      return true;
    },
  };
  const estimate = messages => messages.some(m => m.id === "acp_summary_old") ? 30 : 300;
  const context = {
    require: createRequire(import.meta.url), getStore: () => store, markDirty: current => options.onDirty?.(current),
    MAX_CHAIN_WALK: buildKnob("MAX_CHAIN_WALK"), MIN_SEAM_RUN: buildKnob("MIN_SEAM_RUN"), __biliPinLog() {}, console: { warn() {} },
    sha256Hex2: value => createHash("sha256").update(value).digest("hex"),
    featureEnabled: () => options.live !== false, shadowLaneEnabled: () => false,
    resolveStorageModeSafe: () => options.mode ?? "full",
    __biliPluginLaneSnapshot: () => options.lane !== false, noteRender() {}, noteShadow() {},
    AbortController, setTimeout, clearTimeout, safeWrite: (res, data) => res.write(data),
    autoFoldEngaged: () => false, limitsMaxMessages: () => 0, codexHealthBarApplies: () => false,
    normalizeUpstreamOrigin: value => value, currentCalibrationFactor: () => 1,
    applyEstimateCalibration: value => value,
    outboundPayloadBreakdown: p => ({ textEstimate: estimate(p.processedMessages), overheadEstimate: options.overhead ?? 0, imageTokens: options.images ?? 0 }),
    imageReserveFor: () => options.rebuiltImages ?? options.images ?? 0,
    estimateCoreMessages: estimate, estimateCoreMessagesUpper: estimate, localRefusalCovers: () => false,
    buildForwardTarget: () => ({ upstreamUrl: "https://example.invalid", headers: {} }),
    registerRequestAbort() {}, noteClientAbort() {}, preflightHoldGraceMs2: () => 10000,
    resolveCompress: () => ({}), inboundResignCredential: () => undefined,
    defaultPrompts: {}, externalQueueDroppedAll: () => false,
    preflightCompress: async (deps, messages) => {
      compressions++;
      if (options.realCompression) {
        // Run the shipped compressor's existing-block fit exit. It must not call
        // a summary service; only the kernel and storage timing are simulated.
        return runInNewContext(compression + "\npreflightCompress(deps,messages)", {
          deps, messages, epochConfirmPending: () => false,
          currentCalibrationFactor: () => 1, applyEstimateCalibration: value => value,
          estimateCoreMessages: estimate, estimateCoreMessagesUpper: estimate,
          configuredSummaryPlan: () => undefined, defaultCountTokens: text => Math.ceil(text.length / 4),
          deadSkipKeys: () => [], safeHost: () => "example.invalid", readDeterministicProbeState: () => undefined,
          MIN_CHUNK_TOKENS: 1, CHUNK_FRACTION: 0.5, TRANSIENT_EMPTY_RETRY_BUDGET: 1,
          MAX_SUMMARY_CALLS_PER_PREFLIGHT: 1, MAX_PREFLIGHT_ROUNDS: 1,
          EMERGENCY_FOLD_COVERAGE: 10, DETERMINISTIC_EMPTY_STICKY_LIMIT: 3,
          FIT_FORWARD_ESTIMATE_ONLY_MARGIN: 0.9, yieldToEventLoop: async () => {},
          noEmergencyTruncate: value => value, ccrLoopConfig: (_, config) => config,
          contentStoreOf: () => ({}), adoptContentStore() {}, applyAbsorbView: value => value,
        });
      }
      if (options.recoverInPreflight) db = all;
      if (options.compressionResult) return options.compressionResult;
      return { compressedRanges: 0, savedTokens: 0, payloadEstimate: 300, fitsWindow: false,
        rangesRemaining: 0, failure: options.failure };
    },
    setPostRebuildAnchor() {},
    estimateRawBodyBreakdown: () => { options.onRawEstimate?.(); return { total: 300 }; },
    describeCoreTextDuplication: () => "mock text", measuredBreakdownClause: () => "mock text", outputBudgetField: () => null,
    buildWindowShrinkNote: () => "", noteLocalRefusal: () => { session.refused = true; },
    // Helpers the shipped preflight body calls on these paths (#7537 log lines
    // and the fold-epoch guard). Stubbed like the rest so the harness controls
    // the branch instead of hitting the real I/O.
    maskUrlForLog: () => "https://example.invalid/", epochConfirmPending: () => false,
  };
  const script = rendering + "\n" + helpers + "\n" + preflight + "\n" + responses +
    "\n({maybeSnapshotView,__biliRecoverSnapshot,__biliReplyPreflight,emitPreflightError,preflightCompressIfNeeded,__biliSnapshotAwareTurn});";
  const api = runInNewContext(script, context);
  const prepare = async () => {
    prepares++; session.stats.requests++;
    options.onPrepare?.(session, prepares);
    if (prepares === options.throwOnPrepare) throw new Error("rebuild failed");
    if (prepares === options.failOnPrepare) return { failFast: true, status: 413, message: "rebuild refused", retryable: false };
    const originalMessages = options.messages ?? all;
    const processedMessages = api.maybeSnapshotView(session, originalMessages, { pluginMode: true });
    return { session, processedMessages, originalMessages, body: "{}", pluginMode: true,
      protocol: options.protocol ?? "openai", stream: true };
  };
  const core = { processTurn(input) {
    if (options.recoverInPreflight) db = all;
    return { ...input, messages: [msg("acp_summary_old"), ...all.slice(2)] };
  } };
  const res = new Response();
  const run = prepared => api.preflightCompressIfNeeded(prepared, prepare, { headers: {}, url: "/chat/completions" },
    Buffer.from("{}"), res, { routes: {} }, core, { modelContextLimit: 100, compress: { minCompressRange: 0 } }, 100,
    "test-model", 100, undefined, undefined, undefined, options.anonymous === true, () => {}, "test-instance");
  return { api, session, prepare, res, run, counts: () => ({ waits, prepares, compressions }) };
}
function actualWriterOffSave() {
  const signature = "scheduleSave(session){", at = source.indexOf(signature);
  assert(at >= 0 && source.indexOf(signature, at + 1) < 0, "actual SessionStore.scheduleSave must be unique");
  let method;
  for (let end = source.indexOf("}", at); end >= 0; end = source.indexOf("}", end + 1)) {
    const candidate = source.slice(at, end + 1);
    try { new Script("({" + candidate + "})"); method = candidate; break; }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  assert(method, "complete actual writerOff scheduleSave method missing");
  return runInNewContext("({" + method + "})", { queueMicrotask });
}
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log("  OK " + name); };
await check("index-only persistence receives the corrected replay count on success, fail-fast, throw and disconnect", async () => {
  const writer = actualWriterOffSave();
  const dirty = uniqueBlockSpan(source, "actual markDirty", "function markDirty(session){", { expression: true }).block;
  for (const outcome of ["success", "fail-fast", "throw", "disconnect"]) {
    const session = { id: "writer-off-" + outcome, metadata: { snapshotRenderDegradeReason: "block-unanchored" },
      stats: { requests: 1 }, state: { blocks: [{ active: true }] } };
    const saved = [];
    const store = {
      afterNextFlush: () => true, consumePendingLedgerAlign() {}, saveContentStore: () => true,
      writerOffActive: () => true, envelopeFrozen: () => false,
      writerOffPending: new Map(), lastSaveLanded: new Map(), durabilityArms: new Map(),
      guardedBuild: current => () => { saved.push(JSON.parse(JSON.stringify(current.stats))); return { metadata: {} }; },
      maybeCutForkBase() {}, noteMetaFp() {}, noteDurable() {}, runIdleSpillIfIdle() {}, drainFlushWaiters() {}, log() {},
      scheduleSave: writer.scheduleSave,
    };
    const api = runInNewContext(dirty + "\n" + helpers + "\n({__biliRecoverSnapshot});", {
      featureEnabled: () => true, __biliPluginLaneSnapshot: () => true, resolveStorageModeSafe: () => "full",
      getStore: () => store, setTimeout, clearTimeout,
    });
    const res = new Response(), prepared = { session, pluginMode: true };
    const recover = api.__biliRecoverSnapshot(prepared, async () => {
      session.stats.requests++;
      session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
      store.scheduleSave(session);
      if (outcome === "throw") throw new Error("replay failed after its queued save");
      if (outcome === "disconnect") res.close();
      return { ...prepared, ...(outcome === "fail-fast" ? { failFast: true } : {}) };
    }, res, () => {});
    if (outcome === "throw") await assert.rejects(recover, /replay failed/);
    else {
      const result = await recover;
      assert.equal(result === null, outcome === "disconnect");
      if (outcome === "fail-fast") assert.equal(result.failFast, true);
    }
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(session.stats.requests, 1);
    assert(saved.length >= 2, "actual writerOff pass must persist the replay and its correction");
    assert.equal(saved.at(-1).requests, 1, outcome + " cold-load request count");
    assert.equal(res.listenerCount("close"), 0);
  }
});
await check("fresh read misses defer destructive kernel work, while opt-outs, edits and valid views retain it", async () => {
  assert.equal(source.split('const turn=__biliSnapshotAwareTurn(session,core,{messages:renderMsgs').length - 1, 4);
  for (const protocol of ["openai", "responses", "anthropic", "google"]) {
    const f = fixture({ recover: true, protocol });
    const prepared = await f.prepare();
    const before = f.session.state;
    before.messageRefs = { byRaw: { a: "m00001" }, byRef: { m00001: "a" } };
    before.tsStamps = { a: 100 };
    const bytes = JSON.stringify(before);
    let runs = 0;
    const core = { processTurn(input) { runs++; return { ...input, kernelRan: true }; } };
    const deferred = f.api.__biliSnapshotAwareTurn(f.session, core, {
      messages: prepared.processedMessages, state: before, contentStore: {},
    });
    assert.equal(runs, 0); assert.equal(deferred.__biliSnapshotDeferred, true);
    assert.equal(deferred.state, before); assert.equal(JSON.stringify(before), bytes);
    const recovered = await f.api.__biliRecoverSnapshot(prepared, f.prepare, f.res, () => {});
    const real = f.api.__biliSnapshotAwareTurn(f.session, core, { messages: recovered.processedMessages, state: before });
    assert.equal(runs, 1); assert.equal(real.kernelRan, true);
    assert.equal(f.session.stats.requests, 1);
  }
  for (const options of [{ live: false }, { lane: false }, { mode: "legacy" }, { db: all, messages: [all[3]] }]) {
    const f = fixture(options), prepared = await f.prepare();
    let runs = 0;
    const real = f.api.__biliSnapshotAwareTurn(f.session, { processTurn(input) { runs++; return input; } },
      { messages: prepared.processedMessages, state: f.session.state });
    assert.equal(runs, 1); assert.equal(real.__biliSnapshotDeferred, undefined);
    if (options.mode === "legacy") {
      assert.equal(await f.api.__biliRecoverSnapshot(prepared, f.prepare, f.res, () => {}), prepared);
      assert.equal(f.counts().waits, 0);
    }
  }
  const f = fixture(), p = await f.prepare();
  f.session.state.blocks = [];
  let runs = 0;
  f.api.__biliSnapshotAwareTurn(f.session, { processTurn(input) { runs++; return input; } }, { messages: p.processedMessages, state: f.session.state });
  assert.equal(runs, 1, "a legitimate rebase removing all active blocks must still enter the kernel");
});
await check("all four protocols recover missing transcript rows before size judgement", async () => {
  for (const protocol of ["openai", "responses", "anthropic", "google"]) {
    const f = fixture({ recover: true, protocol });
    const raw = await f.prepare();
    assert.equal(f.session.metadata.snapshotRenderDegradeReason, "block-unanchored");
    assert.equal(raw.processedMessages.length, 4);
    const out = await f.run(raw);
    assert.deepEqual(Array.from(out.processedMessages, m => m.id), ["acp_summary_old", "c", "d"]);
    assert.equal(out.failFast, undefined);
    assert.deepEqual(f.counts(), { waits: 1, prepares: 2, compressions: 0 });
    assert.equal(f.session.stats.requests, 1);
    assert.equal(f.res.listenerCount("close"), 0);
  }
});
await check("persistent missing rows fail after one replay and remain retryable", async () => {
  const f = fixture();
  const out = await f.run(await f.prepare());
  assert.equal(out.status, 502); assert.equal(out.retryable, true);
  assert.equal(out.rangesRemaining, undefined);
  assert.match(out.message, /0 compressible range/);
  assert.deepEqual(f.counts(), { waits: 1, prepares: 2, compressions: 1 });
  assert.equal(f.session.stats.requests, 1);
});
await check("an existing-block fit with zero new folds rebuilds the actual outbound for all four protocols", async () => {
  for (const protocol of ["openai", "responses", "anthropic", "google"]) {
    const f = fixture({ protocol, flush: () => false, realCompression: true, recoverInPreflight: true });
    const out = await f.run(await f.prepare());
    assert.equal(out.failFast, undefined);
    assert.deepEqual(Array.from(out.processedMessages, m => m.id), ["acp_summary_old", "c", "d"]);
    assert.deepEqual(f.counts(), { waits: 1, prepares: 2, compressions: 1 });
    assert.equal(f.session.stats.requests, 1);
  }
});
await check("an internal fit cannot forward a still-degraded rebuilt payload", async () => {
  const f = fixture({ flush: () => false, realCompression: true });
  const out = await f.run(await f.prepare());
  assert.equal(out.status, 502);
  assert.equal(out.retryable, true);
  assert.deepEqual(f.counts(), { waits: 1, prepares: 2, compressions: 1 });
  assert.equal(f.session.stats.requests, 1);
});
await check("a failed zero-fold rebuild restores the request count", async () => {
  const f = fixture({ flush: () => false, realCompression: true, throwOnPrepare: 2 });
  await assert.rejects(f.run(await f.prepare()), /rebuild failed/);
  assert.equal(f.session.stats.requests, 1);
});
await check("corrective probes persist one request on success, fail-fast, throw and disconnect", async () => {
  const writer = actualWriterOffSave();
  for (const outcome of ["success", "fail-fast", "throw", "disconnect"]) {
    const saved = [];
    const store = {
      consumePendingLedgerAlign() {}, saveContentStore: () => true,
      writerOffActive: () => true, envelopeFrozen: () => false,
      writerOffPending: new Map(), lastSaveLanded: new Map(), durabilityArms: new Map(),
      guardedBuild: current => () => { saved.push(JSON.parse(JSON.stringify(current.stats))); return { metadata: {} }; },
      maybeCutForkBase() {}, noteMetaFp() {}, noteDurable() {}, runIdleSpillIfIdle() {}, drainFlushWaiters() {}, log() {},
      scheduleSave: writer.scheduleSave,
    };
    const dirty = uniqueBlockSpan(source, "actual corrective markDirty", "function markDirty(session){", { expression: true }).block;
    const mark = runInNewContext(dirty + "\nmarkDirty", { getStore: () => store });
    const f = fixture({ flush: () => false, recoverInPreflight: true,
      compressionResult: { compressedRanges: 1, savedTokens: 270, payloadEstimate: 30, fitsWindow: true, rangesRemaining: 1 },
      throwOnPrepare: outcome === "throw" ? 2 : undefined,
      failOnPrepare: outcome === "fail-fast" ? 2 : undefined,
      onDirty: mark,
      onPrepare(session, round) {
        session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
        store.scheduleSave(session);
        if (round === 2 && outcome === "disconnect") f.res.close();
      },
    });
    const run = f.run(await f.prepare());
    if (outcome === "throw") await assert.rejects(run, /rebuild failed/);
    else {
      const result = await run;
      if (outcome === "success") assert.equal(result.failFast, undefined);
      if (outcome === "fail-fast") { assert.equal(result.status, 413); assert.equal(result.message, "rebuild refused"); }
      if (outcome === "disconnect") { assert.equal(result.failFast, true); assert.equal(result.respond, false); }
    }
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(f.session.stats.requests, 1, outcome + " in-memory count");
    assert(saved.some(stats => stats.requests === 2), "actual writer must exercise the replay microtask race");
    assert.equal(saved.at(-1).requests, 1, outcome + " cold-load count");
    assert.equal(f.counts().prepares, 2);
  }
});
await check("anonymous zero-fold rebuild uses the rebuilt image reserve", async () => {
  let measured = 0;
  const f = fixture({ anonymous: true, images: 80, rebuiltImages: 0, onRawEstimate: () => measured++, flush: () => false,
    compressionResult: { compressedRanges: 0, savedTokens: 0, payloadEstimate: 30, fitsWindow: true, rangesRemaining: 0 },
    recoverInPreflight: true });
  const result = await f.run(await f.prepare());
  assert.equal(result.failFast, undefined);
  // A proven fit returns before the speculative measured-body/doom path.
  // Removing the old image reserve is what makes 30 text tokens fit in 100.
  assert.deepEqual(Array.from(result.processedMessages, m => m.id), ["acp_summary_old", "c", "d"]);
  assert.equal(measured, 0, "proven rebuilt fit must not enter size arbitration");
  assert.equal(f.session.stats.lastInputTokens, 30);
  assert.equal(f.session.stats.requests, 1);
});
await check("unsafe seams and skipped-block coverage still reject the view", async () => {
  for (const options of [
    { db: all, messages: [all[3]], reason: "seam-too-short" },
    { db: all.slice(0, 3), messages: [all[0], all[1], msg("x"), all[2]], reason: "skipped-block-not-in-tail" },
  ]) {
    const f = fixture(options);
    if (options.reason === "skipped-block-not-in-tail") f.session.state.blocks.push({ blockId: "new", effectiveMessageIds: ["x"], active: true });
    const out = await f.run(await f.prepare());
    assert.equal(f.session.metadata.snapshotRenderDegradeReason, options.reason);
    assert.equal(out.status, 502); assert.equal(out.retryable, false);
    assert.equal(f.counts().prepares, 2);
  }
});
await check("a proven wall is the only local 413; upstream auth is not retried", async () => {
  // #7537 removed estimate-based local refusals: a 413 now needs upstream
  // evidence - an overflow arm that already stated this window.
  const proven = fixture({ failure: { kind: "exhausted", deterministic: true, retryable: false }, arm: 100 });
  const refused = await proven.run(await proven.prepare());
  assert.equal(refused.status, 413); assert.equal(refused.retryable, false);
  assert.equal(proven.session.refused, true);

  const unproven = fixture({ failure: { kind: "exhausted", deterministic: true, retryable: false } });
  const forwarded = await unproven.run(await unproven.prepare());
  assert.equal(forwarded.status, undefined, "no local 413 without a stated upstream wall");
  assert.equal(unproven.session.refused, undefined);

  for (const [failure, status, retryable] of [
    [{ kind: "upstream", status: 401, retryable: false }, 502, false],
    [{ kind: "upstream", status: 429, retryable: true }, 502, true],
  ]) {
    const f = fixture({ failure });
    const out = await f.run(await f.prepare());
    assert.equal(out.status, status); assert.equal(out.retryable, retryable);
    assert.equal(f.session.refused, undefined);
  }
  for (const options of [{ images: 120 }, { overhead: 120 }]) {
    const f = fixture(options);
    const out = await f.run(await f.prepare());
    assert.equal(out.retryable, false, "irreducible image/wire overhead must not trigger snapshot retries");
  }
});
await check("disabled snapshots, passthrough, no blocks and a valid sticky view do not replay", async () => {
  for (const options of [{ live: false }, { lane: false }, { passthrough: true }, { noBlocks: true }, { sticky: true }]) {
    const f = fixture(options);
    const p = await f.prepare();
    f.session.metadata.snapshotRenderDegradeReason = "block-unanchored";
    if (options.passthrough) p.sidePassthrough = true;
    if (options.noBlocks) f.session.state.blocks = [];
    if (options.sticky) f.session.metadata.snapshotRenderTailStart = 3;
    assert.equal(await f.api.__biliRecoverSnapshot(p, f.prepare, f.res, () => {}), p);
    assert.deepEqual(f.counts(), { waits: 0, prepares: 1, compressions: 0 });
  }
});
await check("failed saves skip replay and remove the recovery close listener", async () => {
  for (const flush of [() => false, () => { throw new Error("unavailable"); }, () => Promise.reject(new Error("write failed"))]) {
    const f = fixture({ flush });
    const p = await f.prepare();
    assert.equal(await f.api.__biliRecoverSnapshot(p, f.prepare, f.res, () => {}), p);
    assert.equal(f.counts().prepares, 1);
    assert.equal(f.res.listenerCount("close"), 0);
  }
});
await check("a stalled save is bounded to one second and a late save does not replay", async () => {
  let finish;
  const f = fixture({ flush: () => new Promise(resolve => { finish = resolve; }) });
  const p = await f.prepare(), start = Date.now();
  assert.equal(await f.api.__biliRecoverSnapshot(p, f.prepare, f.res, () => {}), p);
  assert(Date.now() - start >= 900 && Date.now() - start < 3000);
  finish(true); await Promise.resolve();
  assert.equal(f.counts().prepares, 1); assert.equal(f.res.listenerCount("close"), 0);
});
await check("disconnect cancels recovery and replay exceptions preserve the request count", async () => {
  let finish;
  const f = fixture({ flush: () => new Promise(resolve => { finish = resolve; }) });
  const p = await f.prepare();
  const pending = f.run(p);
  f.res.close();
  const out = await pending;
  assert.equal(out.respond, false); assert.equal(out.status, 0);
  finish(true); await Promise.resolve();
  assert.equal(f.counts().prepares, 1); assert.equal(f.res.listenerCount("close"), 0);
  const g = fixture(), q = await g.prepare();
  await assert.rejects(g.api.__biliRecoverSnapshot(q, async () => {
    g.session.stats.requests++; throw new Error("prepare failed");
  }, g.res, () => {}), /prepare failed/);
  assert.equal(g.session.stats.requests, 1); assert.equal(g.res.listenerCount("close"), 0);
});
await check("HTTP and committed streams preserve Chinese, detail, retryable and 413/502", async () => {
  const { api } = fixture();
  const dispatch = span("if(res.headersSent&&prepared.stream){emitPreflightError(", "logRequestCost(log2,session.id,inboundMsgs,inboundBytes,reqT0)");
  // Remove the enclosing response guard from runPreparedPipeline.
  assert(dispatch.endsWith("}}"));
  const respond = dispatch.slice(0, -1);
  for (const status of [413, 502, 503]) for (const retry of [false, true]) {
    const outcome = { status, message: "English diagnostics", retryable: retry };
    const expectedRetry = status !== 413 && retry;
    for (const protocol of ["openai", "responses", "anthropic", "google"]) for (const committed of [false, true]) {
      const res = new Response(); res.headersSent = committed;
      runInNewContext(respond, { res, outcome, prepared: { stream: true, protocol }, log2() {},
        emitPreflightError: api.emitPreflightError, __biliReplyPreflight: api.__biliReplyPreflight });
      assert(res.writableEnded); assert.equal(res.headers["retry-after"], undefined);
      const body = res.chunks.join("");
      const json = committed ? JSON.parse(body.match(/^data: (\{.*\})/m)[1]) : JSON.parse(body);
      const error = json.error ?? json;
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert(!error.message.includes("English"));
      assert.equal(error.detail, outcome.message); assert.equal(error.retryable, expectedRetry);
      if (protocol !== "google" || !committed) assert.equal(error.code, "preflight_compress_failed");
      else assert.equal(error.code, status === 413 ? 413 : 502);
      if (!committed) assert.equal(res.status, status === 413 ? 413 : 502);
    }
    const res = new Response(); res.headersSent = true;
    runInNewContext(respond, { res, outcome, prepared: { stream: false }, __biliReplyPreflight: api.__biliReplyPreflight });
    assert.equal(JSON.parse(res.chunks[0]).error.retryable, expectedRetry);
  }
});
await check("decoded-body backpressure keeps its guard and delegates retries without retry-after", () => {
  const busy = span('if(err2 instanceof DecodedRequestBusyError){', 'if(err2 instanceof BodyTooLargeError||');
  const res = new Response(), err2 = new Error("decoded budget busy");
  const code = "(function(){" + busy + "})()";
  runInNewContext(code, { err2, res, DecodedRequestBusyError: Error, log2() {} });
  assert.equal(res.status, 502); assert.equal(res.headers["retry-after"], undefined);
  const error = JSON.parse(res.chunks[0]).error;
  assert.equal(error.type, "request_body_busy"); assert.equal(error.retryable, true);
  assert.equal(error.detail, err2.message); assert.match(error.message, /[\u4e00-\u9fff]/);
});
await check("actual receive, gzip decode and ingest limits keep 413/stage with Chinese messages and original detail", async () => {
  const extract = (signature, wrap = code => code) => {
    const at = source.indexOf(signature);
    assert(at >= 0 && source.indexOf(signature, at + 1) < 0, "unique compiled ingress block: " + signature);
    for (let end = source.indexOf("}", at); end >= 0; end = source.indexOf("}", end + 1)) {
      const code = source.slice(at, end + 1);
      try { new Script(wrap(code)); return code; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    assert.fail("complete compiled ingress block: " + signature);
  };
  const classes = ["BodyTooLargeError", "DecompressedTooLargeError", "IngestBodyTooLargeError"]
    .map(name => extract("var " + name + "=class extends Error{")).join("\n");
  const functions = ["readBody", "streamDecode", "decodeOne", "decodeRequestBody"].map(name => {
    let signature = "function " + name + "(";
    if (source.slice(source.indexOf(signature) - 6, source.indexOf(signature)) === "async ") signature = "async " + signature;
    return extract(signature);
  }).join("\n");
  const wrap = code => "(function(){" + code + "})";
  const main = extract("if(err2 instanceof BodyTooLargeError||err2 instanceof DecompressedTooLargeError||err2 instanceof IngestBodyTooLargeError){", wrap);
  const incremental = extract("if(!res.destroyed&&!res.writableEnded){const tooLarge=err2 instanceof BodyTooLargeError;", wrap);
  const statement = /const ingestCap=protocol==="responses"\?0:([A-Za-z_$][\w$]*)\(\);/.exec(source);
  assert(statement, "actual text-only ingest gate");
  const ingest = extract(statement[0], wrap);
  const decoderZlib = /streamDecode\((\w+)\.createGunzip,/.exec(functions);
  const context = { Buffer, createGunzip, limitsReceiveBytes: () => 64, log2() {},
    ...(decoderZlib ? { [decoderZlib[1]]: createRequire(import.meta.url)("node:zlib") } : {}) };
  const api = runInNewContext(classes + "\n" + functions +
    "\n({readBody,decodeRequestBody,BodyTooLargeError,DecompressedTooLargeError,IngestBodyTooLargeError});", context);
  const emit = (err2, stage, branch = main) => {
    const res = new Response();
    runInNewContext(helpers + "\n" + wrap(branch) + "()", { ...context, ...api, err2, res });
    assert.equal(res.status, 413); assert.equal(res.headers["retry-after"], undefined);
    const error = JSON.parse(res.chunks[0]).error;
    assert.equal(error.type, "request_too_large"); assert.equal(error.stage, stage);
    assert.match(error.message, /[\u4e00-\u9fff]/); assert(!error.message.includes(err2.message));
    assert.equal(error.detail, err2.message);
  };
  // The real reader destroys an oversized request. Record that operation here;
  // on a real socket it may reset before the attempted receive 413 arrives.
  const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
  const receiving = api.readBody(req);
  req.emit("data", Buffer.alloc(65, 65));
  await assert.rejects(receiving, error => {
    assert(req.destroyed); assert(error instanceof api.BodyTooLargeError);
    emit(error, "receive"); emit(error, "receive", incremental); return true;
  });
  const atCap = new EventEmitter(); atCap.destroy = () => assert.fail("exact receive limit must pass");
  const accepted = api.readBody(atCap); atCap.emit("data", Buffer.alloc(64, 65)); atCap.emit("end");
  assert.equal((await accepted).length, 64);
  const bytes = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "A".repeat(1024) }] }));
  const decoded = await api.decodeRequestBody("gzip", gzipSync(bytes), bytes.length);
  assert.equal(decoded.decoded, true); assert.equal(decoded.body.compare(bytes), 0);
  await assert.rejects(api.decodeRequestBody("gzip", gzipSync(bytes), 64), error => {
    assert(error instanceof api.DecompressedTooLargeError); emit(error, "decode"); return true;
  });
  const gate = (protocol, cap, images) => runInNewContext(wrap(ingest) + "()", {
    ...context, ...api, protocol, decoded, [statement[1]]: () => cap, countImagesInRawBody: () => images,
  });
  for (const protocol of ["openai", "anthropic", "google"]) {
    assert.throws(() => gate(protocol, 64, 0), error => {
      assert(error instanceof api.IngestBodyTooLargeError); emit(error, "ingest"); return true;
    });
    gate(protocol, 64, 1); gate(protocol, 0, 0); gate(protocol, bytes.length, 0);
  }
  gate("responses", 64, 0);
  const invalid = new Response();
  runInNewContext(wrap(incremental) + "()", { ...context, ...api, res: invalid, err2: new Error("stream failed") });
  assert.equal(invalid.status, 400); assert.equal(JSON.parse(invalid.chunks[0]).error.type, "invalid_request");
  const closed = new Response(); closed.destroyed = true;
  runInNewContext(wrap(incremental) + "()", { ...context, ...api, res: closed, err2: new api.BodyTooLargeError(64) });
  assert.equal(closed.chunks.length, 0);
});
await check("actual side-request classification and window guard preserve short Chinese 413 with diagnostic detail", () => {
  const names = ["defaultCountTokens", "isNonModelTopLevelKey", "estimateRawBodyTokens", "outputBudgetField", "readOutputBudget",
    "isServerToolUtilityCall", "isStructuredOutputCall", "isAudioOutputCall", "isSideRequest", "resolveSideLane", "sideRequestGuard"];
  const formats = source.match(/var STRUCTURED_FORMAT_TYPES=new Set\(\[[^\]]+\]\);/g);
  assert.equal(formats?.length, 1, "actual structured-output formats must be unique");
  const serverToolTypes = source.match(/var SERVER_EXECUTED_TOOL_TYPES=\/[^;]+;/g);
  assert.equal(serverToolTypes?.length, 1, "actual server-executed tool types must be unique");
  // The body meter ignores provider bookkeeping keys; its set has to travel with
  // the function, exactly like the other module-scope tables here.
  const nonModelKeys = source.match(/var NON_MODEL_TOP_LEVEL_KEYS=new Set\(\[[^\]]+\]\);/g);
  assert.equal(nonModelKeys?.length, 1, "actual non-model top-level keys must be unique");
  const functions = formats[0] + serverToolTypes[0] + nonModelKeys[0] + names.map(name => uniqueBlockSpan(source, name, "function " + name + "(", { expression: true }).block).join("\n");
  const context = { NON_TEXT_BODY_KEYS: new Set(["data", "url", "b64_json", "file_data", "image_url"]),
    SIDE_REQUEST_AGENTS: new Set(["title"]), SIDE_REQUEST_MAX_TOKENS: 200, SIDE_REQUEST_GUARD_TOLERANCE: 1.15 };
  const api = runInNewContext(functions + "\n({isAudioOutputCall,isSideRequest,resolveSideLane,sideRequestGuard});", context);
  const parsed = { model: "mock-32k", max_tokens: 128, messages: [{ role: "user", content: "A".repeat(160000) }] };
  const sideIntent = api.isSideRequest(parsed);
  assert.equal(sideIntent, true);
  const structured = { response_format: { type: "json_schema" }, messages: [] };
  assert(api.isSideRequest(structured));
  assert(!api.isSideRequest({ ...structured, tools: [{ type: "function" }] }));
  assert(!api.isSideRequest(structured, "main"));
  const tts = { model: "tts", messages: [{ role: "user", content: "Speak this" }], audio: { format: "mp3", voice: "alloy" } };
  assert(api.isAudioOutputCall(tts));
  assert(api.isSideRequest(tts));
  assert(!api.isAudioOutputCall({ ...tts, audio: {} }));
  assert(!api.isAudioOutputCall({ ...tts, tools: [{ type: "function" }] }));
  assert(!api.isSideRequest({ ...tts, tools: [{ type: "function" }] }));
  assert.equal(api.resolveSideLane({ protocol: "openai", countTokens: false, responsesCompact: false, stripApplied: false, sideIntent }).lane, "side");
  const guard = api.sideRequestGuard(parsed, "openai", 32768, "bytes", undefined, 1, 0, 0, false);
  assert.equal(guard.blocked, true); assert(guard.estimate > guard.limit);
  const branch = span("if(guard.blocked){", "const sideReason=sideLane.reason;");
  assert.equal(source.split("if(guard.blocked){").length - 1, 1);
  new Script("(function(){" + branch + "})");
  const res = new Response();
  runInNewContext(helpers + "\n(function(){" + branch + "})()", { ...context, guard, res, parsed,
    reqModel: parsed.model, session: { id: "mock-side-413" }, log2() {}, logRequestCost() {},
    inboundMsgs: parsed.messages, inboundBytes: Buffer.byteLength(JSON.stringify(parsed)), reqT0: 0 });
  assert.equal(res.status, 413); assert.equal(res.headers["retry-after"], undefined);
  const error = JSON.parse(res.chunks[0]).error;
  assert.equal(error.type, "server_error"); assert.equal(error.code, "side_request_payload_too_large");
  assert.equal(error.retryable, false); assert.match(error.message, /[\u4e00-\u9fff]/);
  assert(!error.message.includes("side request payload"));
  assert.match(error.detail, new RegExp("^side request payload ~" + guard.estimate + " tokens"));
  assert(error.detail.includes("effective context window " + guard.limit));
  const fits = { ...parsed, messages: [{ role: "user", content: "small title request" }] };
  assert.equal(api.sideRequestGuard(fits, "openai", 32768, "bytes", undefined, 1, 0, 0, false).blocked, false);
});
await check("complete WS session enforces expanded-body 413 and separates local transport details while retaining 400/403/409", () => assertResponsesWsLocalErrors(source));
await check("model tunnel DNS failures use Chinese 502 with diagnostic metadata, while policy/invalid contracts stay intact", async () => {
  const branch = span("if(route?.tunnel){const verdict=await checkTunnelDestination(route.upstream,", "upstreamOrigin=route?route.upstream");
  assert.equal(source.split("if(route?.tunnel){const verdict=await checkTunnelDestination(route.upstream,").length - 1, 1);
  const say = uniqueBlockSpan(source, "DNS failure text", "function __biliFailureTextZh(", { expression: true }).block;
  const code = say + "\n(async function(){" + branch + "})()";
  new Script(code);
  for (const reason of ["unresolvable", "invalid", "self", "linkLocal", "privateRemote"]) {
    const verdict = { ok: false, code: reason, message: reason === "unresolvable" ? "cannot resolve tunnel destination failed.invalid (ENOTFOUND)" : "original " + reason + " contract" };
    const res = new Response();
    await runInNewContext(code, { URL, res, route: { tunnel: true, upstream: "https://failed.invalid" },
      req: { socket: { localPort: 47321, remoteAddress: "127.0.0.1" } }, opts: { routes: {} },
      checkTunnelDestination: async () => verdict, isLoopbackAddress: () => true,
      tunnelAllowlistFromEnv: () => [], resolveProxyDecision: () => ({}), maskUrlsInText: value => value, log2() {} });
    const body = JSON.parse(res.chunks[0]);
    assert.equal(res.status, reason === "unresolvable" ? 502 : reason === "invalid" ? 400 : 403);
    assert.equal(res.headers["retry-after"], undefined);
    assert.equal(body.code, "tunnel_destination_denied"); assert.equal(body.detail, reason);
    if (reason === "unresolvable") {
      assert.match(body.error, /[\u4e00-\u9fff]/); assert(!body.error.includes("cannot resolve"));
      assert.equal(body.upstreamFailure.kind, "dns"); assert.equal(body.upstreamFailure.host, "failed.invalid");
      assert.equal(body.upstreamFailure.hint, verdict.message);
    } else assert.deepEqual(body, { error: verdict.message, code: "tunnel_destination_denied", detail: reason });
  }
});
console.log(`preflight checks passed (${checks})`);
