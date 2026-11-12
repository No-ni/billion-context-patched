#!/usr/bin/env node
// Exercise shipped rendering, preflight and response functions with an isolated
// transcript/store and summary service. No user database or model is contacted.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(process.argv[2] ?? new URL("../vendor/billion-context/dist/index.js", import.meta.url), "latin1");
const span = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, "missing build span: " + start);
  return source.slice(a, b);
};
const helpers = span("// <bili-preflight begin>", "// <bili-preflight end>") + "// <bili-preflight end>";
const block = readFileSync(new URL("../patches/preflight.block.js", import.meta.url), "utf8").trimEnd();
const escaped = block.replace(/[^ -~\n]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase());
assert.equal(helpers, escaped, "shipped helpers must match the replaceable block");
const rendering = span("function __biliPrefixDigest(", "const __biliPinnedViews=") +
  "const __biliPinnedViews=new Map();" +
  span("function legacyFor(", "function parseRow(") +
  span("function parseRow(", "var SnapshotAnchorFallbackError=") +
  span("function buildAnchoredView(", "function __biliPluginLaneSnapshot(") +
  span("function maybeSnapshotView(", "function shadowLaneEnabled(");
const preflight = span("async function preflightCompressIfNeeded(", "var CONTEXTUAL_USER_FRAGMENT_MARKERS=");
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
  const session = { id: "test", metadata: {}, stats: { requests: 0, lastInputTokens: 80, lastInputTokensSource: "usage" },
    state: { blocks: [{ ...old }] } };
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
  const api = runInNewContext(rendering + "\n" + helpers + "\n" + preflight + "\n" + responses +
    "\n({maybeSnapshotView,__biliRecoverSnapshot,__biliReplyPreflight,emitPreflightError,preflightCompressIfNeeded});", {
    require: createRequire(import.meta.url), getStore: () => store,
    MAX_CHAIN_WALK: 8192, MIN_SEAM_RUN: 2, __biliPinLog() {}, console: { warn() {} },
    identitySig: m => `${m.role}|${m.contentType}|${m.text}`,
    featureEnabled: () => options.live !== false, shadowLaneEnabled: () => false,
    __biliPluginLaneSnapshot: () => options.lane !== false, noteRender() {}, noteShadow() {},
    AbortController, setTimeout, clearTimeout, safeWrite: (res, data) => res.write(data),
    autoFoldEngaged: () => false, limitsMaxMessages: () => 0, codexHealthBarApplies: () => false,
    normalizeUpstreamOrigin: value => value, currentCalibrationFactor: () => 1,
    applyEstimateCalibration: value => value,
    outboundPayloadBreakdown: p => ({ textEstimate: estimate(p.processedMessages), overheadEstimate: options.overhead ?? 0, imageTokens: options.images ?? 0 }),
    estimateCoreMessages: estimate, localRefusalCovers: () => false,
    buildForwardTarget: () => ({ upstreamUrl: "https://example.invalid", headers: {} }),
    registerRequestAbort() {}, preflightHoldGraceMs2: () => 10000,
    resolveCompress: () => ({}), inboundResignCredential: () => undefined,
    defaultPrompts: {}, externalQueueDroppedAll: () => false,
    preflightCompress: async () => {
      compressions++;
      return { compressedRanges: 0, savedTokens: 0, payloadEstimate: 300, fitsWindow: false,
        rangesRemaining: 0, failure: options.failure };
    },
    estimateRawBodyBreakdown: () => ({ total: 300 }), outputBudgetField: () => null,
    buildWindowShrinkNote: () => "", noteLocalRefusal: () => { session.refused = true; },
  });
  const prepare = async () => {
    prepares++; session.stats.requests++;
    const originalMessages = options.messages ?? all;
    const processedMessages = api.maybeSnapshotView(session, originalMessages, { pluginMode: true });
    return { session, processedMessages, originalMessages, body: "{}", pluginMode: true,
      protocol: options.protocol ?? "openai", stream: true };
  };
  const res = new Response();
  const run = prepared => api.preflightCompressIfNeeded(prepared, prepare, { headers: {}, url: "/chat/completions" },
    Buffer.from("{}"), res, { routes: {} }, {}, { modelContextLimit: 100 }, 100,
    "test-model", 100, undefined, undefined, undefined, false, () => {}, "test-instance");
  return { api, session, prepare, res, run, counts: () => ({ waits, prepares, compressions }) };
}
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log("  OK " + name); };
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
await check("deterministic oversized input stays 413 and upstream auth is not retried", async () => {
  for (const [failure, status, retryable] of [
    [{ kind: "exhausted", deterministic: true, retryable: false }, 413, false],
    [{ kind: "upstream", status: 401, retryable: false }, 502, false],
    [{ kind: "upstream", status: 429, retryable: true }, 502, true],
  ]) {
    const f = fixture({ failure });
    const out = await f.run(await f.prepare());
    assert.equal(out.status, status); assert.equal(out.retryable, retryable);
    assert.equal(f.session.refused === true, status === 413);
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
console.log(`preflight checks passed (${checks})`);
