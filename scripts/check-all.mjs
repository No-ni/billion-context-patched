#!/usr/bin/env node
// Offline means no host/profile/model access; tests may use loopback ports and
// the host's image encoder. Host checks are explicit and never silently skipped.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const host = args.includes("--host");
const at = args.indexOf("--host-modules");
const modules = at >= 0 ? args[at + 1] : process.env.DSH_HOST_MODULES;
const allowed = new Set(["--offline", "--host", "--host-modules", ...(at >= 0 && modules ? [modules] : [])]);
if (args.some(arg => !allowed.has(arg)) || (host && args.includes("--offline")) ||
    (at >= 0 && (!modules || modules.startsWith("--"))) || (!host && at >= 0)) {
  throw new Error("usage: node scripts/check-all.mjs [--offline | --host --host-modules <directory>]");
}
if (host && !modules) throw new Error("host checks NOT RUN: supply --host-modules or DSH_HOST_MODULES");
const steps = host ? ["check-runtime", "check-ledger-runtime"] : [
  "check-maintenance", "check-release", "check-views", "check-image-retention",
  "check-image-card", "check-upstream-ux", "check-preflight", "smoke", "check-outbound-encoding", "check-restart", "check-wrapper", "check-e2e-mock",
];
for (const step of steps) {
  console.log("\n> " + step);
  execFileSync(process.execPath, [fileURLToPath(new URL(`./${step}.mjs`, import.meta.url)),
    ...(host ? ["--host-modules", modules] : [])], { stdio: "inherit" });
}
console.log(`\n${host ? "host" : "offline"} checks passed (${steps.length} scripts)`);
if (!host) console.log("Host integration and real DSH/model checks are not part of this run.");
