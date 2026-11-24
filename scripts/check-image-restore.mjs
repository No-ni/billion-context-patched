#!/usr/bin/env node
// IMG-12: the host-offload restore cache and its limits, judged on the block the
// shipped build carries. check-image-card covers the switch in the settings
// card; this check drives the actual cache the proxy uses at run time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");
const source = readFileSync(dist, "latin1");
const BEGIN = "// <bili-image-restore>", END = "// </bili-image-restore>";
const start = source.indexOf(BEGIN), end = source.indexOf(END);
assert(start >= 0 && end > start, "the build must carry the image-restore block");
const cut = source.indexOf("function __biliRestoreStringContent", start);
assert(cut > start, "the restore block lost its cache section");
const code = source.slice(start, cut) + "\n({__biliImageRestoreCache,__biliRememberRestorePart,__biliImageRestoreCaches,__biliRestoreCacheBytes,__biliImageRestoreEnabled,__BILI_IMAGE_RESTORE_PARTS,__BILI_IMAGE_RESTORE_BYTES,__BILI_IMAGE_RESTORE_SESSIONS,__BILI_IMAGE_RESTORE_TOTAL_BYTES});";

const load = env => runInNewContext(code, { process: { env }, loadConfigFile: () => ({}), Map, JSON });
const api = load({});
const MiB = 1024 * 1024;
// The numbers are the SPEC contract, not an implementation detail: 96 parts,
// 64 MiB per session, 64 sessions, 256 MiB overall.
assert.equal(api.__BILI_IMAGE_RESTORE_PARTS, 96);
assert.equal(api.__BILI_IMAGE_RESTORE_BYTES, 64 * MiB);
assert.equal(api.__BILI_IMAGE_RESTORE_SESSIONS, 64);
assert.equal(api.__BILI_IMAGE_RESTORE_TOTAL_BYTES, 256 * MiB);
const image = bytes => ({ url: "data:image/png;base64," + "A".repeat(Math.max(0, bytes - 32)) });

// 1. Part count: 120 distinct images in one session keep exactly the newest 96.
const parts = api.__biliImageRestoreCache("parts-budget");
for (let i = 0; i < 120; i++) api.__biliRememberRestorePart(parts, "k" + i, "h" + i, image(64), ["h" + i]);
assert.equal(parts.parts.size, 96, "the cache must keep exactly 96 parts");
assert.equal(parts.order.length, 96, "the eviction order must match the kept parts");
assert(!parts.parts.has("k0") && parts.parts.has("k119"), "eviction must drop the oldest parts first");

// 2. Byte budget: images that alone exceed 64 MiB keep the session under it.
const bytes = api.__biliImageRestoreCache("bytes-budget");
for (let i = 0; i < 80; i++) api.__biliRememberRestorePart(bytes, "b" + i, "h" + i, image(MiB), ["h" + i]);
assert(bytes.bytes <= 64 * MiB, "one session must stay under 64 MiB: " + bytes.bytes);
assert(bytes.parts.size > 0 && bytes.parts.size < 80, "the byte budget must evict instead of refusing the newest image");

// 3. Session budget: the 65th session evicts the least recently used one.
for (let i = 0; i < 70; i++) { const cache = api.__biliImageRestoreCache("session-" + i); api.__biliRememberRestorePart(cache, "s", "h", image(64), ["h"]); }
const caches = api.__biliImageRestoreCaches;
assert.equal(caches.size, 64, "the cache must keep exactly 64 sessions");
assert(!caches.has("session-0") && caches.has("session-69"), "the oldest session must go first");

// 4. Global budget: sessions are dropped until the 256 MiB total is back under it.
for (let i = 0; i < 70; i++) { const cache = api.__biliImageRestoreCache("global-" + i); api.__biliRememberRestorePart(cache, "g", "h", image(4 * MiB), ["h"]); }
assert(api.__biliRestoreCacheBytes() <= 256 * MiB, "the global budget must hold: " + api.__biliRestoreCacheBytes());
assert(caches.size < 70, "the global trim must drop whole sessions");

// 5. The switch: explicit env wins over the config file, default stays on.
assert.equal(api.__biliImageRestoreEnabled(), true, "IMG-12 is on by default");
for (const off of ["0", "false", "off"]) assert.equal(load({ BILI_IMAGE_RESTORE: off }).__biliImageRestoreEnabled(), false, "BILI_IMAGE_RESTORE=?" + off);
assert.equal(load({ BILI_IMAGE_RESTORE: "1" }).__biliImageRestoreEnabled(), true, "an explicit on must win");
console.log("image restore checks passed: 96 parts / 64 MiB per session / 64 sessions / 256 MiB overall, switch defaults on");
