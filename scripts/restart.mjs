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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const explicitPort = process.env.BILI_PORT ?? process.argv[2];
const statePath = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "billion-context", "proxy-origin");
const initialInstance = (() => { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return {}; } })();
const discoveredPort = () => {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")).port;
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : undefined;
  } catch { return undefined; }
};
let port = Number(explicitPort ?? discoveredPort() ?? 18787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid bili port");
const pkg =
  process.env.BILI_PKG ??
  [join(homedir(), ".dsh", "profiles", "desktop", "plugins", "bili-context-patch", "vendor", "billion-context"),
   join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context")]
    .find(path => existsSync(join(path, "dist", "index.js")));
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
        res.on("aborted", () => done(null));
        res.on("error", () => done(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });

/** The proxy, or null when nothing is serving. A 503 "starting" also reads as down. */
const info = async () => {
  if (explicitPort === undefined) port = discoveredPort() ?? port;
  const answer = await call("GET", "/__bili/health");
  if (answer === null || answer.status !== 200) return null;
  try {
    const body = JSON.parse(answer.text);
    if (body === null || body.ok !== true || typeof body.instanceId !== "string" || !body.instanceId || !Number.isInteger(body.pid)) return null;
    return { pid: body.pid, instanceId: body.instanceId, version: body.version, parentPid: body.watchdog?.parentPid };
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
  const entry = pkg && join(pkg, "dist", "index.js");
  if (!entry || !existsSync(entry)) {
    console.error("cannot start: " + entry + " does not exist");
    process.exit(1);
  }
  console.log("nothing restarted it; starting it here");
  const child = spawn(process.execPath, [entry, "start", "--host", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env,
      BILI_LAUNCH_TOKEN: randomUUID(),
      ...(initialInstance.lane ? {BILI_LAUNCHER_LANE:initialInstance.lane} : {}),
      ...(before?.parentPid ? {BILI_PARENT_PID:String(before.parentPid)} : {}),
      ...(initialInstance.modelWindows ? {BILI_LAUNCHER_MODEL_WINDOWS:JSON.stringify(initialInstance.modelWindows)} : {}),
    },
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  current = await waitForReplacement(before, 40);
  if (!current || current.pid !== child.pid) {
    // This attempt is ours; never leave it behind if a supervisor won the race.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(done => child.once("exit", done));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
  }
  if (spawnError) console.error("start failed: " + spawnError.message);
  if (current && current.pid === child.pid) {
    child.unref();
    console.log("standalone proxy retained: pid " + child.pid + ", port " + port + "; stop via POST /__bili/shutdown");
  }
}

if (current === null) {
  console.error("no replacement proxy answered after the shutdown");
  process.exit(1);
}

console.log("now: " + describe(current));
