#!/usr/bin/env node
// Install this build over an existing billion-context installation.
//
// Runs the same way on macOS, Linux and Windows: no shell, no lsof, no cp.
import { copyFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(
  process.argv[2] ??
    process.env.BILI_PKG ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context"),
);

if (!existsSync(join(target, "package.json")) || !existsSync(join(target, "dist"))) {
  console.error(`no billion-context installation at ${target}`);
  process.exit(1);
}

const withStamp = (date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");

const backup = join(target, "dist", `index.js.bak-${withStamp(new Date())}`);
copyFileSync(join(target, "dist", "index.js"), backup);
copyFileSync(join(here, "..", "dist", "index.js"), join(target, "dist", "index.js"));

// The package ships index.js as an executable script; keep that bit set on POSIX.
// On Windows chmod is a no-op, which is exactly right.
try {
  chmodSync(join(target, "dist", "index.js"), 0o755);
} catch {}

console.log(`installed into ${target}`);
console.log(`backup: ${backup}`);
console.log("restart to activate: node scripts/restart.mjs");
