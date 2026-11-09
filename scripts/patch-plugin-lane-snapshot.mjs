#!/usr/bin/env node
// Two written-in changes on the vendored billion-context build. Both are
// re-applied by install.mjs after any build lands, so an upstream refresh
// cannot quietly drop them.
//
//   1. plugin-lane snapshot render  — the dsh shim resends the whole history
//      every turn; snapshot render is skipped on plugin lanes by design, so the
//      outbound prefix was re-derived (and re-folded) each round and the cache
//      seam landed mid-body. The guard now asks a marker file.
//
//   2. fork child renders the parent transcript on its first request — the
//      child has no unified rows until its first save, which is exactly the
//      turn that could have reused the parent's cached prefix.
//
// Usage: node scripts/patch-plugin-lane-snapshot.mjs [dist/index.js]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");
let text = readFileSync(target, "latin1");
let changed = false;

// ── 1. the plugin-lane guard ────────────────────────────────────────────────
const ORIGINAL = "if(deps.pluginMode)return clientMsgs;";
const PATCHED = "if(deps.pluginMode&&!__biliPluginLaneSnapshot())return clientMsgs;";
const VIEW_ANCHOR = "function maybeSnapshotView(session,clientMsgs,deps){";
const HELPER_LANE =
  'function __biliPluginLaneSnapshot(){const v=process.env.BILI_PLUGIN_SNAPSHOT;if(v==="1")return true;if(v==="0")return false;try{const fs9=require("node:fs"),path9=require("node:path"),os9=require("node:os"),base9=process.env.XDG_CONFIG_HOME||path9.join(os9.homedir(),".config");return fs9.existsSync(path9.join(base9,"billion-context","plugin-lane-snapshot.on"))}catch{return false}}';

if (text.includes(PATCHED) && text.includes("function __biliPluginLaneSnapshot()")) {
  console.log("plugin-lane snapshot: already patched");
} else {
  const hits = text.split(ORIGINAL).length - 1;
  if (hits !== 1) {
    console.error("plugin-lane snapshot: expected exactly one guard, found " + hits + " — upstream changed, re-derive the patch");
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

// ── 2. a fork child renders the parent transcript on its first request ──────
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
      console.error('fork transcript source: "' + find + '" matched ' + n + ' times inside loadTranscriptBase, expected 1');
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
