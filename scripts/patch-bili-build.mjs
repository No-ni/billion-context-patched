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

if (changed) {
  writeFileSync(target, text, "latin1");
  console.log("written " + target);
}
