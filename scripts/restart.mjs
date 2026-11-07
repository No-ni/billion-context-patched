#!/usr/bin/env node
// Restart the local bili proxy so a freshly installed build is loaded.
//
// Everything here goes through the proxy's own HTTP endpoints, so it behaves the
// same on macOS, Linux and Windows — and it works when something else supervises
// the process (DSH does: it restarts bili a few seconds after a shutdown).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BILI_PORT ?? process.argv[2] ?? 18787);
const pkg =
  process.env.BILI_PKG ?? join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context");
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const alive = async () => {
  try {
    const response = await fetch(`${base}/__bili/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok === true;
  } catch {
    return false;
  }
};

const waitFor = async (up, ticks) => {
  for (let i = 0; i < ticks; i += 1) {
    if ((await alive()) === up) return i;
    await sleep(500);
  }
  return -1;
};

console.log(`was: ${(await alive()) ? "up" : "down"}`);
try {
  await fetch(`${base}/__bili/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
} catch {}
await waitFor(false, 20);
console.log("shutdown sent");

if ((await waitFor(true, 24)) < 0) {
  const entry = join(pkg, "dist", "index.js");
  if (!existsSync(entry)) {
    console.error(`cannot start: ${entry} does not exist`);
    process.exit(1);
  }
  console.log("nothing restarted it; starting it here");
  const child = spawn(
    process.execPath,
    [entry, "start", "--host", "127.0.0.1", "--port", String(port)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  if ((await waitFor(true, 30)) < 0) {
    console.error("health still down after starting it");
    process.exit(1);
  }
}

console.log(`health: ${(await alive()) ? "up" : "down"}`);
