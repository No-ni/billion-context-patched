#!/usr/bin/env node
// Restart the local bili proxy so a freshly installed build is loaded.
//
// Everything here goes through the proxy's own HTTP endpoints, so it behaves the
// same on macOS, Linux and Windows — and it works when something else supervises
// the process (DSH does: it restarts bili a few seconds after a shutdown).
//
// Two things this file is careful about, both learned the hard way:
//
// 1. Success means a proxy answering /__bili/health with an instanceId that
//    differs from the one running before the shutdown. "Something answers on the
//    port" is not success: during a graceful exit the old process keeps answering,
//    and a script that believes it reports a restart that never happened.
// 2. Every probe closes its connection (agent: false, connection: close). The
//    proxy drains by waiting for live connections to finish, and a keep-alive
//    health poll counts as one - the old script held the very connection that
//    kept the shutdown from completing.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BILI_PORT ?? process.argv[2] ?? 18787);
const pkg =
  process.env.BILI_PKG ?? join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One request, one connection, closed afterwards. */
const call = (method, path) =>
  new Promise((done) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, agent: false, timeout: 3000, headers: { connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });

/** The proxy, or null when nothing is serving. A 503 "starting" also reads as down. */
const info = async () => {
  const answer = await call("GET", "/__bili/health");
  if (answer === null || answer.status !== 200) return null;
  try {
    const body = JSON.parse(answer.text);
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

const answer = await call("POST", "/__bili/shutdown");
if (answer === null) console.log("shutdown: no answer (it may have exited already)");
else console.log("shutdown: " + answer.status + " " + answer.text.trim());

// A graceful exit waits for live connections; the caller cares that it happened,
// not that it happened fast.
let current = await waitForReplacement(before, 120);

if (current === null) {
  // Before starting a second instance, make sure the old one is really gone: if
  // it still answers as itself, the port is taken and this is not our restart.
  const still = await info();
  if (same(before, still)) {
    console.error(
      "the proxy that was asked to stop (pid " + before.pid + ") is still serving after 60s; nothing was restarted",
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
  current = await waitForReplacement(before, 40);
}

if (current === null) {
  console.error("no replacement proxy answered after the shutdown");
  process.exit(1);
}

console.log("now: " + describe(current));
