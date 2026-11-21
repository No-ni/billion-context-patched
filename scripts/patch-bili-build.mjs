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
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { uniqueBlockSpan } from "./patch-bili-client.mjs";

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

// Parse the complete shipped function/factory before editing its internals.
// A changed or partially patched block must fail at its own seam.
const editFunction = (label, name, transform) => {
  let opener = "function " + name + "(";
  if (text.split(opener).length - 1 !== 1) throw new Error(label + ": function is not unique");
  const at = text.indexOf(opener);
  if (text.slice(Math.max(0, at - 6), at) === "async ") opener = "async " + opener;
  const { block } = uniqueBlockSpan(text, label, opener, { expression: true });
  const next = transform(block);
  if (next !== block) replaceOnce(label, block, next);
};
const editInside = (label, body, find, replacement) => {
  if (body.includes(replacement)) return body;
  if (body.split(find).length - 1 !== 1) throw new Error(label + ": internal anchor moved");
  return body.replace(find, replacement);
};

// Node 24 can stringify nesting that overflows the recursive digest verifier.
// Reject it at the message boundary so storage forensics retain the row id.
const STORE_DEPTH_HELPER = 'function __biliJsonNestingTooDeep(json){if(typeof json!=="string")return false;let depth=0,inString=false,escaped=false;for(let i=0;i<json.length;i++){const c=json.charCodeAt(i);if(inString){if(escaped)escaped=false;else if(c===92)escaped=true;else if(c===34)inString=false;continue}if(c===34){inString=true;continue}if(c===123||c===91){if(++depth>512)return true}else if(c===125||c===93)depth--}return false}\n';
if (!text.includes("function __biliJsonNestingTooDeep(")) {
  replaceOnce("storage JSON depth helper", "function stringifyForStore(", STORE_DEPTH_HELPER + "function stringifyForStore(");
}
editFunction("storage JSON depth guard", "stringifyForStore", body => editInside("storage JSON depth guard", body,
  'try{return JSON.stringify(m2)}catch(err2){',
  'try{const json=JSON.stringify(m2);if(__biliJsonNestingTooDeep(json))throw new RangeError("JSON nesting depth exceeds the storage limit");return json}catch(err2){'));

// ── 1. outbound request-body compression ────────────────────────────────────
const BLOCK = readFileSync(join(here, "patches", "outbound-encoding.block.js"), "latin1").replace(/\s+$/, "");
const FETCH_ANCHOR = "async function fetchWithTimeout(";
const ENTER = "checkOutboundBody(opts.body);";
const LOGS_ROUTE = "return sendWebLogs(res,req);";
const LEGACY_ENCODING_POLICY = `function __biliEncPolicy(source,projected,opts){
  var sm=__biliEncMeta(source),pm=__biliEncMeta(projected),prior=(sm&&sm.policy)||(pm&&pm.policy);
  var dir=__biliEncHeaderRead(source,"x-accel-compress"),rid=__biliEncHeaderRead(source,"x-accel-rid");
  if(dir===null&&projected!==source)dir=__biliEncHeaderRead(projected,"x-accel-compress");
  if(rid===null&&projected!==source)rid=__biliEncHeaderRead(projected,"x-accel-rid");
  dir=dir===null?(prior?prior.dir:opts&&typeof opts.__biliCompress==="string"?opts.__biliCompress:""):dir.trim().toLowerCase();
  rid=rid===null?(prior?prior.rid:opts&&typeof opts.__biliRid==="string"?opts.__biliRid:null):(rid||null);
  var policy=prior&&prior.dir===dir&&prior.rid===rid?prior:{dir:dir,rid:rid,resolved:false,encoding:""};
  if(source&&typeof source==="object")__biliEncHeaderMeta.set(source,{policy:policy,own:sm&&sm.own,decision:sm&&sm.decision});
  return policy;
}`;

if (text.includes("var __biliEncZlib=")) {
  for (const match of BLOCK.matchAll(/function (__bili\w+)\(/g)) {
    const name = match[1], opener = "function " + name + "(";
    const expected = uniqueBlockSpan(BLOCK, "encoding source " + name, opener, { expression: true }).block;
    const actual = uniqueBlockSpan(text, "encoding artifact " + name, opener, { expression: true }).block;
    // B5's diagnostic call is the only later edit inside an encoder function.
    const normalized = name === "__biliEncodeOutbound" ? actual.replace("__biliDumpBody(opts,url);", "") : actual;
    if (normalized !== expected) {
      if (name !== "__biliEncPolicy" || actual !== LEGACY_ENCODING_POLICY) {
        throw new Error("outbound encoding: helper body differs; rebuild from the selected clean upstream (" + name + ")");
      }
      const span = uniqueBlockSpan(text, "legacy encoding policy", opener, { expression: true });
      text = text.slice(0, span.start) + expected + text.slice(span.end);
      changed = true;
      console.log("outbound encoding: migrated missing-directive default to off");
    }
  }
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
  throw new Error("fork-pck: stamp anchor not found; re-derive the patch");
} else {
  replaceOnce("fork-pck", "function __biliEncodeOutbound(opts,url){", PKC_HELPER + "function __biliEncodeOutbound(opts,url){");
  text = text.split(PKC_ANCHOR).join(PKC_REPL);
  changed = true;
  console.log("fork-pck: patched");
}

// 7. Explicit forks inherit only proven prefix times. Reserved parent refs
// outside that prefix remain available without suppressing a child's own clock.
const TS_HELPERS = readFileSync(join(here, "patches", "fork-timestamps.block.js"), "utf8").trimEnd();
const forkBody = uniqueBlockSpan(text, "fork timestamp owner", "async function handlePluginFork(", { expression: true }).block;
const forkClock = [...forkBody.matchAll(/(\w+)\.state\.nextRunId=(\w+)\.state\.nextRunId;/g)];
if (forkClock.length !== 1) throw new Error("fork-ts: expected one child/parent clock assignment");
const [, forkChild, forkParent] = forkClock[0];
const TS_ANCHOR = forkClock[0][0];
const TS_OLD_REPL = TS_ANCHOR + `if(${forkParent}.state.tsStamps){const __biliCopyTsStamps={};for(const __tsm of prefix){const __tss=${forkParent}.state.tsStamps[__tsm.rawId];if(typeof __tss==="number")__biliCopyTsStamps[__tsm.rawId]=__tss}${forkChild}.state.tsStamps=__biliCopyTsStamps}`;
const TS_REPL = TS_ANCHOR + `__biliCopyForkTimestamps(${forkChild},${forkParent},prefix);`;
if (!text.includes("function __biliCopyForkTimestamps(")) {
  replaceOnce("fork-ts helpers", CHILD_ANCHOR, TS_HELPERS + "\n" + CHILD_ANCHOR);
} else if (!text.includes(TS_HELPERS)) {
  throw new Error("fork-ts: helper body differs; rebuild from the selected clean upstream");
}
if (text.includes(TS_REPL)) {
  console.log("fork-ts: prefix copy already patched");
} else if (text.includes(TS_OLD_REPL)) {
  replaceOnce("fork-ts prefix migration", TS_OLD_REPL, TS_REPL);
} else {
  replaceOnce("fork-ts prefix", TS_ANCHOR, TS_REPL);
}
const TS_FORK_ARM = `seedTimestampsFromParent(${forkChild},${forkParent});${forkChild}.state.suppressMintingOnce=true;`;
if (text.includes(TS_FORK_ARM)) {
  replaceOnce("fork-ts whole-parent suppression", TS_FORK_ARM, "");
} else if (forkBody.includes(`seedTimestampsFromParent(${forkChild},${forkParent})`) || forkBody.includes(`${forkChild}.state.suppressMintingOnce=true`)) {
  throw new Error("fork-ts: upstream fork timestamp arm changed; re-derive the patch");
}
const TS_PIPELINE_EDITS = [
  ["fork-ts disabled observation", 'if(!enabled)return{name:"stamp-timestamps",run(io2){return io2}};', 'if(!enabled)return{name:"stamp-timestamps",run(io2){return __biliObserveForkTimestampIds(io2)}};'],
  ["fork-ts pending sightings", 'const suppressed=io2.state.suppressMintingOnce===true;const messages=', 'const suppressed=io2.state.suppressMintingOnce===true;const __biliPendingTs=new Set(io2.state.__biliForkTsPending??[]);const __biliVisibleTs=__biliForkTimestampVisibility(io2.state);const messages='],
  ["fork-ts proven child visibility", 'if(seq===null||seq<=hwm)return m2;', 'if(!__biliVisibleTs.has(m2.id)&&(seq===null||seq<=hwm))return m2;'],
  ["fork-ts child clock", '!suppressed&&knownIds[m2.id]===void 0?Date.now():void 0', '!suppressed&&(knownIds[m2.id]===void 0||__biliPendingTs.has(m2.id))?Date.now():void 0'],
  ["fork-ts unchanged observation", 'if(!changed&&!hwmFresh&&!suppressed)return io2;', 'if(!changed&&!hwmFresh&&!suppressed)return __biliObserveForkTimestampIds(io2,true);'],
  ["fork-ts enabled observation", 'if(suppressed)delete nextState.suppressMintingOnce;return{...io2,messages,state:nextState}', 'if(suppressed)delete nextState.suppressMintingOnce;return __biliObserveForkTimestampIds({...io2,messages,state:nextState},true)'],
  ["fork-ts hydration", 'tsStamps:parsed.tsStamps??fresh.tsStamps,viewLatchConfigDigest:', 'tsStamps:parsed.tsStamps??fresh.tsStamps,...Array.isArray(parsed.__biliForkTsPending)?{__biliForkTsPending:[...parsed.__biliForkTsPending]}:{},...Array.isArray(parsed.__biliForkTsVisible)?{__biliForkTsVisible:[...parsed.__biliForkTsVisible]}:{},viewLatchConfigDigest:'],
  ["fork-ts persistence whitelist", 'probe.timestampsHighWaterRefSeq=0;return Object.keys(mergeState(probe))', 'probe.timestampsHighWaterRefSeq=0;probe.__biliForkTsPending=[];probe.__biliForkTsVisible=[];return Object.keys(mergeState(probe))'],
];
for (const [label, old, next] of TS_PIPELINE_EDITS) {
  if (!text.includes(next)) replaceOnce(label, old, next);
}
const TS_CLONE_OLD = 'tsStamps:state7.tsStamps?{...state7.tsStamps}:void 0';
const TS_CLONE_NEW = TS_CLONE_OLD + ',...Array.isArray(state7.__biliForkTsPending)?{__biliForkTsPending:[...state7.__biliForkTsPending]}:{},...Array.isArray(state7.__biliForkTsVisible)?{__biliForkTsVisible:[...state7.__biliForkTsVisible]}:{}';
if (text.split(TS_CLONE_NEW).length - 1 !== 2) {
  if (text.includes(TS_CLONE_NEW) || text.split(TS_CLONE_OLD).length - 1 !== 2) {
    throw new Error("fork-ts: expected exactly the sync and fold clone anchors");
  }
  text = text.split(TS_CLONE_OLD).join(TS_CLONE_NEW);
  changed = true;
}
console.log("fork-ts: clock, observation, clones and persistence patched");
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
const safety = readFileSync(join(here, "patches", "view-safety.block.js"), "utf8").trimEnd() + "\n";
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
  const from = text.indexOf(SAFETY_MARK), to = text.indexOf(PIN_MARK, from);
  if (from < 0 || to <= from || text.indexOf(SAFETY_MARK, from + SAFETY_MARK.length) !== -1) {
    throw new Error("view-safety: ambiguous helper span; re-derive the patch");
  }
  // Include the leading digest comment when migrating the pre-0.6.8 block.
  const comment = "// The digest covers every field, including edits beyond the old 200-char probe.\n";
  const start = text.slice(0, from).endsWith(comment) ? from - comment.length : from;
  const next = safety + "\n";
  if (text.slice(start, to) !== next) {
    text = text.slice(0, start) + next + text.slice(to);
    changed = true;
    console.log("view-safety: helpers updated");
  } else console.log("view-safety: already patched");
}
// Equal tool output is not the same message when it belongs to another call.
// The shared signature also backs WS probes and shadow comparisons, whose
// producers and consumers must agree on the complete call identity.
editFunction("snapshot tool-call identity", "identitySig", body => editInside("tool-call identity", body,
  '${m2.toolName??""}|${text2}${img}',
  '${m2.toolName??""}|${JSON.stringify(m2.toolCallId??null)}|${text2}${img}'));
// 11. Required fork default: stamp cache keys unless the user chose a routing mode.
const CACHE_DEFAULT_OLD = 'function parsePromptCacheRouting(value){return value==="auto"||value==="enabled"||value==="disabled"?value:"disabled"}';
const CACHE_DEFAULT_NEW = CACHE_DEFAULT_OLD.replace('?value:"disabled"}', '?value:"enabled"}');
if (text.includes(CACHE_DEFAULT_NEW)) {
  if (text.split(CACHE_DEFAULT_NEW).length !== 2 || text.includes(CACHE_DEFAULT_OLD)) {
    throw new Error("cache-key-default: ambiguous parser; re-derive the patch");
  }
  console.log("cache-key-default: already patched");
} else {
  replaceOnce("cache-key-default", CACHE_DEFAULT_OLD, CACHE_DEFAULT_NEW);
  console.log("cache-key-default: patched");
}
// The settings page has its own absent-config default and bilingual help text.
const cacheUiChanges = [
  [
    "const pcv = (draft.promptCache && typeof draft.promptCache === \"object\" && !Array.isArray(draft.promptCache) && typeof draft.promptCache.routing === \"string\") ? draft.promptCache.routing : \"disabled\";",
    "const pcv = (draft.promptCache && typeof draft.promptCache === \"object\" && !Array.isArray(draft.promptCache) && typeof draft.promptCache.routing === \"string\") ? draft.promptCache.routing : \"enabled\";"
  ],
  [
    "\"cfg.q_pck_disabled_desc\":\"\\u5173\\u95ED\\uFF08\\u5F53\\u524D\\u9ED8\\u8BA4\\uFF09\\uFF1Abili \\u4E0D\\u81EA\\u884C\\u5199 prompt_cache_key\\uFF0C\\u5BA2\\u6237\\u7AEF\\u81EA\\u5E26\\u7684\\u503C\\u4ECD\\u539F\\u6837\\u8F6C\\u53D1\\u3002\\u76F4\\u8FDE\\u5B98\\u65B9 API \\u7684\\u7528\\u6237\\u4FDD\\u6301\\u6B64\\u9879\\u5373\\u53EF\\u3002\"",
    "\"cfg.q_pck_disabled_desc\":\"\\u5173\\u95ED\\uFF1Abili \\u4E0D\\u81EA\\u884C\\u5199 prompt_cache_key\\uFF0C\\u5BA2\\u6237\\u7AEF\\u81EA\\u5E26\\u7684\\u503C\\u4ECD\\u539F\\u6837\\u8F6C\\u53D1\\u3002\\u76F4\\u8FDE\\u5B98\\u65B9 API \\u7684\\u7528\\u6237\\u4FDD\\u6301\\u6B64\\u9879\\u5373\\u53EF\\u3002\""
  ],
  [
    "\"cfg.q_pck_disabled_desc\":\"Off (current default): bili never writes its own prompt_cache_key; client-supplied values still forward verbatim. Direct official-API users stay here.\"",
    "\"cfg.q_pck_disabled_desc\":\"Off: bili never writes its own prompt_cache_key; client-supplied values still forward verbatim. Direct official-API users stay here.\""
  ],
  [
    "\"cfg.q_pck_enabled_desc\":\"\\u5F3A\\u5236\\u5F00\\u542F\\uFF1A\\u51E1\\u652F\\u6301\\u6CE8\\u5165\\u7684\\u7EBF\\u8DEF\\u90FD\\u5199\\u5165\\u4F1A\\u8BDD id\\uFF08Responses \\u7EBF\\u4E0D\\u9650\\u4E3B\\u673A\\uFF09\\uFF0C\\u4FDD\\u7559\\u62D2\\u7EDD\\u63A2\\u6D4B\\u515C\\u5E95\\u3002\"",
    "\"cfg.q_pck_enabled_desc\":\"\\u5F3A\\u5236\\u5F00\\u542F\\uFF08\\u5F53\\u524D\\u9ED8\\u8BA4\\uFF09\\uFF1A\\u51E1\\u652F\\u6301\\u6CE8\\u5165\\u7684\\u7EBF\\u8DEF\\u90FD\\u5199\\u5165\\u4F1A\\u8BDD id\\uFF08Responses \\u7EBF\\u4E0D\\u9650\\u4E3B\\u673A\\uFF09\\uFF0C\\u4FDD\\u7559\\u62D2\\u7EDD\\u63A2\\u6D4B\\u515C\\u5E95\\u3002\""
  ],
  [
    "\"cfg.q_pck_enabled_desc\":\"Force on: stamp the session id on every supporting lane (Responses wire any host), with the rejection probe kept as a safety net.\"",
    "\"cfg.q_pck_enabled_desc\":\"Force on (current default): stamp the session id on every supporting lane (Responses wire any host), with the rejection probe kept as a safety net.\""
  ]
];
for (const [before, after] of cacheUiChanges) {
  if (text.includes(after)) {
    if (text.split(after).length !== 2) throw new Error("cache-key-ui: ambiguous patched anchor");
  } else {
    replaceOnce("cache-key-ui", before, after);
  }
}
// B12–B15 were removed on 2026-11-21 at the user's request. The image fold
// pass, the host shrink step, the image convention paragraph and the
// per-request image receipts no longer exist; only the DSH-native image budget
// keys remain, registered in step 16 below.
// ── 16. the DSH-native image budget knobs are top-level config keys ────
// These five keys belong to the host's own pi-ai request projection, not to a
// bili image transform. Registering them keeps startup from warning about a
// supported setting; no other image key is added here.
const CONFIG_KEYS_ANCHOR = ',"autoModeForge","imageRescale","guardrails","cacheKeepalive","egressTransforms"]);';
const CONFIG_KEYS_PATCHED = ',"autoModeForge","imageRescale","maxRequestImages","imageOffloadCountQuantum","requestImageMaxBytes","requestImagePixelBudget","maxRequestImageBytes","guardrails","cacheKeepalive","egressTransforms"]);';
if (text.includes(CONFIG_KEYS_PATCHED)) {
  console.log("image budget config keys: already patched");
} else {
  replaceOnce("image budget config keys", CONFIG_KEYS_ANCHOR, CONFIG_KEYS_PATCHED);
  console.log("image budget config keys: patched");
}
// ── 17. the image budget card in the config page ──────────────────────────
// Only the five DSH-native budget numbers remain. The card edits the same
// config draft the raw editor holds: one Save, one file. Each region sits
// between sentinels so a later revision of the card replaces the old text in
// place instead of being skipped as "already patched".
const CARD_MARKUP = readFileSync(join(here, "patches", "image-card.markup.block.js"), "utf8").replace(/\s+$/, "");
const CARD_SCRIPT = readFileSync(join(here, "patches", "image-card.script.block.js"), "utf8").replace(/\s+$/, "");
const CARD_LISTENERS = readFileSync(join(here, "patches", "image-card.listeners.block.js"), "utf8").replace(/\s+$/, "");
for (const [name, block] of [["markup", CARD_MARKUP], ["script", CARD_SCRIPT], ["listeners", CARD_LISTENERS]]) {
  if (/[^\x00-\x7e]/.test(block)) {
    throw new Error("image card " + name + ": non-ASCII bytes would be mangled by the latin1 write; keep them escaped");
  }
}
// The page dictionary is one object literal in the bundle, and the copy the
// page script uses is serialized out of it when a page renders, so adding the
// keys there covers both the rendered markup and the script side.
const IMAGE_CARD_COPY_ZH = {
  "cfg.image": "图像预算",
  "cfg.image_desc": "控制每次请求携带的图片体积、像素和数量。这些参数写入 DSH 原生设置，保存后对下一条请求生效，停用本插件后仍然保留。",
  "cfg.image_request_kb": "每张图片请求目标（KiB）",
  "cfg.image_request_kb_hint": "默认 150 KiB；DSH 会优先使用 JPEG 或 WebP 等更紧凑格式。",
  "cfg.image_total_kb": "单次请求图片总上限（KiB）",
  "cfg.image_total_kb_hint": "默认 2048 KiB；超出后宿主优先退役较早图片。",
  "cfg.image_pixel_budget": "每张图片像素预算",
  "cfg.image_pixel_budget_hint": "默认 1440000 像素，约等于 1200 像素长边级别；不会放大图片。",
  "cfg.image_max_request": "每条请求最多保留的图片数",
  "cfg.image_max_request_hint": "默认 20 张；超过后宿主会把最早的图片改成占位说明，避免原始请求体持续变大。",
  "cfg.image_offload_quantum": "每次退役的图片数",
  "cfg.image_offload_quantum_hint": "默认 10 张；达到上限时按这个数量逐批退役，不能大于图片上限。",
  "cfg.image_budget_invalid": "请输入正整数，且每次退役数量不能大于图片上限",
  "cfg.image_reset": "恢复默认",
  "cfg.image_restored": "已恢复默认值，记得保存"
};
const IMAGE_CARD_COPY_EN = {
  "cfg.image": "Image budget",
  "cfg.image_desc": "Controls how much image data each request carries: bytes, pixels and count. These keys live in DSH's native settings and apply to the next request after saving; they stay in effect when this plugin is disabled.",
  "cfg.image_request_kb": "Per-image request target (KiB)",
  "cfg.image_request_kb_hint": "Defaults to 150 KiB; DSH prefers compact JPEG or WebP output.",
  "cfg.image_total_kb": "Total image cap per request (KiB)",
  "cfg.image_total_kb_hint": "Defaults to 2048 KiB; older images are offloaded first when exceeded.",
  "cfg.image_pixel_budget": "Pixels per image",
  "cfg.image_pixel_budget_hint": "Defaults to 1440000 pixels, roughly a 1200 px long edge; images are never enlarged.",
  "cfg.image_max_request": "Maximum images kept per request",
  "cfg.image_max_request_hint": "Defaults to 20. Above the limit, the host replaces the oldest images with placeholders so the original request body cannot keep growing.",
  "cfg.image_offload_quantum": "Images retired per step",
  "cfg.image_offload_quantum_hint": "Defaults to 10. Images are retired in batches at the limit; this cannot exceed the image limit.",
  "cfg.image_budget_invalid": "Enter positive whole numbers; the retirement count cannot exceed the image limit",
  "cfg.image_reset": "Restore defaults",
  "cfg.image_restored": "Defaults restored; remember to save"
};
const asciiJson = (value) => JSON.stringify(value).replace(/[^ -~]/g, (ch) => String.fromCharCode(92) + "u" + ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase());
const CARD_I18N = [
  "// <bili-image-card:i18n begin>",
  'Object.assign(MESSAGES["zh-CN"], ' + asciiJson(IMAGE_CARD_COPY_ZH) + ");",
  "Object.assign(MESSAGES.en, " + asciiJson(IMAGE_CARD_COPY_EN) + ");",
  "// <bili-image-card:i18n end>"
].join("\n");
const cardUpsert = (label, start, end, body, anchor, after) => {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt >= 0 && endAt > startAt) {
    // The marker starts its own line: measure from the line start and drop the
    // indentation the previous copy carried, or every re-run adds four spaces
    // in front of the block and never compares equal.
    let from = startAt;
    while (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
    const current = text.slice(from, endAt + end.length);
    if (current === body) {
      console.log(label + ": already patched");
      return;
    }
    text = text.slice(0, from) + body + text.slice(endAt + end.length);
    changed = true;
    console.log(label + ": updated");
    return;
  }
  replaceOnce(label, anchor, after ? anchor + "\n" + body : body + "\n" + anchor);
  console.log(label + ": patched");
};
cardUpsert("image card i18n", "// <bili-image-card:i18n begin>", "// <bili-image-card:i18n end>", CARD_I18N, "function translate(locale,key2,vars){", false);
cardUpsert("image card markup", "<!-- <bili-image-card begin> -->", "<!-- <bili-image-card end> -->", CARD_MARKUP, '<div class="card" id="summary-settings">', false);
cardUpsert("image card script", "// <bili-image-card:js begin>", "// <bili-image-card:js end>", CARD_SCRIPT, "    function hydrateQuickConfig(cfg) {", false);
cardUpsert("image card listeners", "// <bili-image-card:listeners begin>", "// <bili-image-card:listeners end>", CARD_LISTENERS, "            await putCfg(sq, { file: raw });\n        });", true);
const CARD_CALL_ANCHOR = "            hydrateQuickConfig(cfg);\n            hydrateSummaryConfig(cfg);";
const CARD_CALL_PATCHED = "            hydrateQuickConfig(cfg);\n            hydrateImageCard(cfg);\n            hydrateSummaryConfig(cfg);";
if (text.includes("            hydrateImageCard(cfg);")) {
  console.log("image card call: already patched");
} else {
  replaceOnce("image card call", CARD_CALL_ANCHOR, CARD_CALL_PATCHED);
  console.log("image card call: patched");
}
const CARD_DIRTY_OLD = '["card-quick", "card-file", "summary-settings"]';
const CARD_DIRTY_NEW = '["card-quick", "card-file", "card-image", "summary-settings"]';
if (text.includes(CARD_DIRTY_NEW)) {
  console.log("image card dirty list: already patched");
} else {
  replaceOnce("image card dirty list", CARD_DIRTY_OLD, CARD_DIRTY_NEW);
  console.log("image card dirty list: patched");
}
const CARD_DISABLE_OLD = '["cfg-file-edit", "save-file", "save-upstream", "save-quick", "save-summary", "save-pricing"]';
const CARD_DISABLE_NEW = '["cfg-file-edit", "save-file", "save-upstream", "save-quick", "save-image", "reset-image", "save-summary", "save-pricing"]';
if (text.includes(CARD_DISABLE_NEW)) {
  console.log("image card disable list: already patched");
} else {
  replaceOnce("image card disable list", CARD_DISABLE_OLD, CARD_DISABLE_NEW);
  console.log("image card disable list: patched");
}
// ── 18. the fold step defaults to 80k ──────────────────────────────────────
// Upstream nudges once the context has grown 50k tokens since the last fold.
// This branch's own profile has been running at 80k for months: folds are less
// frequent, summaries keep more material, and the request body stops being
// re-derived as often. The kernel default and the config page's default have to
// agree, or a fresh install shows 50000 in the card and then behaves like it.
const NUDGE_KERNEL_OLD = "growthFloor:5e4,growthCap:5e4";
const NUDGE_KERNEL_NEW = "growthFloor:8e4,growthCap:8e4";
const NUDGE_PAGE_OLD = "const NUDGE_DEFAULT = 50000, NUDGE_STEP = 5000";
const NUDGE_PAGE_NEW = "const NUDGE_DEFAULT = 80000, NUDGE_STEP = 5000";
const escapedCopy = (value) => String(value).replace(/[^ -~]/g, (ch) => String.fromCharCode(92) + "u" + ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase());
const NUDGE_ZH_OLD = escapedCopy("内核默认 50000");
const NUDGE_ZH_NEW = escapedCopy("内核默认 80000");
const NUDGE_EN_OLD = "kernel default 50000";
const NUDGE_EN_NEW = "kernel default 80000";
const NUDGE_EDITS = [
  ["nudge default (kernel)", NUDGE_KERNEL_OLD, NUDGE_KERNEL_NEW],
  ["nudge default (config page)", NUDGE_PAGE_OLD, NUDGE_PAGE_NEW],
  ["nudge default (zh hint)", NUDGE_ZH_OLD, NUDGE_ZH_NEW],
  ["nudge default (en hint)", NUDGE_EN_OLD, NUDGE_EN_NEW],
];
let nudged = 0;
for (const [label, find, replacement] of NUDGE_EDITS) {
  if (text.includes(replacement)) continue;
  replaceOnce(label, find, replacement);
  nudged++;
}
console.log("nudge growth default: " + (nudged > 0 ? "patched (" + nudged + "/" + NUDGE_EDITS.length + ")" : "already patched"));
// A nudge grants a time-limited model-tool opportunity, but one successful
// fold must consume it. Keep completion and in-flight ownership by generation
// so a later nudge cannot erase an older operation's lock or inherit its result.
const NUDGE_GATE_STATE_OLD = "const credit=stamp2.nudgeInjected?NUDGE_CREDIT_ROUNDS:isModelRound?prevCredit-1:prevCredit;t.unpromptedGate={credit:Math.max(0,credit),requireNudge:stamp2.requireNudge===true,requireRecommendation:stamp2.requireRecommendation===true}";
const NUDGE_GATE_STATE_DRAFT = "const credit=stamp2.nudgeInjected?NUDGE_CREDIT_ROUNDS:isModelRound?prevCredit-1:prevCredit;const previousNudgeId=Number.isSafeInteger(prev?.nudgeId)?prev.nudgeId:0;const nudgeId=stamp2.nudgeInjected?previousNudgeId+1:previousNudgeId;const compressed=!stamp2.nudgeInjected&&prev?.compressed===true;const compressionInFlight=!stamp2.nudgeInjected&&prev?.compressionInFlight===true;t.unpromptedGate={credit:Math.max(0,credit),requireNudge:stamp2.requireNudge===true,requireRecommendation:stamp2.requireRecommendation===true,nudgeId,compressed,compressionInFlight}";
const NUDGE_GATE_STATE = "const credit=stamp2.nudgeInjected?NUDGE_CREDIT_ROUNDS:isModelRound?prevCredit-1:prevCredit;const previousNudgeId=Number.isSafeInteger(prev?.nudgeId)?prev.nudgeId:0;const nudgeId=stamp2.nudgeInjected?previousNudgeId+1:previousNudgeId;const completedNudgeId=Number.isSafeInteger(prev?.completedNudgeId)&&prev.completedNudgeId>=0?prev.completedNudgeId:prev?.compressed===true&&previousNudgeId>0?previousNudgeId:0;const compressionInFlightNudgeId=Number.isSafeInteger(prev?.compressionInFlightNudgeId)&&prev.compressionInFlightNudgeId>0?prev.compressionInFlightNudgeId:prev?.compressionInFlight===true&&previousNudgeId>0?previousNudgeId:0;t.unpromptedGate={credit:Math.max(0,credit),requireNudge:stamp2.requireNudge===true,requireRecommendation:stamp2.requireRecommendation===true,nudgeId,completedNudgeId,compressionInFlightNudgeId}";
const replaceGateShape = (label, previous, replacement) => {
  if (text.includes(replacement)) {
    console.log(label + ": already patched");
    return;
  }
  const anchor = previous.find(value => text.includes(value));
  if (!anchor) throw new Error(label + ": internal anchor moved");
  replaceOnce(label, anchor, replacement);
  console.log(label + ": patched");
};
replaceGateShape("nudge compression state", [NUDGE_GATE_STATE_OLD, NUDGE_GATE_STATE_DRAFT], NUDGE_GATE_STATE);
const NUDGE_GATE_READ_OLD = "return{armed:Number.isFinite(g2.credit)&&g2.credit>0,requireNudge:g2.requireNudge===true,requireRecommendation:g2.requireRecommendation===true}";
const NUDGE_GATE_READ_DRAFT = "return{armed:Number.isFinite(g2.credit)&&g2.credit>0,requireNudge:g2.requireNudge===true,requireRecommendation:g2.requireRecommendation===true,nudgeId:Number.isSafeInteger(g2.nudgeId)?g2.nudgeId:0,compressed:g2.compressed===true,compressionInFlight:g2.compressionInFlight===true}";
const NUDGE_GATE_READ = "return{armed:Number.isFinite(g2.credit)&&g2.credit>0,requireNudge:g2.requireNudge===true,requireRecommendation:g2.requireRecommendation===true,nudgeId:Number.isSafeInteger(g2.nudgeId)?g2.nudgeId:0,compressed:Number.isSafeInteger(g2.nudgeId)&&g2.nudgeId>0&&g2.completedNudgeId===g2.nudgeId,compressionInFlight:Number.isSafeInteger(g2.nudgeId)&&g2.nudgeId>0&&g2.compressionInFlightNudgeId===g2.nudgeId}";
replaceGateShape("nudge compression state read", [NUDGE_GATE_READ_OLD, NUDGE_GATE_READ_DRAFT], NUDGE_GATE_READ);
const NUDGE_COMPRESS_WRAPPER_DRAFT = 'async function applyConfiguredCompression(input,ctx,callId,signal){const gate=unpromptedGateOf(ctx.session);if(gate.compressionInFlight||gate.armed&&gate.compressed){const reason=gate.armed&&gate.compressed?"this nudge already completed one successful compression":"a compression for this nudge is already in progress";ctx.log(`[acp-proxy: refused duplicate nudge compression: ${reason}]`);return compressResult(`[Compression REFUSED: ${reason}. Do not call compress again for this nudge; continue the task. A new compression nudge is required before another fold.]`,"refused",0,"nudge-compress-once")}const nudgeId=gate.nudgeId;const ownsNudge=gate.armed;const current=ownsNudge?ctx.session.transient?.unpromptedGate:void 0;if(ownsNudge&&current&&current.nudgeId===nudgeId)current.compressionInFlight=true;try{const result=await applyConfiguredCompressionCore(input,ctx,callId,signal);const latest=ctx.session.transient?.unpromptedGate;if(ownsNudge&&latest&&latest.nudgeId===nudgeId){latest.compressionInFlight=false;if(latest.credit>0&&result?.outcome==="applied"&&result.blocksCreated>0)latest.compressed=true}return result}finally{const latest=ctx.session.transient?.unpromptedGate;if(ownsNudge&&latest&&latest.nudgeId===nudgeId)latest.compressionInFlight=false}}\n';
const NUDGE_COMPRESS_WRAPPER = readFileSync(join(here, "patches", "nudge-compress-wrapper.block.js"), "latin1").trimEnd() + "\n";
if (text.includes(NUDGE_COMPRESS_WRAPPER)) {
  console.log("one successful compression per nudge: already patched");
} else if (text.includes(NUDGE_COMPRESS_WRAPPER_DRAFT)) {
  replaceOnce("one successful compression per nudge", NUDGE_COMPRESS_WRAPPER_DRAFT, NUDGE_COMPRESS_WRAPPER);
  console.log("one successful compression per nudge: updated");
} else {
  replaceOnce("one successful compression per nudge", "async function applyConfiguredCompression(", NUDGE_COMPRESS_WRAPPER + "async function applyConfiguredCompressionCore(");
  console.log("one successful compression per nudge: patched");
}
// Estimates are useful for window checks but cannot prove an aborted request
// reached the model. Only trusted usage may consume its one-shot reanchor.
editFunction("aborted-turn growth source", "absorbAbortedTurnGrowth", body => editInside(
  "aborted-turn growth source",
  body,
  "function absorbAbortedTurnGrowth(session,tokenCount){",
  "function absorbAbortedTurnGrowth(session,tokenCount,tokenCountSource){if(tokenCountSource!==\"usage\")return;"
));
const ABORT_GROWTH_CALL = "absorbAbortedTurnGrowth(session,tokenCount);";
const ABORT_GROWTH_CALL_WITH_SOURCE = "absorbAbortedTurnGrowth(session,tokenCount,tokenCountSource);";
const abortGrowthCalls = text.split(ABORT_GROWTH_CALL).length - 1;
const abortGrowthCallsWithSource = text.split(ABORT_GROWTH_CALL_WITH_SOURCE).length - 1;
if (abortGrowthCalls === 4) {
  text = text.split(ABORT_GROWTH_CALL).join(ABORT_GROWTH_CALL_WITH_SOURCE);
  changed = true;
  console.log("aborted-turn growth callers: patched (4)");
} else if (abortGrowthCalls === 0 && abortGrowthCallsWithSource === 4) {
  console.log("aborted-turn growth callers: already patched (4)");
} else {
  throw new Error("aborted-turn growth callers: expected four source-aware calls, found " + abortGrowthCalls + " old and " + abortGrowthCallsWithSource + " patched");
}
// ── 19. no upstream circuit breaker ────────────────────────────────────────
// The proxy counted pre-response failures per upstream host and, after three,
// stopped contacting that host for a minute: every request then failed with
// "503 acp-proxy failure: connect-timeout <host> (circuit open, next probe +46s)"
// before a socket was opened, and a half-open probe let exactly one real request
// through. dsh already retries with its own backoff and cap, so this was a
// second, invisible retry policy; its only visible effects were that wording and
// a red banner (B20) nobody could dismiss. Requests fail normally now, and dsh's
// retry policy decides what happens next. What stays: classifyUpstreamFailure,
// isFailFastUpstreamKind (the outbound replay ladder shares it), the alert
// ledger (diagnostics only) and the English hints.
const cutSpan = (label, from, to, insert = "") => {
  const start = text.indexOf(from);
  const end = start < 0 ? -1 : text.indexOf(to, start + from.length);
  if (start < 0 || end < 0) {
    console.error(label + ': anchor "' + from.slice(0, 56) + '..." not found — upstream changed, re-derive the patch');
    process.exit(1);
  }
  text = text.slice(0, start) + insert + text.slice(end);
  changed = true;
};
const circuitGone = !text.includes("function upstreamCircuitBlockReason(url,now=Date.now())") && !text.includes("/__bili/upstreams");
if (circuitGone) {
  console.log("upstream circuit: already removed");
} else {
  cutSpan("upstream circuit", "var CIRCUIT_OPEN_AFTER=3;", "function truncateAtBoundary(s3,max){");
  cutSpan("upstream circuit", "function recordUpstreamCircuitFailure(url,error,viaProxy,detail){", "init_logger();init_knobs();");
  cutSpan("upstream circuit", "const circuitBlock=upstreamCircuitBlockReason(upstreamUrl);", "const throttleModel=throttleModelHint??");
  cutSpan("upstream circuit", "const openCircuits=getOpenUpstreamCircuits();", "const throttleHolds=activeThrottleHolds();");
  cutSpan("upstream circuit", 'if(req.method==="GET"&&req.url==="/__bili/upstreams"){', 'if(req.method==="GET"&&(req.url==="/__bili/sessions"||');
  replaceOnce("upstream circuit", "clearUpstreamAlertsForHost(upstreamUrl);recordUpstreamCircuitSuccess(upstreamUrl)", "clearUpstreamAlertsForHost(upstreamUrl)");
  replaceOnce("upstream circuit", "recordUpstreamCircuitFailure(upstreamUrl,error,proxyUrl!==void 0,failure.message);", "");
  console.log("upstream circuit: removed");
}

// ── 21. upstream failures read in Chinese ──────────────────────────────────
// dsh prints the error field of a proxy 5xx straight into the transcript, so a
// failed request used to read "acp-proxy failure: connect-timeout ETIMEDOUT
// <host> (circuit open, next probe +46s)": internal vocabulary, and since patch
// 19 describing a mechanism that no longer exists at all. The in-band stream
// errors have the same problem. Everything the reader can see is one Chinese
// sentence now; the English diagnostic stays in detail, in upstreamFailure and
// in the log.
const ZH = escapedCopy;
const FAIL_LABELS_ZH = {
  "client-abort": "：请求被本机取消了",
  "upstream-timeout": "响应超时，一直等不到数据",
  "upstream-headers-timeout": "迟迟没有返回第一个字节",
  "proxy-reset": "连接被中间代理掐断",
  "upstream-reset": "连接被上游掐断",
  "connect-refused": "拒绝连接",
  "connect-timeout": "连接超时，三次握手没有完成",
  "upstream-unreachable": "网络不可达",
  dns: "域名解析失败",
  tls: "TLS 握手失败",
  unknown: "连接失败"
};
const ZH_FAILURE_FN = [
  "function __biliFailureTextZh(msg,uf){",
  'const kind=uf&&typeof uf.kind==="string"?uf.kind:void 0;',
  'const host=uf&&typeof uf.host==="string"&&uf.host.length>0?uf.host:void 0;',
  'const code=uf&&typeof uf.code==="string"&&uf.code.length>0?uf.code:"";',
  'const who=host!==void 0?host:"' + ZH("上游端点") + '";',
  'if(msg.indexOf("exceeds")>=0)return"' + ZH("请求体太大：bili 已经压过一遍，仍然超过这个端点允许的上限") + '";',
  'if(uf===void 0)return"' + ZH("bili 代理请求失败，详情见日志") + '";',
  "const labels=" + asciiJson(FAIL_LABELS_ZH) + ";",
  'const known=kind!==void 0&&typeof labels[kind]==="string";',
  'if(kind==="client-abort")return who+labels[kind];',
  'const tail=code!==""?" ["+code+"]":"";',
  'if(!known)return who+"' + ZH(" 请求失败") + '"+tail+"' + ZH("——dsh 会自动重试") + '";',
  'return who+" "+labels[kind]+tail+"' + ZH("——dsh 会自动重试") + '"}',
].join("");

if (text.includes("__biliFailureTextZh")) {
  console.log("upstream failure text: already translated");
} else {
  cutSpan("upstream failure text", "function buildProxyFailureResponse(msg,err2){", "let status;const headers=", ZH_FAILURE_FN + "function buildProxyFailureResponse(msg,err2){const uf=upstreamFailureOf(err2);const errorField=__biliFailureTextZh(msg,uf);");
  replaceOnce("upstream failure text", '}else if(uf&&uf.circuitOpen===true){status=503;if(typeof uf.retryAfterSeconds==="number")headers["retry-after"]=String(Math.max(1,Math.ceil(uf.retryAfterSeconds)))}else{status=502}', "}else{status=502}");
  replaceOnce("upstream failure text", 'if(uf&&uf.circuitOpen===true)diag.circuitOpen=true;if(uf&&typeof uf.retryAfterSeconds==="number")diag.retryAfterSeconds=uf.retryAfterSeconds;', "");
  cutSpan("upstream failure text", "var TRANSPORT_FAILURE_LABELS={", ";function activeAbsorbToolName(", "var TRANSPORT_FAILURE_LABELS=" + asciiJson(FAIL_LABELS_ZH));
  const noteZh = 'const note=committedTokens>0?`' + ZH("已压缩并提交（约省 ") + '${committedTokens.toLocaleString("en-US")} tokens' + '${committedBlocks>0?`' + ZH("，共 ") + '${committedBlocks}' + ZH(" 块") + '`:' + '""}' + ZH("）；") + '`:absorbed?"' + ZH("上下文已提交，继续。 ") + '":"";';
  cutSpan("upstream failure text", "const note=committedTokens>0?", "const msg=", noteZh);
  replaceOnce("upstream failure text", "the follow-up request to the model failed (${TRANSPORT_FAILURE_LABELS[kind]}) before any response \\u2014 your context is intact, resend your last message to continue", ZH("发给模型的后续请求失败了（") + "${TRANSPORT_FAILURE_LABELS[kind]}" + ZH("）；还没有收到任何响应，上下文没有被破坏，重发上一条消息即可继续"));
  replaceOnce("upstream failure text", 'adapter.emitError(`upstream error ${e.status}${suffix}: ${e.body.slice(0,200)}`)', 'adapter.emitError(`' + ZH("上游返回错误 ") + '${e.status}${suffix}' + ZH("：") + '${e.body.slice(0,200)}`)');
  replaceOnce("upstream failure text", 'adapter.emitError(`upstream error ${respResult.response.status}: empty response body`)', 'adapter.emitError(`' + ZH("上游返回错误 ") + '${respResult.response.status}' + ZH("：响应体为空") + '`)');
  replaceOnce("upstream failure text", 'const detail=streamError!==void 0?`upstream stream error: ${streamError}`:"no completion event";', 'const detail=streamError!==void 0?`' + ZH("上游流错误：") + '${streamError}`:"' + ZH("没有收到结束事件") + '";');
  replaceOnce("upstream failure text", 'const msg=`upstream stream truncated (${detail}; round ${round}, ${partialText} text chars + ${partialReasoning} reasoning chars received)`', 'const msg=`' + ZH("上游响应中断（") + '${detail}' + ZH("；第 ") + '${round}' + ZH(" 轮，已收到 ") + '${partialText}' + ZH(" 字正文、") + '${partialReasoning}' + ZH(" 字推理）") + '`');
  replaceOnce("upstream failure text", '"upstream stream ended before a completion event; this turn may be incomplete"', '"' + ZH("上游在结束事件之前就断流了，这一轮可能不完整") + '"');
  replaceOnce("upstream failure text", "[ACP] stream error: ${message}", "[ACP] " + ZH("流错误：") + "${message}");
  console.log("upstream failure text: translated");
}
// 22. Recover a degraded snapshot once, before judging the rebuilt payload.
// B21 also covers every preflight response, including committed streams.
const PREFLIGHT_BLOCK = readFileSync(join(here, "patches", "preflight.block.js"), "utf8").trimEnd();
cardUpsert("preflight helpers", "// <bili-preflight begin>", "// <bili-preflight end>",
  escapedCopy(PREFLIGHT_BLOCK).replace(/\\u000A/g, "\n"), "function emitPreflightError(", false);
const PREFLIGHT_ENTRY = "async function preflightCompressIfNeeded(prepared,runPrepare,req,inboundBody,res,opts,core,config,configuredWindow,model,resolvedNativeWindow,windowShrinkReason,route,affinity,anonymous,log2,instanceId){";
const PREFLIGHT_RECOVERED = PREFLIGHT_ENTRY + 'prepared=await __biliRecoverSnapshot(prepared,runPrepare,res,log2);if(prepared===null)return{failFast:true,status:0,message:"snapshot recovery aborted",retryable:false,respond:false};';
const PREFLIGHT_HTTP_OLD = 'if(res.headersSent){if(prepared.stream){emitPreflightError(res,prepared.commandcode?"commandcode":prepared.protocol,{message:outcome.message,retryable:outcome.retryable},m2=>log2("warn",m2))}else{try{res.end(JSON.stringify({error:{type:"server_error",code:"preflight_compress_failed",message:outcome.message,retryable:outcome.retryable}}))}catch{}}}else{res.writeHead(outcome.status,{"content-type":"application/json",...outcome.status===503?{"retry-after":"30"}:{}});res.end(JSON.stringify({error:{type:"server_error",code:"preflight_compress_failed",message:outcome.message,retryable:outcome.retryable}}))}';
const PREFLIGHT_HTTP_NEW = 'if(res.headersSent&&prepared.stream){emitPreflightError(res,prepared.commandcode?"commandcode":prepared.protocol,outcome,m2=>log2("warn",m2))}else{__biliReplyPreflight(res,outcome)}';
const PREFLIGHT_EDITS = [
  ["snapshot recovery entry", PREFLIGHT_ENTRY, PREFLIGHT_RECOVERED],
  ["snapshot retry classification",
    "const ff=failFast(status,ffDetail,retryable,",
    'const ff=failFast(status,ffDetail,retryable||status===502&&imageTokens+overheadEstimate<limit&&(f2===void 0||f2.kind==="exhausted"&&!f2.deterministic)&&__biliSnapshotRetryable(prepared),'],
  ["preflight status",
    'const status=f2?.kind==="upstream"&&f2.status===429?503:f2?.kind==="exhausted"&&f2.deterministic&&!payloadFitsWindow?413:502;',
    'const status=f2?.kind==="exhausted"&&f2.deterministic&&!payloadFitsWindow?413:502;'],
  ["preflight HTTP response", PREFLIGHT_HTTP_OLD, PREFLIGHT_HTTP_NEW],
  ["preflight stream error",
    'function emitPreflightError(res,protocol,error,log2){const err2={type:"server_error",code:"preflight_compress_failed",message:error.message,retryable:error.retryable};',
    'function emitPreflightError(res,protocol,error,log2){const err2=__biliPreflightError(error);'],
  ["preflight responses stream metadata",
    '{type:"error",code:err2.code,message:err2.message}',
    '{type:"error",code:err2.code,message:err2.message,retryable:err2.retryable,detail:err2.detail}'],
  ["preflight google stream metadata",
    '{error:{code:error.retryable?503:500,message:error.message,status:error.retryable?"UNAVAILABLE":"INTERNAL"}}',
    '{error:{code:error.status===413?413:502,message:err2.message,status:err2.retryable?"UNAVAILABLE":"INTERNAL",retryable:err2.retryable,detail:err2.detail}}'],
  ["preflight anthropic stream metadata",
    '{type:"error",error:{type:"server_error",code:err2.code,message:err2.message}}',
    '{type:"error",error:err2}'],
  ["decoded request backpressure",
    'log2("warn","503: large decoded request budget is busy");res.writeHead(503,{"content-type":"application/json","retry-after":"1"});res.end(JSON.stringify({error:{type:"request_body_busy",stage:"decode",message:err2.message}}));',
    'log2("warn","502: large decoded request budget is busy");res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:{type:"request_body_busy",stage:"decode",message:"' + ZH("请求处理资源暂时繁忙，DSH 会自动重试。") + '",detail:err2.message,retryable:true}}));'],
];
for (const [label, old, next] of PREFLIGHT_EDITS) {
  if (text.includes(next)) continue;
  replaceOnce(label, old, next);
}
console.log("preflight recovery and errors: patched");
// Applying existing blocks can make the kernel view fit without creating a new
// summary. Rebuild the wire payload in that case too, and judge the rebuilt
// messages rather than trusting the inner fit or the stale raw preparation.
editFunction("preflight existing-block rebuild", "preflightCompressIfNeeded", body => {
  let next = editInside("zero-fold rebuild", body,
    'if(result.compressedRanges>0){const rebuilt=pendingRebuild??await runPrepare();if(pendingRebuild===void 0){session.stats.requests-=1}pendingRebuild=void 0;outbound=rebuilt;',
    'if(result.compressedRanges>0||result.fitsWindow&&!payloadFitsWindow){let rebuilt=pendingRebuild;if(rebuilt===void 0){const requests=session.stats.requests;try{rebuilt=await runPrepare()}finally{if(session.stats.requests!==requests){session.stats.requests=requests;markDirty(session)}}}pendingRebuild=void 0;if(rebuilt.failFast)return rebuilt;outbound=rebuilt;');
  // The corrective probe is another prepare replay, including its queued save.
  next = editInside("corrective probe replay", next,
    'const probe=await runPrepare();session.stats.requests-=1;pendingRebuild=probe;',
    'let probe;const requests=session.stats.requests;try{probe=await runPrepare()}finally{if(session.stats.requests!==requests){session.stats.requests=requests;markDirty(session)}}if(probe.failFast)return probe;pendingRebuild=probe;');
  const oldFit = 'fits=unknownBaseline&&result.compressedRanges>0?result.fitsWindow:(unknownBaseline?estimateCoreMessagesUpper(rebuiltMsgs)+overheadEstimate+imageTokens:rebuiltCalibrated)<limit;';
  const newFit = oldFit.replace('+imageTokens:', '+rebuiltImageTokens:');
  if (next.includes(oldFit)) next = editInside("zero-fold rebuilt image reserve migration", next, oldFit, newFit);
  next = editInside("zero-fold fit proof", next,
    'fits=unknownBaseline?result.fitsWindow:rebuiltCalibrated<limit;', newFit);
  return editInside("zero-fold rebuild log", next,
    'log2("info",`[${session.id}] preflight compressed ${result.compressedRanges} range(s),',
    'if(result.compressedRanges===0)log2("info",`[${session.id}] preflight refreshed existing snapshot (~${foldedCalibratedSize}/${limit}) without new folds`);else log2("info",`[${session.id}] preflight compressed ${result.compressedRanges} range(s),');
});

const SNAPSHOT_BEGIN_OLD = 'function maybeSnapshotView(session,clientMsgs,deps){';
const SNAPSHOT_BEGIN_NEW = SNAPSHOT_BEGIN_OLD + '__biliBeginSnapshotTurn(session,clientMsgs,deps);';
if (!text.includes(SNAPSHOT_BEGIN_NEW)) replaceOnce("fresh snapshot attempt", SNAPSHOT_BEGIN_OLD, SNAPSHOT_BEGIN_NEW);
const SNAPSHOT_CORE_OLD = 'const turn=core.processTurn({messages:renderMsgs';
const SNAPSHOT_CORE_NEW = 'const turn=__biliSnapshotAwareTurn(session,core,{messages:renderMsgs';
if (!text.includes(SNAPSHOT_CORE_NEW)) {
  if (text.split(SNAPSHOT_CORE_OLD).length - 1 !== 4) throw new Error("snapshot turn guard: expected four protocol prepares");
  text = text.split(SNAPSHOT_CORE_OLD).join(SNAPSHOT_CORE_NEW);
  changed = true;
}
console.log("snapshot transient miss preserves refs, timestamps and blocks: patched");
for (const name of ["prepareOpenai", "prepareAnthropic", "prepareGoogle", "prepareResponses"]) {
  editFunction("deferred snapshot post-processing " + name, name, body => {
    let next = body;
    if (name !== "prepareResponses") {
      next = editInside(name + " rewrite gate", next, 'const rewrite=detectUnannouncedHistoryRewrite(',
        'const rewrite=turn.__biliSnapshotDeferred?{churnExplained:false,detected:false}:detectUnannouncedHistoryRewrite(');
    }
    next = editInside(name + " archive gate", next,
      'applyCompactionArchive(session,activeBefore,new Set(msgs.map(m2=>m2.id)),log2)',
      'if(!turn.__biliSnapshotDeferred)applyCompactionArchive(session,activeBefore,new Set(msgs.map(m2=>m2.id)),log2)');
    return editInside(name + " orphan gate", next, 'reapOrphansLogged(session,msgs,log2,sessionId)',
      'if(!turn.__biliSnapshotDeferred)reapOrphansLogged(session,msgs,log2,sessionId)');
  });
}
editFunction("deferred snapshot diagnostic count", "recordNudgeObservation", body => editInside("deferred observation", body,
  'surfaceOff){const now=Date.now();', 'surfaceOff){if(turn.__biliSnapshotDeferred)return null;const now=Date.now();'));

// B21 applies at every error sink, including loop-originated failures and the
// HTTP-to-WebSocket conversion. Original diagnostics ride a separate field.
const STREAM_BLOCK = readFileSync(join(here, "patches", "stream-errors.block.js"), "utf8").trimEnd();
if (/[^\x00-\x7e]/.test(STREAM_BLOCK)) throw new Error("stream errors must use ASCII escapes");
const shippedStreamFunction = name => uniqueBlockSpan(STREAM_BLOCK, name, "function " + name + "(", { expression:true }).block;
if (!text.includes("function __biliStreamErrorInfo(")) {
  replaceOnce("stream error information", "function nativeErrorChunk(", shippedStreamFunction("__biliStreamErrorInfo") + "\nfunction nativeErrorChunk(");
}
for (const name of ["nativeErrorChunk", "emitStreamError"]) {
  editFunction("Chinese " + name, name, () => shippedStreamFunction(name));
}
editFunction("completion diagnostic metadata", "legacyCompletionChunk", body => {
  body = editInside("completion detail parameter", body,
    "function legacyCompletionChunk(protocol,visible,state7){", "function legacyCompletionChunk(protocol,visible,state7,detail){");
  body = editInside("completion openai detail", body, '{choices:[{index:0,delta:{content:visible},finish_reason:null}]}', '{detail,choices:[{index:0,delta:{content:visible},finish_reason:null}]}');
  body = editInside("completion responses detail", body, '{type:"response.output_text.delta",item_id:itemId,output_index:oi2,delta:visible}', '{type:"response.output_text.delta",item_id:itemId,output_index:oi2,delta:visible,detail}');
  body = editInside("completion google detail", body, '{error:{code:500,message:visible,status:"INTERNAL"}}', '{error:{code:502,message:visible,status:"INTERNAL",detail}}');
  body = editInside("completion commandcode detail", body, '{type:"error",error:"acp_proxy_error",message:visible}', '{type:"error",error:"acp_proxy_error",message:visible,detail}');
  return editInside("completion anthropic detail", body, '{type:"content_block_delta",index:blockIndex,delta:{type:"text_delta",text:visible}}', '{type:"content_block_delta",index:blockIndex,delta:{type:"text_delta",text:visible},detail}');
});
editFunction("truncation google status", "emitUpstreamTruncation", body => editInside("truncation status", body,
  'code:503,message,status:"UNAVAILABLE"', 'code:502,message,status:"INTERNAL"'));

for (const name of ["createOpenaiAdapter", "createAnthropicAdapter", "createResponsesAdapter", "createGoogleAdapter", "createCommandcodeAdapter"]) {
  editFunction("loop error information " + name, name, body => {
    body = editInside(name + " error entry", body, 'emitError(message){', 'emitError(message){const __biliError=__biliStreamErrorInfo(message);');
    if (name === "createOpenaiAdapter" || name === "createAnthropicAdapter") {
      body = editInside(name + " native error", body, 'message:`[acp-proxy: ${message}]`', 'message:__biliError.message,detail:__biliError.detail');
      const old = name === "createOpenaiAdapter" ? 'buildContent(`\n[acp-proxy: ${message}]\n`)' : 'buildTextBlock(clientIndex++,`\n[acp-proxy: ${message}]\n`)';
      const next = name === "createOpenaiAdapter" ? 'buildContent(`\n${__biliError.message}\n`)' : 'buildTextBlock(clientIndex++,`\n${__biliError.message}\n`)';
      body = editInside(name + " completion text", body, old, next);
      // Completion compatibility retains its established lifecycle, with the
      // detail on its content frame. It must never spill into the text itself.
      const completionFrame = name === "createOpenaiAdapter"
        ? 'return Buffer.concat([buildContent(`\n${__biliError.message}\n`),buildFinish("stop",null),Buffer.from("data: [DONE]\\n\\n","utf8")])'
        : 'parts.push(buildTextBlock(clientIndex++,`\n${__biliError.message}\n`));parts.push(buildTerminal("end_turn",0,0,0))';
      const tagged = name === "createOpenaiAdapter"
        ? 'const __biliContent=buildContent(`\n${__biliError.message}\n`);return Buffer.concat([Buffer.from(__biliContent.toString("utf8").replace(/data: (\\{[^\\n]+\\})/g,(_,j)=>"data: "+JSON.stringify({...JSON.parse(j),detail:__biliError.detail})),"utf8"),buildFinish("stop",null),Buffer.from("data: [DONE]\\n\\n","utf8")])'
        : 'const __biliContent=buildTextBlock(clientIndex++,`\n${__biliError.message}\n`);parts.push(Buffer.from(__biliContent.toString("utf8").replace(/data: (\\{[^\\n]+\\})/g,(_,j)=>"data: "+JSON.stringify({...JSON.parse(j),detail:__biliError.detail})),"utf8"));parts.push(buildTerminal("end_turn",0,0,0))';
      body = editInside(name + " completion metadata", body, completionFrame, tagged);
    } else if (name === "createResponsesAdapter") {
      body = editInside(name + " native error", body, 'error:{code:"server_error",message}', 'error:{code:"server_error",...__biliError}');
      body = editInside(name + " missing response", body, 'error:{code:"server_error",message:"upstream returned no response"}', 'error:{code:"server_error",...__biliStreamErrorInfo("upstream returned no response")}');
    } else if (name === "createGoogleAdapter") {
      body = editInside(name + " native error", body, '{error:{code:500,message,status:"INTERNAL"}}', '{error:{code:500,...__biliError,status:"INTERNAL"}}');
    } else {
      body = editInside(name + " native error", body, '{type:"error",error:"acp_proxy_error",message}', '{type:"error",error:"acp_proxy_error",...__biliError}');
    }
    return body;
  });
}
const WS_NO_TERMINAL = 'errorFrame("incomplete_response","Responses exchange ended without a terminal event",status)';
const WS_NO_TERMINAL_NEW = 'JSON.stringify({type:"error",status,error:{code:"incomplete_response",...__biliStreamErrorInfo("Responses exchange ended without a terminal event")}})';
if (!text.includes(WS_NO_TERMINAL_NEW)) replaceOnce("WS incomplete response", WS_NO_TERMINAL, WS_NO_TERMINAL_NEW);
const WS_DETAIL_OLD = 'message:detailText!==""&&detailText!==rawError?`${rawError}: ${detailText}`:rawError';
const WS_DETAIL_NEW = 'message:rawError,...detailText!==""?{detail:detailText}:{}';
if (!text.includes(WS_DETAIL_NEW)) replaceOnce("WS separate diagnostic", WS_DETAIL_OLD, WS_DETAIL_NEW);
const WS_EMPTY_OLD = '{code:"incomplete_response",message:"Responses exchange ended without a terminal event"}';
const WS_EMPTY_NEW = '{code:"incomplete_response",...__biliStreamErrorInfo("Responses exchange ended without a terminal event")}';
if (!text.includes(WS_EMPTY_NEW)) replaceOnce("WS empty response", WS_EMPTY_OLD, WS_EMPTY_NEW);
editFunction("WS local admission and transport errors", "errorFrame", body => editInside("WS local error information", body,
  'function errorFrame(code,message,status=400){return JSON.stringify({type:"error",status,error:{type:"invalid_request_error",code,message}})}',
  'function errorFrame(code,message,status=400){const info=status===413||status>=500?__biliStreamErrorInfo(message):{message};return JSON.stringify({type:"error",status,error:{type:"invalid_request_error",code,...info}})}'));
console.log("Chinese stream, loop and WS error sinks: patched");

// A retry reuses a fresh plaintext body. A prior attempt may have written its
// compressed header onto the shared object, so recover the plaintext headers
// before the transform runs; the signature still covers the actual bytes.
const RETRY_OLD = 'const finalizeEgress=async variant=>{const transformed=await runEgress(variant,"retry",headers);applyResign(headers,transformed);return v1Wrap(transformed)};';
const RETRY_NEW = 'const finalizeEgress=async variant=>{headers=__biliPlaintextHeaders(headers);const transformed=await runEgress(variant,"retry",headers);applyResign(headers,transformed);return v1Wrap(transformed)};';
if (!text.includes(RETRY_NEW)) replaceOnce("retry plaintext header ownership", RETRY_OLD, RETRY_NEW);
// #5998 drops unsigned thinking after the original sign site. Move that step
// ahead of shed/transforms/finalization so the signature covers actual bytes.
const THINKING_START = 'if(prepared&&!prepared.sidePassthrough&&prepared.protocol==="anthropic"&&req.method!=="GET"&&req.method!=="HEAD"&&typeof wireBody==="string"&&thinkingPostureIsStrict(prepared.session)){';
const THINKING_DEST = 'if(prepared&&!prepared.sidePassthrough&&prepared.protocol&&req.method!=="GET"&&req.method!=="HEAD"&&typeof wireBody==="string"){';
const THINKING_MARK = '// <bili-thinking-before-egress>\n';
if (!text.includes(THINKING_MARK)) {
  const moving = uniqueBlockSpan(text, "strict thinking placement", THINKING_START).block;
  replaceOnce("strict thinking remove late scrub", moving, "");
  const guarded = editInside("strict thinking provenance", moving, 'wireBody=dropped.body;log2(', 'wireBody=dropped.body;outboundCopyRewritten=true;invalidateSeparatorOwnership();log2(');
  replaceOnce("strict thinking before egress", THINKING_DEST, THINKING_MARK + guarded + THINKING_DEST);
}
console.log("retry plaintext header ownership: patched");

editFunction("additional forward send context", "forwardCaptured", body => {
  let next = body;
  next = editInside("mutable forward header ownership", next,
    'const{upstreamUrl,headers,proxyUrl,skippedProxy}=buildForwardTarget(req,opts,route,affinity,prepared!==null?instanceId:void 0);',
    'const{upstreamUrl,headers:initialForwardHeaders,proxyUrl,skippedProxy}=buildForwardTarget(req,opts,route,affinity,prepared!==null?instanceId:void 0);let headers=initialForwardHeaders;');
  if (!next.includes('body:await finalizeEgress(shrunkWire),headers')) {
    let count = 0;
    next = next.replace(/\{\.\.\.init,body:await finalizeEgress\(([^()]*)\)\}/g, (_, variant) => {
      count++;
      return '{...init,body:await finalizeEgress(' + variant + '),headers}';
    });
    if (count !== 6) throw new Error("recovery headers: expected six sends, found " + count);
  }
  const oldHeaders = 'reqHeaders:buildForwardHeaders(headers),resign:applyResign';
  const newHeaders = 'reqHeaders:__biliPlaintextHeaders(headers,buildForwardHeaders(headers)),resign:applyResign';
  if (!next.includes(newHeaders)) {
    if (next.split(oldHeaders).length - 1 !== 8) throw new Error("aux forward headers: expected eight sends");
    next = next.split(oldHeaders).join(newHeaders);
  }
  for (const name of ["reqHeaders", "requestHeaders", "anthropicReqHeaders"]) {
    next = editInside("loop header projection " + name, next, 'const ' + name + '=buildForwardHeaders(headers);',
      'const ' + name + '=__biliPlaintextHeaders(headers,buildForwardHeaders(headers));');
    next = editInside("loop egress actual headers " + name, next, 'egress:b2=>runEgress(b2,"loop",' + name + ')',
      'egress:(b2,h)=>runEgress(b2,"loop",h??' + name + ')');
  }
  return next;
});

// Every loop round is new plaintext. A prior round's compressed header belongs
// to its buffer only; transform and signature hooks use this round's copy.
const LOOP_HEADERS_OLD = 'let wireBodyStr=scrubLoneSurrogateEscapesOnJson(JSON.stringify(wireObj));let wireShedRewrote=false;';
const LOOP_HEADERS_NEW = 'requestOptions.headers=__biliPlaintextHeaders(requestOptions.headers);let wireBodyStr=scrubLoneSurrogateEscapesOnJson(JSON.stringify(wireObj));let wireShedRewrote=false;';
if (!text.includes(LOOP_HEADERS_NEW)) replaceOnce("loop plaintext headers", LOOP_HEADERS_OLD, LOOP_HEADERS_NEW);
const LOOP_TRANSFORM_OLD = 'requestOptions.egress(wireBodyStr)';
const LOOP_TRANSFORM_NEW = 'requestOptions.egress(wireBodyStr,requestOptions.headers)';
if (!text.includes(LOOP_TRANSFORM_NEW)) replaceOnce("loop transform header copy", LOOP_TRANSFORM_OLD, LOOP_TRANSFORM_NEW);
console.log("auxiliary plaintext header ownership: patched");

// Preserve the 413/code/stage contract while keeping English fuse diagnostics
// separate from the model-visible Chinese message.
editFunction("forward local errors", "forwardCaptured", body => {
  let next = body;
  for (const [value, count] of [["err2.message", 1], ["countMessage", 1], ["fuseMessage", 2]]) {
    const old = 'stage:"forward",message:' + value;
    const replacement = 'stage:"forward",message:__biliPreflightError({status:413}).message,detail:' + value;
    if (next.includes(replacement)) continue;
    if (next.split(old).length - 1 !== count) throw new Error("forward 413 " + value + ": anchor moved");
    next = next.split(old).join(replacement);
  }
  return next;
});

// The receive and decode catches also terminate model requests before forward.
// Keep their guard, status and stage; expose the original limit in detail only.
for (const [label, stage] of [
  ["incremental receive 413", '"receive"'],
  ["ingress receive/decode/ingest 413", 'err2 instanceof IngestBodyTooLargeError?"ingest":err2 instanceof BodyTooLargeError?"receive":"decode"'],
]) {
  const prefix = '{error:{type:"request_too_large",stage:' + stage;
  const old = prefix + ',message:err2.message}}';
  const next = prefix + ',message:__biliPreflightError({status:413}).message,detail:err2.message}}';
  if (!text.includes(next)) replaceOnce(label, old, next);
}
const SIDE_TOO_LARGE_OLD = 'code:"side_request_payload_too_large",message:';
const SIDE_TOO_LARGE_NEW = 'code:"side_request_payload_too_large",message:__biliPreflightError({status:413}).message,detail:';
if (!text.includes(SIDE_TOO_LARGE_NEW)) replaceOnce("side request 413", SIDE_TOO_LARGE_OLD, SIDE_TOO_LARGE_NEW);
const TUNNEL_DENIAL_OLD = 'JSON.stringify({error:verdict.message,code:"tunnel_destination_denied",detail:verdict.code})';
const TUNNEL_DENIAL_NEW = 'JSON.stringify(verdict.code==="unresolvable"?{error:__biliFailureTextZh(verdict.message,{kind:"dns",host:new URL(route.upstream).hostname}),code:"tunnel_destination_denied",detail:verdict.code,upstreamFailure:{kind:"dns",host:new URL(route.upstream).hostname,hint:verdict.message}}:{error:verdict.message,code:"tunnel_destination_denied",detail:verdict.code})';
if (!text.includes(TUNNEL_DENIAL_NEW)) replaceOnce("model tunnel DNS failure", TUNNEL_DENIAL_OLD, TUNNEL_DENIAL_NEW);

// I1: inspect only the SQLite header, without opening a database lock or
// synchronously materializing the entire database. WAL uses 2 in both bytes.
editFunction("SQLite WAL header", "dbFileIsAlreadyWal", body => editInside("SQLite WAL header", body,
  'function dbFileIsAlreadyWal(dbPath){try{const head=readFileSync7(dbPath);return head.length>=100&&head[18]===0&&head[19]===2}catch{return false}}',
  'function dbFileIsAlreadyWal(dbPath){const fs=require("node:fs");let fd;try{fd=fs.openSync(dbPath,"r");const head=Buffer.alloc(100);return fs.readSync(fd,head,0,100,0)===100&&head[18]===2&&head[19]===2}catch{return false}finally{if(fd!==void 0)try{fs.closeSync(fd)}catch{}}}'));

if (changed) {
  // The harness loads this build as a module, and a script-mode check is not the
  // same grammar: an anchor that leaves an extra brace can pass one and fail the
  // other, and the smoke chain then dies far away with a raw V8 position. Check
  // it as a module before anything is written.
  const probe = join(tmpdir(), "bili-parse-check-" + process.pid + ".mjs");
  writeFileSync(probe, text, "latin1");
  try {
    execFileSync(process.execPath, ["--check", probe], { stdio: "pipe" });
  } catch (error) {
    rmSync(probe.replace(/\.mjs$/, ".keep.mjs"), { force: true });
    renameSync(probe, probe.replace(/\.mjs$/, ".keep.mjs"));
    const detail = String(error.stderr ?? error).split("\n").slice(0, 4).join("\n");
    console.error("patched build does not parse as a module; nothing written\n" + detail);
    process.exit(1);
  }
  rmSync(probe, { force: true });
  writeFileSync(target, text, "latin1");
  console.log("written " + target);
}
