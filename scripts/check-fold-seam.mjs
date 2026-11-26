#!/usr/bin/env node
// Fold-seam E2E: a real candidate proxy in front of a loopback mock gateway,
// driven the way the desktop client drives it — every turn re-sends the whole
// transcript and the proxy projects it. No installed plugin, no user profile,
// no real model.
//
//   node scripts/check-fold-seam.mjs                     # candidate must hold the seam
//   node scripts/check-fold-seam.mjs --expect regressed  # older build must reproduce it
//   node scripts/check-fold-seam.mjs --bili <pkg|dist> --tail-tokens 200 --keep
//
// The scenario lets one over-window turn fold the history for real, freezes the
// state the desktop incident persisted (tail_json keeps two rows, tailFolded is
// true), restarts the proxy, and drives the next turns. A build with the 0.8.1
// anchoring bug logs block-unanchored / legacy fallback there; a working build
// keeps sending the folded view.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startGateway } from "./fixtures/e2e-mock/gateway.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const argv = process.argv.slice(2);
let bili = join(repo, "vendor/billion-context"), expect = "folded", tailTokens = "200", keep = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--bili" && argv[i + 1]) bili = resolve(argv[++i]);
  else if (argv[i] === "--expect" && argv[i + 1]) expect = argv[++i];
  else if (argv[i] === "--tail-tokens" && argv[i + 1]) tailTokens = argv[++i];
  else if (argv[i] === "--keep") keep = true;
  else if (argv[i] === "--help") { console.log("usage: node scripts/check-fold-seam.mjs [--bili <package|dist/index.js>] [--expect folded|regressed] [--tail-tokens <n>] [--keep]"); process.exit(0); }
  else throw new Error("unknown argument: " + argv[i]);
}
assert(expect === "folded" || expect === "regressed", "--expect must be folded or regressed");
const entry = bili.endsWith(".js") ? bili : join(bili, "dist/index.js");
assert(existsSync(entry), "candidate not found: " + entry);

const root = mkdtempSync(join(tmpdir(), "bili-fold-seam-"));
const home = join(root, "home"), state = join(root, "state"), cache = join(root, "cache"), configHome = join(root, "config"), data = join(root, "data"), temporary = join(root, "tmp"), sessions = join(data, "billion-context/sessions");
for (const dir of [home, state, cache, configHome, data, temporary, sessions, join(cache, "billion-context"), join(state, "billion-context")]) mkdirSync(dir, { recursive: true });
const configFile = join(configHome, "billion-context.json"), egressLog = join(root, "blocked-egress.log");
const proxyLogPath = join(state, "billion-context/bili.log");
const proxyLog = () => existsSync(proxyLogPath) ? readFileSync(proxyLogPath, "utf8") : "";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BILI_|BILLION_CONTEXT_|ACP_|DSH_|CODEX_|OPENAI_|ANTHROPIC_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|PORT$|HOME$|USERPROFILE$|XDG_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  BILI_CONFIG_FILE: configFile, BILI_SESSIONS_DIR: sessions, BILI_E2E_EGRESS_LOG: egressLog, BILI_PERSIST_TAIL_TOKENS: tailTokens,
  BILI_STORAGE_UNIFIED: "full", BILI_STORAGE_JSON_WRITER: "off", BILI_SQLITE_AUTO_DOWNLOAD: "0",
  ACP_AUTO_UPDATE: "0", BILI_ADVISORY_CHECK: "0", BILI_RELEASE_NOTES_CHECK: "0", BILI_MITM: "0", BILI_SESSION_GC: "0",
  BILI_PLUGIN_SNAPSHOT: "1", BILI_UPSTREAM_TIMEOUT_MS: "5000", BILI_UPSTREAM_FIRST_BYTE_MS: "5000", NO_PROXY: "*" });
writeFileSync(join(cache, "billion-context/models-dev.json"), JSON.stringify({ models: { "openai/mock-model": 1000000 }, costs: { "openai/mock-model": { input: 1, output: 1 } } }));

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (port, path, body, headers = {}, method = body === undefined ? "GET" : "POST") => new Promise((resolve, reject) => {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = request({ hostname: "127.0.0.1", port, path, method, agent: false, timeout: 12000, headers: { connection: "close", ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}), ...headers } }, res => {
    const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject); res.once("aborted", () => reject(new Error("response aborted: " + path)));
    res.once("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; } resolve({ status: res.statusCode, headers: res.headers, body: parsed, text }); });
  });
  req.once("timeout", () => req.destroy(new Error("request timed out: " + path))); req.once("error", reject); req.end(bytes);
});
async function eventually(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await pause(50); }
  throw new Error("timed out: " + label + (last ? " (" + last.message + ")" : ""));
}
async function reservePort() { const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }

const gateway = await startGateway();
const configuration = { upstream: gateway.origin, upstreamProxyMode: "direct", autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false, remoteAnnouncementsUrl: gateway.origin + "/announcements", mitm: { enabled: false }, modelContextLimit: 4000,
  storage: { unified: "full", jsonWriter: "off", sqliteAutoDownload: false },
  rollout: { installId: "fold-seam-install", features: { snapshotRender: true, snapshotRenderShadow: false, pluginLaneServerHistory: true } },
  compress: { preserveRecentMessages: 2, preserveRecentTokens: 0, minCompressRangeChars: 1, minSummaryLength: 1, maxSummaryLength: 2000, requireNudge: false, requireRecommendation: false },
  providers: { [gateway.origin]: { models: { "mock-model": { context: 4000, output: 512 } }, calibration: { disabled: true } } } };
writeFileSync(configFile, JSON.stringify(configuration, null, 2));

const guard = pathToFileURL(join(repo, "scripts/fixtures/e2e-mock/loopback-guard.mjs")).href;
let proxy;
async function startProxy() {
  const port = await reservePort();
  const child = spawn(process.execPath, ["--import", guard, entry, "start", "--host", "127.0.0.1", "--port", String(port), "--config", configFile, "--no-auto-update"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, port, stdout: "", stderr: "", exit: null };
  child.stdout.on("data", chunk => { run.stdout = (run.stdout + chunk).slice(-40000); });
  child.stderr.on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-40000); });
  run.exited = new Promise(resolve => { child.once("error", error => { run.exit = { code: null, error: error.message }; resolve(run.exit); }); child.once("exit", (code, signal) => { run.exit = { code, signal }; resolve(run.exit); }); });
  try {
    await eventually(async () => {
      if (run.exit) throw new Error("candidate exited (" + JSON.stringify(run.exit) + "): " + run.stderr.slice(-6000));
      const result = await json(port, "/__bili/health");
      return result.status === 200 && result.body.ok === true && result.body.pid === child.pid;
    }, "candidate proxy ready");
  } catch (error) { child.kill("SIGKILL"); throw new Error(error.message + "\n" + run.stderr.slice(-6000)); }
  return run;
}
async function stopProxy(run) {
  if (!run || run.exit) return;
  try { await json(run.port, "/__bili/shutdown", {}); } catch { /* the kill path below owns this child */ }
  const timer = setTimeout(() => run.child.kill("SIGTERM"), 8000);
  await Promise.race([run.exited, pause(9000)]);
  clearTimeout(timer);
  if (!run.exit) { run.child.kill("SIGKILL"); await run.exited; }
}
const headers = cid => ({ "x-bili-plugin": "fold-seam-e2e", "x-bili-plugin-conversation": cid, "x-bili-plugin-agent": "main", "x-bili-plugin-model": "mock-model", "x-bili-plugin-context-window": "4000", "x-accel-compress": "off", "x-accel-rid": randomUUID() });
const chat = (cid, messages) => json(proxy.port, "/bili/" + gateway.origin + "/v1/chat/completions", { model: "mock-model", max_tokens: 4096, stream: false, messages }, headers(cid));
const snapshot = async cid => { const result = await json(proxy.port, "/__bili/plugin/snapshot?conversationId=" + encodeURIComponent(cid)); assert.equal(result.status, 200, result.text); assert.equal(result.body.ok, true, result.text); return result.body; };
const detail = async id => { const result = await json(proxy.port, "/__bili/sessions/" + encodeURIComponent(id) + "/detail"); assert.equal(result.status, 200, result.text); return result.body; };
const compressTool = (cid, content) => json(proxy.port, "/__bili/plugin/tool", { conversationId: cid, tool: "compress", args: { content }, nativeCaller: true, toolCallId: "fold_seam_compress_" + randomUUID() });

const BODY = "foldable local history body. ";
const marker = "FOLD_SEAM_MARKER: ";
const history = [];
for (let i = 0; i < 16; i++) history.push({ role: i % 2 === 0 ? "user" : "assistant", content: marker + i + ": " + BODY.repeat(80) });
const firstTurn = [...history, { role: "user", content: marker + "FINAL: acknowledge the completed history." }];
let inspectSeen = 0;
const inspectTail = id => {
  // The live store runs in WAL mode: a bare index.db copy loses the newest
  // commits, so copy the sidecars with it.
  const target = join(root, "inspect-" + (++inspectSeen));
  mkdirSync(target, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = join(sessions, "index.db" + suffix);
    if (existsSync(source)) copyFileSync(source, join(target, "index.db" + suffix));
  }
  const database = new DatabaseSync(join(target, "index.db"));
  try {
    const row = database.prepare("select tail_json from sessions where session_id = ?").get(id);
    const live = database.prepare("select count(*) as n from messages where session_id = ? and retired_at is null").get(id);
    const parsed = row ? JSON.parse(row.tail_json ?? "{}") : {};
    return { tailSeqs: (parsed.tailSeqs ?? []).length, tailFolded: parsed.tailFolded === true, live: live?.n ?? 0 };
  } finally { database.close(); }
};
const injectTrimmedTail = id => {
  const database = new DatabaseSync(join(sessions, "index.db"));
  try {
    const seqs = database.prepare("select seq from messages where session_id = ? and retired_at is null order by seq desc limit 2").all(id).map(row => row.seq).reverse();
    database.prepare("update sessions set tail_json = ? where session_id = ?").run(JSON.stringify({ tailSeqs: seqs, tailFolded: true, pluginSnapshotSeqs: [] }), id);
  } finally { database.close(); }
};
const repeats = text => (text.match(/foldable local history body/g) ?? []).length;
const forwarded = () => gateway.http.filter(record => record.path === "/v1/chat/completions");

const evidence = {};
try {
  proxy = await startProxy();
  const first = await chat("fold-seam", firstTurn);
  assert.equal(first.status, 200, first.text);
  assert(forwarded().at(-1).decoded.toString("utf8").includes(marker), "the first turn must carry the whole transcript");

  const after = await snapshot("fold-seam");
  const activeBlocks = (await detail(after.sessionId)).blockDetails.filter(block => block.active);
  assert(activeBlocks.length >= 1, "the turn must fold the over-window history into an active block");
  await eventually(() => inspectTail(after.sessionId, "fold-seam").live > 0, "session persisted");

  // Freeze the shape the desktop incident persisted: the block spans the
  // history, but the resident tail pointer only keeps the newest two rows.
  await stopProxy(proxy);
  injectTrimmedTail(after.sessionId);
  proxy = await startProxy();
  const injected = inspectTail(after.sessionId);
  evidence.tailSeqs = injected.tailSeqs;
  evidence.tailFolded = injected.tailFolded;
  evidence.liveMessages = injected.live;
  assert(evidence.tailFolded === true && evidence.tailSeqs * 2 < evidence.liveMessages, "the injected state must be a trimmed tail: " + JSON.stringify(evidence));

  const turnTwo = [...firstTurn, { role: "assistant", content: "MOCK_REPLY_1" }, { role: "user", content: marker + "SECOND_TURN: continue the same task." }];
  const second = await chat("fold-seam", turnTwo);
  assert.equal(second.status, 200, second.text);
  const wireTwo = forwarded().at(-1).decoded.toString("utf8");
  evidence.turn2IncomingBytes = Buffer.byteLength(JSON.stringify(turnTwo));
  evidence.turn2ForwardedBytes = Buffer.byteLength(wireTwo);
  evidence.turn2HistoryRepeats = repeats(wireTwo);
  evidence.turn2HasSummary = wireTwo.includes("condensed history chunk");

  await stopProxy(proxy);
  proxy = await startProxy();
  const turnThree = [...turnTwo, { role: "assistant", content: "MOCK_REPLY_2" }, { role: "user", content: marker + "THIRD_TURN: after the restart." }];
  const third = await chat("fold-seam", turnThree);
  assert.equal(third.status, 200, third.text);
  const wireThree = forwarded().at(-1).decoded.toString("utf8");
  evidence.turn3IncomingBytes = Buffer.byteLength(JSON.stringify(turnThree));
  evidence.turn3ForwardedBytes = Buffer.byteLength(wireThree);
  evidence.turn3HistoryRepeats = repeats(wireThree);
  evidence.turn3HasSummary = wireThree.includes("condensed history chunk");

  const log = proxyLog();
  evidence.blockUnanchored = (log.match(/block-unanchored/g) ?? []).length;
  evidence.legacyFallback = (log.match(/legacy fallback/g) ?? []).length;

  // preserveRecentMessages keeps the newest long messages on the wire; one raw
  // history message is 80 repeats, the whole unfolded transcript is 960.
  const held = wireTwo.includes("condensed history chunk") && repeats(wireTwo) <= 200 && evidence.turn2ForwardedBytes < evidence.turn2IncomingBytes * 0.85;
  const heldAfterRestart = wireThree.includes("condensed history chunk") && repeats(wireThree) <= 200;
  const clean = evidence.legacyFallback === 0 && evidence.blockUnanchored === 0;

  console.log("fold-seam evidence: " + JSON.stringify(evidence, null, 2));
  if (expect === "folded") {
    assert(held, "turn two must stay folded: forwarded=" + evidence.turn2ForwardedBytes + " B of " + evidence.turn2IncomingBytes + " B, repeats=" + evidence.turn2HistoryRepeats);
    assert(heldAfterRestart, "turn three after a restart must stay folded: forwarded=" + evidence.turn3ForwardedBytes + " B, repeats=" + evidence.turn3HistoryRepeats);
    assert(clean, "no block-unanchored/legacy fallback may appear: " + JSON.stringify(evidence));
    console.log("\nOK fold seam held: turn two " + evidence.turn2ForwardedBytes + " B of " + evidence.turn2IncomingBytes + " B (" + evidence.turn2HistoryRepeats + " raw history repeats), after restart " + evidence.turn3ForwardedBytes + " B; 0 fallbacks");
  } else {
    assert(!held || !clean, "the older build must reproduce the seam: " + JSON.stringify(evidence));
    console.log("\nREGRESSION reproduced: turn two forwarded " + evidence.turn2ForwardedBytes + " B with " + evidence.turn2HistoryRepeats + " raw repeats; block-unanchored=" + evidence.blockUnanchored + ", legacy fallback=" + evidence.legacyFallback);
  }
} finally {
  if (proxy) await stopProxy(proxy);
  await gateway.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log("kept: " + root);
}