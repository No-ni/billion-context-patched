#!/usr/bin/env node
// Let billion-context's snapshot render serve plugin lanes too (local experiment).
//
// snapshot-render.ts opens with `if (deps.pluginMode) return clientMsgs;`: plugin
// lanes are client-authoritative by design. The dsh shim is a plugin lane that
// resends the FULL conversation every turn, so the outbound prefix is re-derived
// (and re-folded) each round and the upstream prompt cache stops matching in the
// middle of the body — the fork turns measured 10% and 11% cache hits.
//
// The guard is rewritten to consult a marker file, so the lane can opt in without
// rebuilding and can be switched off by deleting one file:
//
//   ~/.config/billion-context/plugin-lane-snapshot.on   (present = lane may render)
//   BILI_PLUGIN_SNAPSHOT=0|1                            (overrides the file)
//
// Outbound bytes stay untouched until billion-context's own `snapshotRender`
// rollout is on; with the rollout off this only feeds the snapshot-shadow
// observer. Run after every upstream build: node scripts/patch-plugin-lane-snapshot.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");

const ORIGINAL = "if(deps.pluginMode)return clientMsgs;";
const PATCHED = "if(deps.pluginMode&&!__biliPluginLaneSnapshot())return clientMsgs;";
const ANCHOR = "function maybeSnapshotView(session,clientMsgs,deps){";
const HELPER =
  "function __biliPluginLaneSnapshot(){const v=process.env.BILI_PLUGIN_SNAPSHOT;if(v===\"1\")return true;if(v===\"0\")return false;try{const fs9=require(\"node:fs\"),path9=require(\"node:path\"),os9=require(\"node:os\"),base9=process.env.XDG_CONFIG_HOME||path9.join(os9.homedir(),\".config\");return fs9.existsSync(path9.join(base9,\"billion-context\",\"plugin-lane-snapshot.on\"))}catch{return false}}";

const text = readFileSync(target, "latin1");
if (text.includes(PATCHED) && text.includes("function __biliPluginLaneSnapshot()")) {
  console.log("plugin-lane snapshot: already patched");
  process.exit(0);
}
const hits = text.split(ORIGINAL).length - 1;
if (hits !== 1) {
  console.error("plugin-lane snapshot: expected exactly one guard, found " + hits + " — upstream changed, re-derive the patch");
  process.exit(1);
}
if (text.split(ANCHOR).length !== 2) {
  console.error("plugin-lane snapshot: maybeSnapshotView anchor not unique — upstream changed");
  process.exit(1);
}
writeFileSync(target, text.replace(ORIGINAL, PATCHED).replace(ANCHOR, HELPER + ANCHOR), "latin1");
console.log("plugin-lane snapshot: patched " + target);
