#!/usr/bin/env node
// Restart the local bili proxy so a freshly installed build is loaded.
//
// Everything here goes through the proxy's own HTTP endpoints, so it behaves the
// same on macOS, Linux and Windows — and it works when something else supervises
// the process (DSH does: it restarts bili a few seconds after a shutdown).
//
// Success means exactly one thing: a proxy answering /__bili/health with an
// instanceId that differs from the one running before the shutdown. "Something
// answers on the port" is not success. A graceful exit keeps the old process
// answering for a second or two, and a script that trusts that reports a restart
// that never happened - leaving the caller with a dead proxy once the old
// process finally leaves.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BILI_PORT ?? process.argv[2] ?? 18787);
const pkg =
  process.env.BILI_PKG ?? join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context");
const base = "http://127.0.0.1:" + port;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The proxy, or null when nothing is serving. A 503 "starting" also reads as down. */
const info = async () => {
  try {
    const response = await fetch(base + "/__bili/health", { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = await response.json();
    if (body === null || body.ok !== true) return null;
    return { pid: body.pid, instanceId: body.instanceId, version: body.version };
  } catch {
    return null;
  }
};

const describe = (value) =>
  value === null
    ? "down"
    : "up (pid " + value.pid + ", instance " + String(value.instanceId ?? "?").slice(0, 12) + ", v" + value.version + ")";

/** Same process, not a replacement: the identity the old proxy answered with. */
const same = (before, current) =>
  Boolean(before && current && before.instanceId && current.instanceId && before.instanceId === current.instanceId);

/** Wait until a proxy answers that is NOT the one we asked to stop. */
const waitForReplacement = async (before, ticks) => {
  for (let index = 0; index < ticks; index += 1) {
    const current = await info();
    if (current !== null && !same(before, current)) return current;
    await sleep(500);
  }
  return null;
};

const before = await info();
console.log("was: " + describe(before));

try {
  await fetch(base + "/__bili/shutdown", { method: "POST", signal: AbortSignal.timeout(2000) });
} catch {}
console.log("shutdown sent");

let current = await waitForReplacement(before, 24);

if (current === null) {
  // Before starting a second instance, make sure the old one is really gone: if
  // it still answers as itself, the port is taken and this is not our restart.
  const still = await info();
  if (same(before, still)) {
    console.error(
      "the proxy that was asked to stop (pid " + before.pid + ") is still serving; nothing was restarted",
    );
    process.exit(1);
  }
  const entry = join(pkg, "dist", "index.js");
  if (!existsSync(entry)) {
    console.error("cannot start: " + entry + " does not exist");
    process.exit(1);
  }
  console.log("nothing restarted it; starting it here");
  const child = spawn(process.execPath, [entry, "start", "--host", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  current = await waitForReplacement(before, 30);
}

if (current === null) {
  console.error("no replacement proxy answered after the shutdown");
  process.exit(1);
}

console.log("now: " + describe(current));
