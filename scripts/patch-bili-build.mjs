#!/usr/bin/env node
// The changes we make to a billion-context build. Every one of them is
// re-applied by install.mjs after a build lands, so an upstream refresh cannot
// quietly drop them; each step checks its own anchors and stops with a message
// when upstream moved the code it edits.
//
//   1. outbound request-body compression — gzip/brotli before the body leaves
//      the machine, the x-accel-compress directive, the per-request receipt
//      ring and GET /__bili/encode-stats. The block itself lives in
//      patches/outbound-encoding.block.js because it is a single long line.
//
//   2. plugin-lane snapshot render — the dsh shim resends the whole history
//      every turn; snapshot render is skipped on plugin lanes by design, so the
//      outbound prefix was re-derived (and re-folded) each round and the cache
//      seam landed mid-body. The guard now asks a marker file.
//
//   3. fork child renders the parent transcript on its first request — the
//      child has no unified rows until its first save, which is exactly the
//      turn that could have reused the parent's cached prefix.
//   4. fork-pin — patch 3 makes the child render the same transcript, but the
//      rendered view still differs (block anchors, tail split), so the cache
//      seam moves and the first turn misses anyway. The parent's last rendered
//      view is kept here and handed to the child for that one turn, verbatim.
//
//   5. body dump — diagnostics only, writes the outbound body when a marker
//      file exists; off unless someone is comparing two turns.
//
//   6. fork cache-key lineage — the forked session stamps the key its parent
//      actually used, so upstream files both under the same cache entry.
//
//   7. fork timestamps — the child's stamp table starts empty, so inherited
//      messages would be re-stamped at the fork's clock and the tag bytes
//      drift; the parent's stamps are copied for the prefix instead.
//
//   8. sticky view — when the unified transcript cannot anchor a block, the
//      old path hands back the client's messages, which on a plugin lane is the
//      whole raw history and gets refused as over-window; the session's own last
//      rendered view is reused instead.
//
// Usage: node scripts/patch-bili-build.mjs [dist/index.js]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");
let text = readFileSync(target, "latin1");
let changed = false;

const replaceOnce = (label, find, replacement) => {
  const hits = text.split(find).length - 1;
  if (hits !== 1) {
    console.error(label + ': "' + find + '" matched ' + hits + " times, expected 1 — upstream changed, re-derive the patch");
    process.exit(1);
  }
  text = text.replace(find, replacement);
  changed = true;
};

// ── 1. outbound request-body compression ────────────────────────────────────
const BLOCK = readFileSync(join(here, "patches", "outbound-encoding.block.js"), "latin1").replace(/\s+$/, "");
const FETCH_ANCHOR = "async function fetchWithTimeout(";
const ENTER = "checkOutboundBody(opts.body);";
const LOGS_ROUTE = "return sendWebLogs(res,req);";

if (text.includes("var __biliEncZlib=")) {
  console.log("outbound encoding: already patched");
} else {
  if (!text.includes("const require = __biliCreateRequire(import.meta.url);")) {
    console.error("outbound encoding: this build has no module-level require — the block would not resolve node:zlib");
    process.exit(1);
  }
  replaceOnce("outbound encoding", FETCH_ANCHOR, BLOCK + "\n" + FETCH_ANCHOR);
  replaceOnce("outbound encoding", ENTER, ENTER + "__biliEncodeOutbound(opts,url);");
  replaceOnce(
    "outbound encoding",
    LOGS_ROUTE,
    LOGS_ROUTE + 'if(req.method==="GET"&&req.url?.startsWith("/__bili/encode-stats"))return __biliSendEncStats(res,req);',
  );
  console.log("outbound encoding: patched");
}

// ── 2. the plugin-lane guard ────────────────────────────────────────────────
const ORIGINAL = "if(deps.pluginMode)return clientMsgs;";
const PATCHED = "if(deps.pluginMode&&!__biliPluginLaneSnapshot())return clientMsgs;";
const VIEW_ANCHOR = "function maybeSnapshotView(session,clientMsgs,deps){";
const HELPER_LANE =
  'function __biliPluginLaneSnapshot(){const v=process.env.BILI_PLUGIN_SNAPSHOT;if(v==="1")return true;if(v==="0")return false;try{const fs9=require("node:fs"),path9=require("node:path"),os9=require("node:os"),base9=process.env.XDG_CONFIG_HOME||path9.join(os9.homedir(),".config");return fs9.existsSync(path9.join(base9,"billion-context","plugin-lane-snapshot.on"))}catch{return false}}';

if (text.includes(PATCHED) && text.includes("function __biliPluginLaneSnapshot()")) {
  console.log("plugin-lane snapshot: already patched");
} else {
  if (text.split(ORIGINAL).length !== 2) {
    console.error("plugin-lane snapshot: expected exactly one guard, found " + (text.split(ORIGINAL).length - 1) + " — upstream changed, re-derive the patch");
    process.exit(1);
  }
  if (text.split(VIEW_ANCHOR).length !== 2) {
    console.error("plugin-lane snapshot: maybeSnapshotView anchor not unique — upstream changed");
    process.exit(1);
  }
  text = text.replace(ORIGINAL, PATCHED).replace(VIEW_ANCHOR, HELPER_LANE + VIEW_ANCHOR);
  changed = true;
  console.log("plugin-lane snapshot: patched");
}

// ── 3. a fork child renders the parent transcript on its first request ──────
const CHILD_ANCHOR = "function loadTranscriptBase(session){";
const FUNCTION_END = "function assembleView(rows,blockSeeds,coveredSeqUnion,d,tailMsgs){";
const HELPER_FORK =
  "function __biliForkTranscriptSource(session,store){try{const parent=session&&session.metadata&&session.metadata.parentConversationId;if(typeof parent===\"string\"&&parent.length>0){const own=store.unifiedMessageIdRows(session.id);if(!own||own.length===0)return parent}}catch{}return session.id}";

if (text.includes("function __biliForkTranscriptSource(session,store)")) {
  console.log("fork transcript source: already patched");
} else {
  const from = text.indexOf(CHILD_ANCHOR);
  const to = text.indexOf(FUNCTION_END);
  if (from === -1 || to === -1 || to < from) {
    console.error("fork transcript source: loadTranscriptBase span not found — upstream changed");
    process.exit(1);
  }
  const body = text.slice(from, to);
  const swaps = [
    ['const store2=getStore();if(!store2)return{reason:"store-unavailable"};',
     'const store2=getStore();if(!store2)return{reason:"store-unavailable"};const __transcriptId=__biliForkTranscriptSource(session,store2);'],
    ["unifiedMessageIdRows(session.id)", "unifiedMessageIdRows(__transcriptId)"],
    ["unifiedTailSeqs(session.id)", "unifiedTailSeqs(__transcriptId)"],
    ["unifiedUncoveredRows(session.id,intervals)", "unifiedUncoveredRows(__transcriptId,intervals)"],
    ["unifiedTailViewRows(session.id)", "unifiedTailViewRows(__transcriptId)"],
  ];
  let next = body;
  for (const [find, repl] of swaps) {
    const n = next.split(find).length - 1;
    if (n !== 1) {
      console.error('fork transcript source: "' + find + '" matched ' + n + " times inside loadTranscriptBase, expected 1");
      process.exit(1);
    }
    next = next.replace(find, repl);
  }
  text = text.slice(0, from) + HELPER_FORK + next + text.slice(to);
  changed = true;
  console.log("fork transcript source: patched");
}

// ── 4. a fork child's first request reuses the parent's rendered prefix ─────
// Patch 3 gives the child the same raw transcript, but the rendered view is
// still re-derived (anchors, covered rows, tail) and the outbound bytes land
// differently, so the cache seam moves and the first turn pays full price. The
// parent's last live view is pinned here and reused verbatim for the child's
// first request, then dropped.
const PIN_HELPERS = [
  "const __biliPinnedViews=new Map();",
  'const __biliPinLog=(deps,line)=>{try{if(deps&&typeof deps.log==="function")return void deps.log("info",line)}catch{}try{console.warn(line)}catch{}};',
  'const __biliPinViewRecord=(session,clientMsgs,view)=>{try{if(!session||typeof session.id!=="string"||!Array.isArray(clientMsgs)||!Array.isArray(view)||view.length===0)return;const pin={view:JSON.parse(JSON.stringify(view)),count:clientMsgs.length,tail:JSON.stringify(clientMsgs[clientMsgs.length-1]??null).slice(0,200),at:Date.now()};__biliPinnedViews.delete(session.id);__biliPinnedViews.set(session.id,pin);while(__biliPinnedViews.size>8)__biliPinnedViews.delete(__biliPinnedViews.keys().next().value)}catch{}};',
  'const __biliForkPinView=(session,clientMsgs,deps)=>{try{const md=session&&session.metadata;if(!md||md.__biliForkPinned)return null;const parent=md.parentConversationId;if(typeof parent!=="string"||parent.length===0)return null;const pin=__biliPinnedViews.get(parent);if(!pin){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: no-pin-for-parent");return null}if(!Array.isArray(clientMsgs)||clientMsgs.length<pin.count){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: shorter-than-pin");return null}if(JSON.stringify(clientMsgs[pin.count-1]??null).slice(0,200)!==pin.tail){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: prefix-mismatch");return null}if(clientMsgs.length-pin.count>8){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: too-many-new-messages");return null}const extra=clientMsgs.slice(pin.count);if(extra.length>0&&extra[0]&&extra[0].role==="tool"){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: appended-starts-with-tool");return null}const msgs=pin.view.concat(extra);if(msgs.length===0){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: empty");return null}__biliPinViewRecord(session,clientMsgs,msgs);md.__biliForkPinned=true;__biliPinLog(deps,"[snapshot-render] fork-pin active parent="+parent.slice(0,8)+" pinned="+pin.view.length+" appended="+extra.length);return msgs}catch(e){__biliPinLog(deps,"[snapshot-render] fork-pin skipped: "+((e&&e.message)||"error"));return null}};',
].join("\n");

const PIN_MARK = "const __biliPinnedViews=new Map();";
const LIVE_ANCHOR = "if(!live&&!shadow)return clientMsgs;";
const RETURN_ANCHOR = "noteRender(session,deps);return r.view}";
const PIN_GO = "if(!live&&!shadow)return clientMsgs;if(live){const __biliPinHit=__biliForkPinView(session,clientMsgs,deps);if(__biliPinHit)return __biliPinHit}";
const PIN_SAVE = "noteRender(session,deps);__biliPinViewRecord(session,clientMsgs,r.view);return r.view}";

if (text.includes(PIN_MARK)) {
  console.log("fork-pin: already patched");
} else {
  if (!text.includes(PATCHED) || !text.includes("function __biliForkTranscriptSource(session,store)")) {
    console.error("fork-pin: needs steps 2 and 3 applied first — run them, then re-run this script");
    process.exit(1);
  }
  replaceOnce("fork-pin", VIEW_ANCHOR, PIN_HELPERS + VIEW_ANCHOR);
  replaceOnce("fork-pin", LIVE_ANCHOR, PIN_GO);
  replaceOnce("fork-pin", RETURN_ANCHOR, PIN_SAVE);
  console.log("fork-pin: patched");
}

// 5. body dump (diagnostics only, gated by ~/.local/state/billion-context/body-dump.on)
const DUMP_MARK = "function __biliDumpBody(opts,url){";
const DUMP_ANCHOR = "function __biliEncodeOutbound(opts,url){";
const DUMP_HELPER = "function __biliDumpBody(opts,url){try{var fs=require(\"node:fs\"),path=require(\"node:path\"),os=require(\"node:os\");var base=process.env.XDG_STATE_HOME||path.join(os.homedir(),\".local\",\"state\");var root=path.join(base,\"billion-context\");if(!fs.existsSync(path.join(root,\"body-dump.on\")))return;var b=opts&&opts.body;if(b===undefined||b===null)return;var txt=typeof b===\"string\"?b:(Buffer.isBuffer(b)?b.toString(\"utf8\"):(b instanceof Uint8Array?Buffer.from(b).toString(\"utf8\"):\"\"));if(!txt)return;var dir=path.join(root,\"body-dump\");fs.mkdirSync(dir,{recursive:true});var name=new Date().toISOString().replace(/[:.]/g,\"-\")+\"-\"+txt.length+\".json\";fs.writeFileSync(path.join(dir,name),txt)}catch(e){}};";

if (text.includes(DUMP_MARK)) {
  console.log("body-dump: already patched");
} else {
  replaceOnce("body-dump", DUMP_ANCHOR, DUMP_HELPER + DUMP_ANCHOR + "__biliDumpBody(opts,url);");
  console.log("body-dump: patched");
}

// 6. fork cache-key lineage: a forked session stamps its parent's effective key
const PKC_MARK = "const __biliPckChain=new Map();";
const PKC_ANCHOR = "if(pckDecision===\"stamp\"){rebuilt.prompt_cache_key=session.id}";
const PKC_REPL = "if(pckDecision===\"stamp\"){rebuilt.prompt_cache_key=__biliForkPck(session)}";
const PKC_OLD = "function __biliForkPck(session){try{var md=session&&session.metadata;if(md&&typeof md.parentConversationId===\"string\"&&md.parentConversationId.length&&__biliPluginLaneSnapshot())return md.parentConversationId}catch(e){}return session.id};";
const PKC_HELPER = "const __biliPckChain=new Map();function __biliForkPck(session){try{var own=session&&session.id;var md=session&&session.metadata;var key=own;if(md&&typeof md.parentConversationId===\"string\"&&md.parentConversationId.length&&__biliPluginLaneSnapshot()){var up=__biliPckChain.get(md.parentConversationId);key=up||md.parentConversationId}if(own){__biliPckChain.delete(own);__biliPckChain.set(own,key)}while(__biliPckChain.size>512)__biliPckChain.delete(__biliPckChain.keys().next().value);return key}catch(e){return session&&session.id}};";

if (text.includes(PKC_MARK)) {
  console.log("fork-pck: already patched");
} else if (text.includes(PKC_OLD)) {
  text = text.split(PKC_OLD).join(PKC_HELPER);
  changed = true;
  console.log("fork-pck: helper upgraded to key chain");
} else if (!text.includes(PKC_ANCHOR)) {
  console.log("fork-pck: anchor not found, skipped");
} else {
  replaceOnce("fork-pck", "function __biliEncodeOutbound(opts,url){", PKC_HELPER + "function __biliEncodeOutbound(opts,url){");
  text = text.split(PKC_ANCHOR).join(PKC_REPL);
  changed = true;
  console.log("fork-pck: patched");
}

// 7. forked sessions keep the parent's message timestamps — the child's stamp
//    table starts empty, so every inherited message is re-stamped with the
//    fork's clock (a couple of seconds off) and the tag bytes drift.
const TS_MARK = "const __biliCopyTsStamps={}";
const TS_ANCHOR = "child.state.nextRunId=parent.state.nextRunId;";
const TS_REPL = TS_ANCHOR + 'if(parent.state.tsStamps){const __biliCopyTsStamps={};for(const __tsm of prefix){const __tss=parent.state.tsStamps[__tsm.rawId];if(typeof __tss==="number")__biliCopyTsStamps[__tsm.rawId]=__tss}child.state.tsStamps=__biliCopyTsStamps}';

if (text.includes(TS_MARK)) {
  console.log("fork-ts: already patched");
} else if (!text.includes(TS_ANCHOR)) {
  console.log("fork-ts: anchor not found, skipped");
} else {
  text = text.split(TS_ANCHOR).join(TS_REPL);
  changed = true;
  console.log("fork-ts: patched");
}
// 8. keep the last good view when the unified transcript cannot be anchored ---------
// maybeSnapshotView hands the client's messages back whenever the store cannot line a
// block up with its rows. That is transient — a commit lands, the ingest that writes its
// rows lags (the delta fast path falls back, the WAL grows) and a moment later the rows
// are there, which is exactly what the host's automatic retry sees. In the plugin lane
// the client's messages ARE the whole raw history, so the fallback ships megabytes and
// preflight refuses the request with a 502 instead of compressing it. Reuse the session's
// own last rendered view, behind the same guards as the fork pin, so a store hiccup costs
// one turn without new compression rather than the request itself.
const STICKY_MARK = "function __biliStickyView(";
const STICKY_ANCHOR = "function legacyFor(session,deps,clientMsgs,reason){";
const STICKY_CALL_ANCHOR = 'session.metadata["snapshotRenderDegradeReason"]=reason;';
const STICKY_CALL = STICKY_CALL_ANCHOR + "const __biliSticky=__biliStickyView(session,clientMsgs,deps,reason);if(__biliSticky)return __biliSticky;";
const STICKY_HELPER =
  'function __biliStickyView(session,clientMsgs,deps,reason){try{if(!deps||!deps.pluginMode)return null;const pin=session&&__biliPinnedViews.get(session.id);if(!pin)return null;if(!Array.isArray(clientMsgs)||clientMsgs.length<pin.count)return null;if(JSON.stringify(clientMsgs[pin.count-1]??null).slice(0,200)!==pin.tail)return null;const extra=clientMsgs.slice(pin.count);if(extra.length>8)return null;if(extra.length>0&&extra[0]&&extra[0].role==="tool")return null;const msgs=pin.view.concat(extra);if(msgs.length===0)return null;__biliPinLog(deps,"[snapshot-render] sticky view ("+reason+"): pinned="+pin.view.length+" appended="+extra.length);return msgs}catch(e){__biliPinLog(deps,"[snapshot-render] sticky view skipped: "+((e&&e.message)||"error"));return null}};';

if (text.includes(STICKY_MARK)) {
  console.log("sticky-view: already patched");
} else if (!text.includes(PIN_MARK)) {
  console.error("sticky-view: needs step 4 applied first — run it, then re-run this script");
  process.exit(1);
} else {
  replaceOnce("sticky-view", STICKY_ANCHOR, STICKY_HELPER + STICKY_ANCHOR);
  replaceOnce("sticky-view", STICKY_CALL_ANCHOR, STICKY_CALL);
  console.log("sticky-view: patched");
}
// 9. an unanchored newest block must not sink the whole render ----------------------
// A block is committed before the ingest that writes its message rows, so for a moment
// the newest block matches no row. loadTranscriptBase used to give up there, which on a
// plugin lane means shipping the client's raw history and being refused as over-window.
// The newest block's messages are exactly the ones still arriving in the client's tail,
// so dropping it from this render costs nothing: they go out raw and the rest of the view
// stays compressed. An older block stays fatal — its messages would silently vanish.
const UNANCHORED_MARK = 'newest block "+block.blockId+" is not in the transcript yet';
const UNANCHORED_ANCHOR = 'if(blockSeqs.size===0)return{reason:"block-unanchored"};';
const UNANCHORED_REPL = 'if(blockSeqs.size===0){if(block!==activeBlocks2[activeBlocks2.length-1]||blockSeeds.length===0)return{reason:"block-unanchored"};try{console.warn("[snapshot-render] newest block "+block.blockId+" is not in the transcript yet, rendered raw this turn")}catch{}continue}';

if (text.includes(UNANCHORED_MARK)) {
  console.log("unanchored-newest: already patched");
} else {
  replaceOnce("unanchored-newest", UNANCHORED_ANCHOR, UNANCHORED_REPL);
  console.log("unanchored-newest: patched");
}
// 10. Verify complete prefixes and prove skipped-block raw coverage.
// Upgrade existing patched builds as well as fresh upstream builds.
const safety = readFileSync(join(here, "patches", "view-safety.block.js"), "utf8");
const SAFETY_MARK = "function __biliPrefixDigest(";
if (!text.includes(SAFETY_MARK)) {
  const removeSpan = (start, end) => {
    const a = text.indexOf(start), b = text.indexOf(end, a);
    if (a < 0 || b <= a || text.indexOf(start, a + start.length) !== -1) {
      throw new Error("view-safety: upstream span changed: " + start);
    }
    text = text.slice(0, a) + text.slice(b);
    changed = true;
  };
  removeSpan("const __biliPinViewRecord=", "function maybeSnapshotView(");
  removeSpan("function __biliStickyView(", "function legacyFor(");
  replaceOnce("view-safety helpers", PIN_MARK, safety + "\n" + PIN_MARK);
  replaceOnce("view-safety client seam",
    "const d=joinRow+1;const merged=assembleView(",
    'if(!__biliSkippedCoverage(session,blockSeeds,clientMsgs.slice(clientJoin)))return{ok:false,reason:"skipped-block-not-in-tail"};const d=joinRow+1;const merged=assembleView(');
  replaceOnce("view-safety anchored seam",
    "const d=rows.length;const merged=assembleView(",
    'if(!__biliSkippedCoverage(session,blockSeeds,tailMsgs))return{ok:false,reason:"skipped-block-not-in-tail"};const d=rows.length;const merged=assembleView(');
  console.log("view-safety: patched");
} else {
  console.log("view-safety: already patched");
}
if (changed) {
  writeFileSync(target, text, "latin1");
  console.log("written " + target);
}