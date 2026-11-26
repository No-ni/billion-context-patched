#!/usr/bin/env node
// Offline means no host/profile/model access; tests may use loopback ports and
// the host's image encoder. Host checks are explicit and never silently skipped.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REQUIRED_HOST_DSH = "0.2.2-rc.5";

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
if (host) {
  let packageVersion;
  try {
    packageVersion = JSON.parse(readFileSync(join(modules, "@deepseek-ai", "dsh", "package.json"), "utf8")).version;
  } catch (error) {
    throw new Error(`host checks NOT RUN: ${modules} does not contain @deepseek-ai/dsh/package.json (${error.message})`);
  }
  if (packageVersion !== REQUIRED_HOST_DSH) {
    throw new Error(`host checks NOT RUN: expected @deepseek-ai/dsh@${REQUIRED_HOST_DSH}, found ${packageVersion ?? "unknown"} in ${modules}`);
  }
}
const steps = host ? ["check-runtime", "check-ledger-runtime"] : [
  "check-maintenance", "check-release", "check-views", "check-fold-seam",
  "check-compaction-gate",
  "check-image-card", "check-image-budget", "check-image-restore", "check-upstream-ux", "check-preflight", "check-storage", "smoke", "check-outbound-encoding", "check-restart", "check-wrapper", "check-e2e-mock",
];
for (const step of steps) {
  console.log("\n> " + step);
  // A hunt for a hung check must not become a silent CI hang: each step gets a
  // hard ceiling and the failure names the step that exceeded it.
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL(`./${step}.mjs`, import.meta.url)),
      ...(host ? ["--host-modules", modules] : [])], { stdio: "inherit", timeout: 20 * 60 * 1000, killSignal: "SIGKILL" });
  } catch (error) {
    if (error?.killed || error?.signal) throw new Error(step + " exceeded its 20 minute ceiling (signal " + (error.signal ?? "?") + ")");
    throw error;
  }
}
console.log(`\n${host ? "host" : "offline"} checks passed (${steps.length} scripts)`);
if (!host) console.log("Host integration and real DSH/model checks are not part of this run.");
