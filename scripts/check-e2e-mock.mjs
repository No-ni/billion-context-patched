#!/usr/bin/env node
// Real candidate proxy process + localhost model gateway. Run independently:
//   node scripts/check-e2e-mock.mjs [--bili <package directory|dist/index.js>]
// It never installs/restarts a user plugin and makes no external model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { request, createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { startGateway } from "./fixtures/e2e-mock/gateway.mjs";
import { LocalWebSocket } from "./fixtures/e2e-mock/websocket.mjs";
import { seedLegacyState, database, readKv, assertLegacyUnchanged } from "./fixtures/e2e-mock/storage.mjs";
import { imageUrl, historicalImageMessages } from "./fixtures/e2e-mock/images.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2);
let bili = join(repo, "vendor/billion-context");
let nativeOnly = false;
let storageOnly = false;
for (let i = 0; i < arguments_.length; i++) {
  if (arguments_[i] === "--bili" && arguments_[i + 1]) bili = resolve(arguments_[++i]);
  else if (arguments_[i] === "--native-only") nativeOnly = true;
  else if (arguments_[i] === "--storage-only") storageOnly = true;
  else if (arguments_[i] === "--help") { console.log("Usage: node scripts/check-e2e-mock.mjs [--bili <package directory|dist/index.js>] [--native-only|--storage-only]"); process.exit(0); }
  else throw new Error("unknown argument: " + arguments_[i]);
}
assert(!(nativeOnly && storageOnly), "choose at most one E2E subset");
const entry = statSync(bili).isDirectory() ? join(bili, "dist/index.js") : bili;
const pkg = dirname(dirname(entry));
const candidate = readFileSync(entry, "utf8");
const candidateHash = createHash("sha256").update(candidate).digest("hex");
const nativeEntry = join(pkg, "dist/agent/dsh-native.js");
const nativeCandidate = existsSync(nativeEntry) ? readFileSync(nativeEntry, "utf8") : "";
const nativeHash = nativeCandidate ? createHash("sha256").update(nativeCandidate).digest("hex") : undefined;
const hasKvMigration = candidate.includes("hydratePluginConversationsUnified") && candidate.includes("hydrateAffinityUnified") && candidate.includes("hydrateOrderUnified");
const hasBlockLifecycle = candidate.includes("acp_retire") && candidate.includes("acp_restore") && candidate.includes("acp_rewrite");
const root = mkdtempSync(join(tmpdir(), "bili-e2e-mock-"));
const home = join(root, "home"), state = join(root, "state"), cache = join(root, "cache"), configHome = join(root, "config"), data = join(root, "data"), temporary = join(root, "tmp"), sessions = join(data, "billion-context/sessions");
for (const dir of [home, state, cache, configHome, data, temporary, sessions, join(home, ".local/state/billion-context"), join(cache, "billion-context"), join(state, "billion-context")]) mkdirSync(dir, { recursive: true });
const configFile = join(configHome, "billion-context.json"), egressLog = join(root, "blocked-egress.log"), sqliteFault = join(root, "sqlite-read-fault.json");
const privateLog = join(state, "billion-context/bili.log");
const proxyLog = () => existsSync(privateLog) ? readFileSync(privateLog, "utf8") : "";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BILI_|BILLION_CONTEXT_|ACP_|DSH_|CODEX_|OPENAI_|ANTHROPIC_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|PORT$|HOME$|USERPROFILE$|XDG_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), DSH_HOME: join(home, ".dsh"), BILI_CONFIG_FILE: configFile, BILI_SESSIONS_DIR: sessions, BILI_E2E_EGRESS_LOG: egressLog, BILI_E2E_SQLITE_FAULT_FILE: sqliteFault,
  BILI_STORAGE_UNIFIED: "full", BILI_STORAGE_JSON_WRITER: "off", BILI_SQLITE_AUTO_DOWNLOAD: "0", ACP_AUTO_UPDATE: "0", BILI_ADVISORY_CHECK: "0", BILI_RELEASE_NOTES_CHECK: "0", BILI_MITM: "0", BILI_SESSION_GC: "0", BILI_PLUGIN_SNAPSHOT: "1", BILI_SUBAGENT_SPLIT: "0", BILI_PERSONA_SPLIT: "0", BILI_AFFINITY_SIMHASH: "0", BILI_UPSTREAM_TIMEOUT_MS: "5000", BILI_UPSTREAM_FIRST_BYTE_MS: "5000", BILI_REPLAY_RETRY_MAX: "3", NO_PROXY: "*" });
// A fresh real cache avoids the candidate's hardcoded models.dev bootstrap.
writeFileSync(join(cache, "billion-context/models-dev.json"), JSON.stringify({ models: { "openai/mock-model": 1000000 }, costs: { "openai/mock-model": { input: 1, output: 1 } } }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (port, path, body, headers = {}, method = body === undefined ? "GET" : "POST") => new Promise((resolve, reject) => {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = request({ hostname: "127.0.0.1", port, path, method, agent: false, timeout: 12000, headers: { connection: "close", ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}), ...headers } }, res => {
    const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject); res.once("aborted", () => reject(new Error("response aborted: " + path)));
    res.once("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode, headers: res.headers, body, text }); });
  });
  req.once("timeout", () => req.destroy(new Error("request timed out: " + path))); req.once("error", reject); req.end(bytes);
});
async function eventually(fn, label, timeout = 10000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await pause(40); }
  throw new Error(`timed out: ${label}${last ? " (" + last.message + ")" : ""}`);
}
async function reservePort() { const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
const processes = new Set(), auxiliary = new Set(), clients = new Set(), checks = [], skipped = [];
const skip = (name, reason) => { skipped.push({ name, reason }); console.log(`  SKIP ${name}: ${reason}`); };
const legacy = seedLegacyState(state);
let gateway, active, baseConfiguration;
const mainContext = { root, env, configFile, sessions, state, privateLog, legacy };
async function startProxy(context = mainContext) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(repo, "scripts/fixtures/e2e-mock/loopback-guard.mjs")).href, entry, "start", "--host", "127.0.0.1", "--port", String(port), "--config", context.configFile, "--no-auto-update"], { cwd: context.root, env: context.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, port, context, stdout: "", stderr: "", exit: null, spawnedAt: Date.now() }; processes.add(run);
  child.stdout.on("data", chunk => { run.stdout = (run.stdout + chunk).slice(-80000); }); child.stderr.on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-80000); });
  run.exited = new Promise(resolve => {
    child.once("error", error => { run.error = error; run.exit = { code: null, signal: null, error: error.message }; resolve(run.exit); });
    child.once("exit", (code, signal) => { run.exit = { code, signal }; resolve(run.exit); });
  });
  try { run.health = await eventually(async () => { if (run.error) throw run.error; if (run.exit) throw new Error(`candidate exited (${JSON.stringify(run.exit)}): ${run.stderr.slice(-12000)}`); const result = await json(port, "/__bili/health"); return result.status === 200 && result.body.ok === true && result.body.pid === child.pid && result.body.instanceId ? result.body : false; }, "candidate proxy ready"); }
  catch (error) { await stopProxy(run); throw new Error(error.message + "\n" + run.stderr.slice(-12000)); }
  active = run; return run;
}
async function stopProxy(run, requireClean = false) {
  if (!run) return;
  if (run.exit) { if (active === run) active = undefined; if (requireClean) assert.equal(run.exit.code, 0, "candidate exited before its graceful shutdown"); return; }
  try { const result = await json(run.port, "/__bili/shutdown", {}); assert.equal(result.status, 202); } catch { /* finally still owns this exact child */ }
  let timer; const timed = new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); });
  const clean = await Promise.race([run.exited.then(() => true), timed]); clearTimeout(timer);
  if (!clean && !run.exit) { run.child.kill("SIGTERM"); await Promise.race([run.exited, pause(3000)]); }
  if (!run.exit) { run.child.kill("SIGKILL"); await run.exited; }
  assert(run.exit, "candidate process must exit");
  if (active === run) active = undefined;
  if (requireClean) { assert(clean, "candidate did not complete graceful shutdown in eight seconds"); assert.equal(run.exit.code, 0, "candidate exited unsuccessfully"); }
}
async function stopAuxiliary(run) {
  if (run.exit) return;
  run.child.kill("SIGTERM"); await Promise.race([run.exited, pause(3000)]);
  if (!run.exit) { run.child.kill("SIGKILL"); await run.exited; }
}
async function nativeFixture(options) {
  const input = join(root, "native-ws-input.json"); writeFileSync(input, JSON.stringify(options));
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(repo, "scripts/fixtures/e2e-mock/loopback-guard.mjs")).href, join(repo, "scripts/fixtures/e2e-mock/native-ws.mjs"), nativeEntry, input], { cwd: root, env: { ...env, NODE_TEST_CONTEXT: "isolated-local-e2e" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, stdout: "", stderr: "", exit: null }; auxiliary.add(run);
  child.stdout.on("data", chunk => { run.stdout = (run.stdout + chunk).slice(-40000); }); child.stderr.on("data", chunk => { run.stderr = (run.stderr + chunk).slice(-40000); });
  run.exited = new Promise(resolve => {
    child.once("error", error => { run.exit = { code: null, signal: null, error: error.message }; run.stderr += error.message; resolve(run.exit); });
    child.once("exit", (code, signal) => { run.exit = { code, signal }; resolve(run.exit); });
  });
  let timer;
  try {
    await Promise.race([run.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("isolated native WS fixture timed out")), 30000); })]);
    assert.equal(run.exit.code, 0, run.stderr + "\n" + run.stdout);
    const line = run.stdout.split(/\r?\n/).find(line => line.startsWith("NATIVE_WS_E2E ")); assert(line, "native fixture did not return its evidence: " + run.stdout);
    return JSON.parse(line.slice("NATIVE_WS_E2E ".length));
  } finally { clearTimeout(timer); await stopAuxiliary(run); }
}
const check = async (name, fn) => { await fn(); checks.push(name); console.log("  OK " + name); };
const pluginHeaders = cid => ({ "x-bili-plugin": "mock-e2e", "x-bili-plugin-conversation": cid, "x-bili-plugin-agent": "main", "x-bili-plugin-model": "mock-model", "x-bili-plugin-context-window": "1000000" });
const chat = (cid, messages, encoding = "off", rid = randomUUID(), options = {}) => json(active.port, `/bili/${gateway.origin}${options.path ?? "/v1/chat/completions"}`, { model: options.model ?? "mock-model", max_tokens: options.maxTokens ?? 4096, stream: options.stream ?? false, messages }, { ...pluginHeaders(cid), ...(options.proxyMode ? { "x-bili-plugin-compression": "proxy" } : {}), "x-accel-compress": encoding, "x-accel-rid": rid, ...options.headers });
const tool = (cid, name, args, extra = {}) => json(active.port, "/__bili/plugin/tool", { conversationId: cid, tool: name, args, nativeCaller: true, ...extra });
const snapshot = async cid => { const result = await json(active.port, "/__bili/plugin/snapshot?conversationId=" + encodeURIComponent(cid)); assert.equal(result.status, 200, result.text); assert.equal(result.body.ok, true); return result.body; };
const detail = async id => { const result = await json(active.port, "/__bili/sessions/" + encodeURIComponent(id) + "/detail"); assert.equal(result.status, 200, result.text); return result.body; };
const modelError = result => typeof result.body.error === "object" ? result.body.error : { ...result.body, message: result.body.message ?? result.body.error };
const wsBody = (messages, model = "mock-model") => ({ type: "response.create", model, stream: true, max_output_tokens: 4096, instructions: "You are the isolated local E2E mock assistant.", input: messages.map(m => ({ type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] })) });
const lifecycleTools = ["acp_retire", "acp_restore", "acp_rewrite"];
async function manifestToolNames() {
  const result = await json(active.port, "/__bili/plugin/manifest"); assert.equal(result.status, 200, result.text);
  assert(Array.isArray(result.body.tools?.openai), "the real manifest must provide its OpenAI tool list: " + result.text);
  return result.body.tools.openai.map(t => t.function?.name);
}
async function applyConfiguration(configuration, context = active.context) {
  const pending = context.configFile + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(pending, JSON.stringify(configuration, null, 2));
    for (let attempt = 0; ; attempt++) {
      try { renameSync(pending, context.configFile); break; }
      catch (error) { if (attempt >= 49 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error; await pause(40); }
    }
  }
  finally { rmSync(pending, { force: true }); }
  const reloaded = await json(active.port, "/__bili/config/reload", {}); assert.equal(reloaded.status, 200, reloaded.text); assert.equal(reloaded.body.ok, true);
}
function isolatedContext(name, mode, jsonWriter = "on") {
  const nested = join(root, name), nestedHome = join(nested, "home"), nestedState = join(nested, "state"), nestedCache = join(nested, "cache"), nestedConfig = join(nested, "config"), nestedData = join(nested, "data"), nestedTemporary = join(nested, "tmp"), nestedSessions = join(nestedData, "billion-context/sessions");
  for (const path of [nestedHome, nestedState, nestedCache, nestedConfig, nestedData, nestedTemporary, nestedSessions, join(nestedState, "billion-context"), join(nestedCache, "billion-context")]) mkdirSync(path, { recursive: true });
  const nestedEnv = { ...env, HOME: nestedHome, USERPROFILE: nestedHome, APPDATA: join(nestedHome, "AppData/Roaming"), LOCALAPPDATA: join(nestedHome, "AppData/Local"), XDG_CONFIG_HOME: nestedConfig, XDG_STATE_HOME: nestedState, XDG_CACHE_HOME: nestedCache, XDG_DATA_HOME: nestedData,
    TEMP: nestedTemporary, TMP: nestedTemporary, TMPDIR: nestedTemporary, CODEX_HOME: join(nestedHome, ".codex"), CLAUDE_CONFIG_DIR: join(nestedHome, ".claude"), DSH_HOME: join(nestedHome, ".dsh"), BILI_CONFIG_FILE: join(nestedConfig, "billion-context.json"), BILI_SESSIONS_DIR: nestedSessions };
  delete nestedEnv.BILI_STORAGE_UNIFIED; delete nestedEnv.BILI_STORAGE_JSON_WRITER;
  const configuration = { ...baseConfiguration, storage: { unified: mode, jsonWriter, sqliteAutoDownload: false } };
  writeFileSync(nestedEnv.BILI_CONFIG_FILE, JSON.stringify(configuration, null, 2));
  copyFileSync(join(cache, "billion-context/models-dev.json"), join(nestedCache, "billion-context/models-dev.json"));
  return { root: nested, env: nestedEnv, configFile: nestedEnv.BILI_CONFIG_FILE, sessions: nestedSessions, state: nestedState, privateLog: join(nestedState, "billion-context/bili.log"), legacy: seedLegacyState(nestedState), configuration };
}
function sessionJsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sessionJsonFiles(join(directory, entry.name)) : entry.name.endsWith(".json") && !entry.name.endsWith(".content-store.json") ? [join(directory, entry.name)] : []);
}
function savedSession(directory, sessionId) {
  const records = sessionJsonFiles(directory).map(file => {
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    return { file, envelope, record: envelope.payload ?? envelope };
  }).filter(({ record }) => record.id === sessionId);
  assert.equal(records.length, 1, "exactly one real saved session envelope must match " + sessionId);
  const saved = records[0];
  assert.equal(saved.envelope.id, sessionId); assert.equal(saved.record.id, sessionId);
  assert(Array.isArray(saved.record.messages), "saved JSON must carry its actual bounded history");
  return saved;
}
async function legacyColdSnapshot(cid) {
  const result = await json(active.port, "/__bili/plugin/snapshot?conversationId=" + encodeURIComponent(cid));
  // Legacy deliberately has no transcript sidecar and does not retain a raw
  // public snapshot for a session which has never entered the fork contract.
  assert.equal(result.status, 409, result.text); assert.equal(result.body.ok, false);
  assert.equal(result.body.status, "unavailable"); assert.equal(result.body.code, "SNAPSHOT_UNAVAILABLE");
  assert.match(result.body.error, /raw snapshot unavailable; send a fresh plugin model request/);
  assert.match(result.body.error, /replicasUnavailable sidecar-missing/);
  console.log("  legacy cold snapshot contract: HTTP409 " + JSON.stringify(result.body));
  return result;
}
function corruptUnifiedKvRows(directory) {
  const keys = [["prefix-affinity", "v1"], ["session-order", "v1"], ["plugin-conversations", "table"]];
  database(directory, db => {
    for (const [namespace, key] of keys) {
      const changed = db.prepare("UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?").run("{malformed", namespace, key);
      assert.equal(changed.changes, 1, "the fault must corrupt one existing real KV carrier: " + namespace + "/" + key);
      assert.equal(db.prepare("SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?").get(namespace, key).value_json, "{malformed");
    }
  }, false);
}
async function recoveredLegacyKv(directory, label) {
  const kv = await eventually(() => {
    const value = readKv(directory);
    return value["prefix-affinity/v1"] && value["session-order/v1"] && value["plugin-conversations/table"] ? value : false;
  }, label);
  assert(kv["prefix-affinity/v1"].entries.some(entry => entry.sessionId === "e2e-legacy-affinity" && entry.tailHash === "legacy-tail"));
  assert(kv["session-order/v1"].entries.some(entry => entry.id === "e2e-legacy-order" && entry.tagHash === "legacy-tag"));
  assert.equal(kv["plugin-conversations/table"]["e2e-legacy-alias"].sessionId, "e2e-parent");
  return kv;
}
async function assertStorageMode(mode) {
  const response = await json(active.port, "/__bili/status"); assert.equal(response.status, 200, response.text);
  assert.equal(response.body.storage.requested, mode); assert.equal(response.body.storage.effective, mode); assert.equal(response.body.storage.degraded, false);
}
async function ingressChecks() {
  await check("completed gzip decode and text ingest limits return Chinese 413 before any gateway send", async () => {
    const previousContext = active.context; await stopProxy(active, true);
    const context = isolatedContext("ingress-limits", "full", "off"), receiveCap = 16 * 1024, cap = 512;
    const body = { model: "mock-model", max_tokens: 4096, stream: false, messages: [{ role: "user", content: "E2E_INGRESS_LIMIT_MARKER: " + "x".repeat(1536) }] };
    const plain = Buffer.from(JSON.stringify(body)), compressed = gzipSync(plain);
    assert(plain.length > cap && plain.length < 4096); assert(compressed.length < cap); assert(plain.length < receiveCap);
    const configuration = { ...context.configuration, network: { ...context.configuration.network, receiveBodyBytes: receiveCap, decodedBodyBytes: cap, ingestBodyBytes: 0 } };
    writeFileSync(context.configFile, JSON.stringify(configuration, null, 2));
    const path = `/bili/${gateway.origin}/v1/chat/completions`, headers = pluginHeaders("e2e-ingress-limit"), start = gateway.http.length;
    const assertLimit = (response, stage, detail) => {
      assert.equal(response.status, 413, response.text); assert.equal(response.headers["retry-after"], undefined);
      assert.equal(response.body.error?.type, "request_too_large"); assert.equal(response.body.error.stage, stage);
      assert.match(response.body.error.message, /[\u4e00-\u9fff]/); assert.match(response.body.error.message, /过大|超出/);
      assert(response.body.error.message.length <= 64, "the visible 413 must remain a short Chinese sentence");
      assert.equal(response.body.error.detail, detail, "the original limit diagnostic must remain complete in detail");
      assert.equal(gateway.http.length, start, "an ingress refusal must never send a request to the localhost model");
    };
    let ingressRun;
    try {
      ingressRun = await startProxy(context);
      // Both wire bodies fit the RECEIVE cap. These refusals occur only after
      // readBody has completed; a receive overflow destroys its real socket
      // and therefore cannot promise that a JSON 413 reaches the caller.
      const decoded = await json(active.port, path, compressed, { ...headers, "content-encoding": "gzip" });
      assertLimit(decoded, "decode", `decompressed request exceeds ${cap} bytes`);
      await applyConfiguration({ ...configuration, network: { ...configuration.network, decodedBodyBytes: plain.length, ingestBodyBytes: cap } });
      const ingested = await json(active.port, path, plain, headers);
      const ingestDetail = `request body ${plain.length.toLocaleString("en-US")} B (after decode) exceeds the ingestion cost band ${cap.toLocaleString("en-US")} B (#5794: bodies this large are ≥ ~8M tokens — beyond every model window — and burn the event loop for seconds in the parse sweep). Reduce the session history — restart the session or rewind to an earlier point — and retry.`;
      assertLimit(ingested, "ingest", ingestDetail);
      await applyConfiguration({ ...configuration, network: { ...configuration.network, decodedBodyBytes: plain.length, ingestBodyBytes: 0 } });
      const allowed = await json(active.port, path, compressed, { ...headers, "content-encoding": "gzip" });
      assert.equal(allowed.status, 200, allowed.text); assert.equal(gateway.http.length, start + 1);
      assert(gateway.http.at(-1).decoded.includes("E2E_INGRESS_LIMIT_MARKER"), "the same gzip body must pass at the exact decode cap when ingest is explicitly disabled");
      console.log(`  ingress limit evidence: gzip wire=${compressed.length} B, complete JSON=${plain.length} B, receive cap=${receiveCap} B; decode/ingest HTTP413, blocked gateway sends=0; exact decode cap plus ingest=0 forwarded once`);
    } finally { await stopProxy(ingressRun, true); }
    await startProxy(previousContext);
  });
}
async function wsIngressChecks() {
  await check("a small Responses WS continuation rejects expanded history with Chinese 413 and preserves its checkpoint", async () => {
    const previousContext = active.context; await stopProxy(active, true);
    const context = isolatedContext("ws-ingress-limits", "full", "off"), cap = 1536;
    const configuration = { ...context.configuration,
      diagnostics: { ...context.configuration.diagnostics, noInjectTool: true, noCompressPrompt: true },
      rollout: { ...context.configuration.rollout, features: { ...context.configuration.rollout.features, wsDeltaContinuation: false } },
      network: { ...context.configuration.network, receiveBodyBytes: cap, decodedBodyBytes: 16 * 1024, ingestBodyBytes: 0 } };
    writeFileSync(context.configFile, JSON.stringify(configuration, null, 2));
    let run, client;
    try {
      run = await startProxy(context);
      client = await openSocket(`ws://127.0.0.1:${active.port}/bili/${gateway.origin}/backend-api/codex/responses`, { "session-id": "e2e-ws-ingress-limit", "user-agent": "codex_cli_rs/e2e", authorization: "Bearer local-e2e-only" });
      const start = gateway.ws.length, httpStart = gateway.http.length;
      const invalid = await wsExchange(client, { type: "unsupported_e2e_event" }, { allowError: true });
      assert.equal(invalid.at(-1).status, 400); assert.equal(invalid.at(-1).error?.code, "invalid_request");
      const prefix = "WS_LIMIT_PREFIX: " + "p".repeat(512), firstFrame = wsBody([{ role: "user", content: prefix }]);
      assert(Buffer.byteLength(JSON.stringify(firstFrame)) < cap); assert.notEqual(firstFrame.generate, false); assert(firstFrame.input.length > 0);
      const first = await wsExchange(client, firstFrame), completed = first.find(event => event.type === "response.completed"); assert(completed?.response?.id);
      assert.equal(gateway.ws.length, start + 1, "the first frame must be an actual model generation, not a transport warmup"); assert(gateway.ws.at(-1).raw.includes("WS_LIMIT_PREFIX"));
      const missing = await wsExchange(client, { ...wsBody([{ role: "user", content: "WS_LIMIT_UNKNOWN_PREVIOUS" }]), previous_response_id: "e2e-unknown-response" }, { allowError: true });
      assert.equal(missing.at(-1).status, 400); assert.equal(missing.at(-1).error?.code, "previous_response_not_found");
      const oversized = { ...wsBody([{ role: "user", content: "WS_LIMIT_REJECTED_TAIL: " + "q".repeat(960) }]), previous_response_id: completed.response.id };
      assert(Buffer.byteLength(JSON.stringify(oversized)) < cap, "the new delta frame itself must fit the wire receive cap");
      const rejected = await wsExchange(client, oversized, { allowError: true }), failure = rejected.at(-1);
      assert.equal(failure.type, "error"); assert.equal(failure.status, 413); assert.equal(failure.error?.type, "invalid_request_error"); assert.equal(failure.error.code, "request_too_large");
      assert.match(failure.error.message, /[\u4e00-\u9fff]/); assert(failure.error.message.length <= 64);
      assert.equal(failure.error.detail, `response.create exceeds the ${Math.round(cap / (1024 * 1024))} MiB request limit`);
      assert.equal(failure["retry-after"], undefined); assert.equal(failure.error["retry-after"], undefined);
      assert.equal(gateway.ws.length, start + 1, "the expanded history refusal must not forward the rejected model turn"); assert.equal(gateway.http.length, httpStart, "a WS admission failure must not become an HTTP model retry");
      const healthy = await wsExchange(client, { ...wsBody([{ role: "user", content: "WS_LIMIT_HEALTHY_RETRY" }]), previous_response_id: completed.response.id });
      assert(healthy.some(event => event.type === "response.completed"), "a rejected expansion must preserve the previous valid checkpoint");
      assert.equal(gateway.ws.length, start + 2); assert(gateway.ws.at(-1).raw.includes("WS_LIMIT_HEALTHY_RETRY")); assert(!gateway.ws.at(-1).raw.includes("WS_LIMIT_REJECTED_TAIL"));
      console.log(`  WS ingress evidence: wire delta=${Buffer.byteLength(JSON.stringify(oversized))} B < cap=${cap} B; expansion HTTP-style status413, 400 codes preserved, rejected sends=0, same-checkpoint healthy continuation succeeded`);
    } finally { if (client) { client.close(); client.terminate?.(); } await stopProxy(run, true); }
    await startProxy(previousContext);
  });
}
async function storageChecks() {
  await stopProxy(active, true);
  const legacyContext = isolatedContext("storage-legacy", "legacy"), shadowContext = isolatedContext("storage-shadow", "shadow"), fullContext = isolatedContext("storage-full-fallback", "full");
  await check("explicit legacy file mode keeps JSON routing and never opens a unified database", async () => {
    await startProxy(legacyContext); await assertStorageMode("legacy");
    const cid = "e2e-storage-legacy", history = [{ role: "user", content: "LEGACY_STORAGE_MARKER: persist with the explicit legacy file setting." }];
    const turn = await chat(cid, history); assert.equal(turn.status, 200, turn.text); const before = await snapshot(cid); await stopProxy(active, true);
    assert(!existsSync(join(legacyContext.sessions, "index.db")), "explicit legacy must not silently turn on SQLite");
    const saved = savedSession(legacyContext.sessions, before.sessionId), first = before.orderedMessages[0]; assert(first.ref);
    assert.equal(saved.record.metadata.storageMode, "legacy"); assert.equal(saved.record.messagesFolded, true);
    assert.equal(saved.record.pluginSnapshot, undefined, "a raw fork snapshot is retained only after the real fork contract");
    assert.equal(saved.record.stats.requests, 1); assert.equal(saved.record.messages[0].text, history[0].content);
    assert.equal(saved.record.messages[0].id, first.rawId); assert.equal(saved.record.state.messageRefs.byRef[first.ref], first.rawId);
    assert.equal(saved.record.state.messageRefs.byRaw[first.rawId], first.ref);
    const fileTable = JSON.parse(readFileSync(legacyContext.legacy.find(file => file.name === "plugin-conversations.json").file, "utf8")); assert.equal(fileTable[cid].sessionId, before.sessionId);
    await startProxy(legacyContext); await assertStorageMode("legacy"); await legacyColdSnapshot(cid);
    const cold = await detail(before.sessionId); assert.equal(cold.id, before.sessionId); assert.equal(cold.storageMode, "legacy"); assert.equal(cold.requests, saved.record.stats.requests);
    const original = await json(active.port, `/__bili/sessions/${encodeURIComponent(before.sessionId)}/message?ref=${encodeURIComponent(first.ref)}`);
    assert.equal(original.status, 200, original.text); assert.equal(original.body.text, history[0].content, "legacy cold lookup must read the saved original under its real ref");
    const continuation = [...history, { role: "assistant", content: "LEGACY_COLD_ACK" }, { role: "user", content: "LEGACY_COLD_CONTINUE: retain the saved history while respecting file mode." }], wireStart = gateway.http.length;
    const continued = await chat(cid, continuation); assert.equal(continued.status, 200, continued.text);
    const forwards = gateway.http.slice(wireStart); assert.equal(forwards.length, 1); assert(forwards[0].decoded.includes(history[0].content)); assert(forwards[0].decoded.includes("LEGACY_COLD_CONTINUE"));
    const fresh = await snapshot(cid); assert.equal(fresh.sessionId, before.sessionId); assert.deepEqual(fresh.orderedMessages.slice(0, before.orderedMessages.length), before.orderedMessages, "a fresh real client request must restore the raw snapshot with its original stable identity");
    assert(fresh.messages.some(message => message.text?.includes("LEGACY_COLD_CONTINUE"))); await stopProxy(active, true);
    const continuedSaved = savedSession(legacyContext.sessions, before.sessionId).record;
    assert.equal(continuedSaved.metadata.storageMode, "legacy"); assert.equal(continuedSaved.stats.requests, 2);
    assert(continuedSaved.messages.some(message => message.text === history[0].content)); assert(continuedSaved.messages.some(message => message.text?.includes("LEGACY_COLD_CONTINUE")));
    assert.equal(continuedSaved.state.messageRefs.byRef[first.ref], first.rawId);
    assert(!existsSync(join(legacyContext.sessions, "index.db")), "restart and continuation must keep the explicit legacy mode");
  });
  await check("shadow mode migrates and recovers all three malformed KV carriers with cold JSON history", async () => {
    await startProxy(shadowContext); await assertStorageMode("shadow");
    await eventually(() => { const kv = readKv(shadowContext.sessions); return kv["prefix-affinity/v1"] && kv["session-order/v1"] && kv["plugin-conversations/table"] ? kv : false; }, "shadow KV migration");
    const cid = "e2e-storage-shadow", history = [{ role: "user", content: "SHADOW_STORAGE_MARKER: persist both the actual SQLite index and legacy envelope." }];
    const turn = await chat(cid, history); assert.equal(turn.status, 200, turn.text); const before = await snapshot(cid); await stopProxy(active, true);
    const saved = savedSession(shadowContext.sessions, before.sessionId).record; assert.equal(saved.metadata.storageMode, "shadow"); assert(saved.messages.some(message => message.text === history[0].content)); assertLegacyUnchanged(assert, shadowContext.legacy);
    await startProxy(shadowContext); await assertStorageMode("shadow"); const cold = await snapshot(cid); assert.deepEqual(cold.orderedMessages, before.orderedMessages); assert.equal(readKv(shadowContext.sessions)["plugin-conversations/table"][cid].sessionId, before.sessionId); await stopProxy(active, true);
    corruptUnifiedKvRows(shadowContext.sessions);
    await startProxy(shadowContext); await assertStorageMode("shadow"); await recoveredLegacyKv(shadowContext.sessions, "shadow malformed KV restoration from preserved legacy carriers");
    const recovered = await snapshot(before.sessionId); assert.deepEqual(recovered.orderedMessages, before.orderedMessages); assert(recovered.messages.some(message => message.text === history[0].content)); assertLegacyUnchanged(assert, shadowContext.legacy);
    const continuation = [...history, { role: "assistant", content: "SHADOW_FALLBACK_ACK" }, { role: "user", content: "SHADOW_FALLBACK_CONTINUE" }], start = gateway.http.length;
    const continued = await chat(cid, continuation); assert.equal(continued.status, 200, continued.text); assert.equal(gateway.http.length, start + 1); assert(gateway.http.at(-1).decoded.includes(history[0].content)); assert(gateway.http.at(-1).decoded.includes("SHADOW_FALLBACK_CONTINUE")); await stopProxy(active, true);
    assert.equal(savedSession(shadowContext.sessions, before.sessionId).record.metadata.storageMode, "shadow"); assertLegacyUnchanged(assert, shadowContext.legacy);
  });
  await check("full mode uses preserved legacy envelopes and malformed KV rows as real cold-start fallbacks", async () => {
    await startProxy(fullContext); await assertStorageMode("full");
    await eventually(() => { const kv = readKv(fullContext.sessions); return kv["prefix-affinity/v1"] && kv["session-order/v1"] && kv["plugin-conversations/table"] ? kv : false; }, "full KV migration");
    const cid = "e2e-storage-full", history = [{ role: "user", content: "FULL_FALLBACK_MARKER: preserve this session envelope before removing only its synthetic SQLite test record." }];
    const turn = await chat(cid, history); assert.equal(turn.status, 200, turn.text); const before = await snapshot(cid);
    const parent = await chat("e2e-parent", [{ role: "user", content: "FULL_LEGACY_ALIAS_TARGET" }]); assert.equal(parent.status, 200, parent.text); await stopProxy(active, true);
    const backupDirectory = join(fullContext.root, "saved-json-envelopes"); mkdirSync(backupDirectory);
    const backups = sessionJsonFiles(fullContext.sessions).map((file, index) => { const saved = join(backupDirectory, String(index) + ".json"); copyFileSync(file, saved); return { file, saved, bytes: readFileSync(saved) }; }); assert(backups.length > 0); assertLegacyUnchanged(assert, fullContext.legacy);
    assert.equal(savedSession(fullContext.sessions, before.sessionId).record.metadata.storageMode, "full");
    database(fullContext.sessions, db => { db.exec("PRAGMA foreign_keys = ON"); assert.equal(db.prepare("DELETE FROM sessions WHERE session_id = ?").run(before.sessionId).changes, 1, "remove exactly the actual synthetic session index row"); assert.equal(db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(before.sessionId), undefined); }, false);
    corruptUnifiedKvRows(fullContext.sessions);
    await startProxy(fullContext); await assertStorageMode("full"); const cold = await snapshot(cid); assert.deepEqual(cold.orderedMessages, before.orderedMessages, "a missing synthetic index row must fall back to its preserved real envelope");
    const routed = await snapshot("e2e-legacy-alias"); assert.equal(routed.sessionId, "e2e-parent", "malformed unified routing must retain the pre-migration alias");
    await recoveredLegacyKv(fullContext.sessions, "all three malformed full KV rows recover from their preserved legacy carriers"); assertLegacyUnchanged(assert, fullContext.legacy);
    const continued = await chat(cid, [...history, { role: "assistant", content: "FULL_FALLBACK_ACK" }, { role: "user", content: "FULL_FALLBACK_CONTINUE" }]); assert.equal(continued.status, 200, continued.text); await stopProxy(active, true);
    for (const backup of backups) { assert(existsSync(backup.file), "fallback must preserve original backup paths"); assert.deepEqual(readFileSync(backup.saved), backup.bytes, "the frozen pre-fallback backup must remain unchanged"); }
  });
  await check("an actual online SQLite backup restores only its checkpoint and leaves later writes behind", async () => {
    const backupContext = isolatedContext("storage-online-backup", "full", "off"), rollbackContext = isolatedContext("storage-backup-rollback", "full", "off"), cid = "e2e-storage-backup";
    await startProxy(backupContext); await assertStorageMode("full");
    const history = [{ role: "user", content: "BACKUP_POINT_MARKER: only this prefix belongs to the frozen checkpoint." }];
    const initial = await chat(cid, history); assert.equal(initial.status, 200, initial.text); const point = await snapshot(cid);
    const checkpoint = await json(active.port, "/__bili/replicas", { sessionId: point.sessionId, label: "e2e online backup save barrier" }); assert.equal(checkpoint.status, 201, checkpoint.text);
    const path = join(backupContext.root, "frozen-index.db"), saved = await json(active.port, "/__bili/storage/backup", { dst: path }); assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.ok, true); assert.equal(resolve(saved.body.path), resolve(path));
    const bytes = readFileSync(path);
    const later = await chat(cid, [...history, { role: "assistant", content: "BACKUP_AFTER_ACK" }, { role: "user", content: "AFTER_BACKUP_MARKER: this later turn must not appear after restoring the older checkpoint." }]); assert.equal(later.status, 200, later.text); const latest = await snapshot(cid); assert(latest.orderedMessages.length > point.orderedMessages.length); await stopProxy(active, true);
    assert.deepEqual(readFileSync(path), bytes, "later writes must not modify the frozen backup");
    copyFileSync(path, join(rollbackContext.sessions, "index.db"));
    await startProxy(rollbackContext); await assertStorageMode("full"); const restored = await snapshot(cid);
    assert.deepEqual(restored.orderedMessages, point.orderedMessages, "restored history must equal exactly the backup point"); assert(restored.messages.some(message => message.text?.includes("BACKUP_POINT_MARKER"))); assert(!restored.messages.some(message => message.text?.includes("AFTER_BACKUP_MARKER")), "an older backup cannot recover later writes"); await stopProxy(active, true);
    console.log("  backup rollback evidence: checkpoint messages=" + point.orderedMessages.length + ", live messages=" + latest.orderedMessages.length + ", restored messages=" + restored.orderedMessages.length + "; later writes intentionally absent from the older backup");
  });
  await startProxy();
}
async function openSocket(url, headers) {
  const client = new LocalWebSocket(url, { headers }); clients.add(client);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("local WebSocket upgrade timed out")), 10000);
    const opened = () => finish(), failed = event => finish(event.error ?? new Error("local WebSocket upgrade failed"));
    const finish = error => { clearTimeout(timer); client.removeEventListener("open", opened); client.removeEventListener("error", failed); error ? reject(error) : resolve(); };
    client.addEventListener("open", opened, { once: true }); client.addEventListener("error", failed, { once: true });
  });
  return client;
}
const wsExchange = (client, body, { allowError = false } = {}) => new Promise((resolve, reject) => {
  const events = [], timer = setTimeout(() => finish(new Error("local Responses WS exchange timed out")), 12000);
  const finish = error => { clearTimeout(timer); client.removeEventListener("message", message); client.removeEventListener("error", failed); error ? reject(error) : resolve(events); };
  const failed = event => finish(event.error ?? new Error("Responses WS exchange failed"));
  const message = event => { let body; try { body = JSON.parse(String(event.data)); } catch { return; } events.push(body); if (body.type === "response.completed") finish(); else if (body.type === "error" || body.type === "response.failed") finish(allowError ? undefined : new Error(JSON.stringify(body))); };
  client.addEventListener("message", message); client.addEventListener("error", failed, { once: true });
  try { client.send(JSON.stringify(body)); } catch (error) { finish(error); }
});
const SUMMARY = "E2E_SUMMARY_ALPHA: the local mock history established stable references, conserved the original passages, and finished the preparation work. The next step is to continue the same task after folding.";
const messages = [{ role: "system", content: "You are the isolated local E2E mock assistant." }];
for (let i = 0; i < 8; i++) { messages.push({ role: "user", content: `ORIGINAL_USER_${i}: ` + "The local context fixture records a completed action and its exact outcome. ".repeat(10) }); messages.push({ role: "assistant", content: `ORIGINAL_ASSISTANT_${i}: ` + "The mock assistant verified its earlier action and retained the evidence. ".repeat(10) }); }
messages.push({ role: "user", content: "PARENT_INITIAL: acknowledge the completed history." });
const parentCid = "e2e-parent", childCid = "e2e-child";
let parentSnap, childSnap, blockId, firstRef, firstRaw, parentRequest, forkRequest, normalBody, currentParentMessages = messages, currentChildMessages, coveredLabels;
const nativeCheckName = "candidate native WS awaits real fork preparation and refuses stale identity, model and origin (mock host metadata)";
const imageTransformConfiguration = () => ({ ...baseConfiguration, egressTransforms: [{ module: join(repo, "scripts/fixtures/e2e-mock/egress-images.mjs"), match: { provider: gateway.origin } }] });
async function imageOutboundChecks() {
  await check("image receipts follow the final transformed and gzipped outbound body", async () => {
    const cid = "e2e-image-egress-initial", pixels = imageUrl([180, 20, 130]), history = historicalImageMessages(pixels, "IMAGE_EGRESS_FINAL_BODY"), rid = randomUUID();
    await applyConfiguration(imageTransformConfiguration());
    try {
      const removed = await chat(cid, history, "gzip", rid); assert.equal(removed.status, 200, removed.text);
      const first = gateway.http.at(-1); assert.equal(first.headers["x-e2e-transform-stage"], "initial"); assert.equal(first.headers["content-encoding"], "gzip"); assert(!first.decoded.includes(pixels)); assert(first.decoded.includes("E2E_OUTBOUND_IMAGE_REMOVED"));
      const records = await json(active.port, "/__bili/encode-stats?rid=" + rid); assert.equal(records.status, 200, records.text); assert.equal(records.body.records.length, 1); assert.equal(records.body.records[0].origBytes, first.decoded.length); assert.equal(records.body.records[0].wireBytes, first.wire.length);
      await applyConfiguration(baseConfiguration);
      const unseen = await chat(cid, history); assert.equal(unseen.status, 200, unseen.text); assert(gateway.http.at(-1).decoded.includes(pixels), "pixels absent from the earlier final body must still be unseen on their first real send");
      const continued = await chat(cid, [...history, { role: "assistant", content: "MOCK_IMAGE_EGRESS_ACK" }, { role: "user", content: "IMAGE_EGRESS_CONTINUE" }]); assert.equal(continued.status, 200, continued.text); const final = gateway.http.at(-1).decoded.toString(); assert(!final.includes(pixels)); assert.match(final, /已看过/);
    } finally { await applyConfiguration(baseConfiguration); }
  });
  await check("real compression-loop sends credit successful pixels and keep failed pixels unseen", async () => {
    for (const failed of [false, true]) {
      const variant = failed ? "failed" : "success", cid = "e2e-image-loop-" + variant, path = "/image-loop-" + variant + "/v1/chat/completions", pixels = imageUrl(failed ? [40, 110, 210] : [130, 210, 40]);
      const prefix = [];
      for (let i = 0; i < 2; i++) prefix.push({ role: "user", content: `IMAGE_LOOP_ORIGINAL_USER_${i}: ` + "The local loop fixture records finished work before displaying a new image. ".repeat(8) }, { role: "assistant", content: `IMAGE_LOOP_ORIGINAL_ASSISTANT_${i}: ` + "The work was verified and can be summarized independently of the later image. ".repeat(8) });
      const setup = await chat(cid, [...prefix, { role: "user", content: "IMAGE_LOOP_SETUP_TAIL" }]); assert.equal(setup.status, 200, setup.text); const before = await snapshot(cid), refs = before.orderedMessages.filter(message => message.ref); assert(refs.length >= 4);
      const summary = `E2E_IMAGE_LOOP_SUMMARY_${variant}: the first four passages describe verified completed work; continue with the newer image and current task.`;
      const history = [...prefix, { role: "user", content: [{ type: "text", text: "IMAGE_LOOP_FIRST_IMAGE_" + variant }, { type: "image_url", image_url: { url: pixels } }] }, { role: "assistant", content: "MOCK_IMAGE_LOOP_HISTORY_ACK" }, { role: "user", content: "IMAGE_LOOP_STREAMED_TURN_" + variant }];
      // Exhaust the declared three-attempt replay budget in the failed case;
      // an unplanned later mock reply would correctly count as a successful send.
      const plan = gateway.planPath(path, [{ kind: "compress", args: { content: JSON.stringify([{ startId: refs[0].ref, endId: refs[3].ref, summary }]) } }, ...Array.from({ length: failed ? 3 : 1 }, () => ({ kind: failed ? "reset" : "reply" }))]);
      await applyConfiguration(imageTransformConfiguration()); const start = gateway.http.length;
      try {
        // A bound plugin session retains its mode without live headers. Ask for
        // the supported proxy compression channel while keeping its identity.
        const streamed = await chat(cid, history, "off", randomUUID(), { path, stream: true, proxyMode: true }); assert.equal(streamed.status, 200, streamed.text);
        const sends = gateway.http.slice(start).filter(record => record.path === path); assert.equal(sends.length, failed ? 4 : 2, "the real loop must send once initially, rebuild once and exhaust only the declared replay budget; remaining=" + plan.remaining() + "; tools=" + JSON.stringify(sends[0]?.body.tools?.map(tool => tool.function?.name)) + "; response=" + streamed.text.slice(0, 1600)); assert.equal(plan.remaining(), 0);
        assert.equal(sends[0].headers["x-e2e-transform-stage"], "initial"); assert(!sends[0].decoded.includes(pixels)); assert(sends[0].decoded.includes("E2E_OUTBOUND_IMAGE_REMOVED"));
        for (const send of sends.slice(1)) { assert.equal(send.headers["x-e2e-transform-stage"], "loop"); assert(send.decoded.includes(pixels), "every loop replay must send pixels absent from the initial final body"); assert(send.decoded.includes(summary), "the real wire tool call must fold the earlier prefix before the follow-up sends"); assert(send.decoded.equals(sends[1].decoded), "bounded network replays must retain the same final rebuilt body"); }
        if (failed) {
          const events = streamed.text.split(/\r?\n/).filter(line => line.startsWith("data: ")).flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } }); const errors = events.filter(event => event.error || event.type === "error"); assert(errors.length > 0, "a failed loop fetch must expose a protocol error event: " + streamed.text); assert.match((errors[0].error ?? errors[0]).message, /[\u4e00-\u9fff]/, "a real failed compression-loop send must retain the Chinese failure message");
        } else assert.match(streamed.text, /MOCK_REPLY_/);
      } finally { plan.cancel(); await applyConfiguration(baseConfiguration); }
      const retried = await chat(cid, [...history, { role: "assistant", content: "MOCK_IMAGE_LOOP_CONTINUATION_ACK" }, { role: "user", content: "IMAGE_LOOP_CONTINUE_" + variant }]); assert.equal(retried.status, 200, retried.text); const final = gateway.http.at(-1).decoded.toString();
      if (failed) assert(final.includes(pixels), "pixels from the failed loop send must stay raw until their own successful retry");
      else { assert(!final.includes(pixels), "pixels from a successful loop send must be credited for the next client turn"); assert.match(final, /已看过/); }
      assert.equal((await detail(before.sessionId)).blockDetails.filter(block => block.active && block.summary?.includes(summary)).length, 1, "the single model-triggered compression rebuild must create exactly one actual block");
    }
  });
}
async function nativeWsChecks() {
  const nativeParent = "e2e-native-parent", nativeChild = "e2e-native-child", nativeSummary = "E2E_NATIVE_WS_SUMMARY: the earlier native history has been verified locally and the fork must inherit this finished work.";
  const nativeHistory = [];
  for (let i = 0; i < 5; i++) { nativeHistory.push({ role: "user", content: `NATIVE_ORIGINAL_USER_${i}: ` + "The localhost native fork fixture preserves completed work. ".repeat(8) }, { role: "assistant", content: `NATIVE_ORIGINAL_ASSISTANT_${i}: ` + "The result is recorded before the child continues. ".repeat(8) }); }
  nativeHistory.push({ role: "user", content: "NATIVE_PARENT_INITIAL" });
  const body = wsBody(nativeHistory), result = await json(active.port, `/bili/${gateway.origin}/backend-api/codex/responses`, { ...body, type: undefined, stream: false }, pluginHeaders(nativeParent)); assert.equal(result.status, 200, result.text);
  const parent = await snapshot(nativeParent), refs = parent.orderedMessages.filter(message => message.ref);
  const compressed = await tool(nativeParent, "compress", { content: JSON.stringify([{ startId: refs[0].ref, endId: refs[5].ref, summary: nativeSummary }]) }, { toolCallId: "plugin_e2e_native_compress" }); assert.equal(compressed.status, 200, compressed.text); assert.equal(compressed.body.outcome, "applied", compressed.text);
  const count = gateway.ws.length;
  const evidence = await nativeFixture({ proxyOrigin: `http://127.0.0.1:${active.port}`, upstreamWs: gateway.origin.replace(/^http/, "ws") + "/backend-api/codex/responses", parentCid: nativeParent, childCid: nativeChild, summary: nativeSummary, inheritedRefs: parent.orderedMessages.slice(0, 6), body: { ...body, input: [...body.input, { type: "message", role: "user", content: [{ type: "input_text", text: "NATIVE_WS_FIRST_FORK" }] }] } });
  console.log("  native WS evidence: " + JSON.stringify(evidence));
  assert(evidence.toolsGateHeldUpgrade && evidence.inheritedBeforeWire && evidence.completeCandidateBundle && evidence.simulatedHostMetadata); assert(evidence.bodyPreparations >= 2);
  assert.deepEqual(evidence.authoritativeHeaderShapes, ["object", "tuples", "Headers"]);
  const forwarded = gateway.ws.slice(count); assert.equal(forwarded.length, 2, "only the first fork turn and same-identity continuation may reach the gateway");
  assert(forwarded[0].raw.includes(nativeSummary), "the first native response.create must already carry inherited compression"); assert(forwarded[0].raw.includes("NATIVE_WS_FIRST_FORK")); assert(forwarded[1].raw.includes("NATIVE_WS_CONTINUE_ALLOWED"));
  assert(!forwarded.some(record => /NATIVE_WS_(?:IDENTITY|MODEL|ORIGIN)_FORBIDDEN/.test(record.raw))); assert.equal(forwarded[0].headers["session-id"], nativeChild);
}

try {
  gateway = await startGateway(); env.BILI_ANNOUNCEMENTS_URL = gateway.origin + "/announcements";
  baseConfiguration = { upstream: gateway.origin, upstreamProxyMode: "direct", autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false, remoteAnnouncementsUrl: gateway.origin + "/announcements", mitm: { enabled: false }, modelContextLimit: 1000000,
    storage: { unified: "full", jsonWriter: "off", sqliteAutoDownload: false }, rollout: { installId: "e2e-mock-install", features: { snapshotRender: true, snapshotRenderShadow: false, pluginLaneServerHistory: true } },
    compress: { preserveRecentMessages: 2, preserveRecentTokens: 0, minCompressRangeChars: 1, minSummaryLength: 1, maxSummaryLength: 2000, requireNudge: false, requireRecommendation: false }, providers: { [gateway.origin]: { models: { "mock-model": { context: 1000000, output: 4096 }, "mock-tiny": { context: 128, output: 16 }, "mock-side": { context: 1024, output: 128 } }, calibration: { disabled: true } } } };
  writeFileSync(configFile, JSON.stringify(baseConfiguration, null, 2));
  console.log(`e2e mock candidate: ${entry}\n  sha256 ${candidateHash}${nativeHash ? "\n  native sha256 " + nativeHash : ""}\n  Node ${process.version}; local gateway only; temporary SQLite and XDG homes`);
  await startProxy();
  if (nativeOnly) {
    assert(nativeCandidate.includes("installDshIntercepts"), "--native-only requires the candidate's real native WS installer");
    await check(nativeCheckName, nativeWsChecks);
  } else if (storageOnly) {
    assert(hasKvMigration, "--storage-only requires all three real unified KV carrier implementations"); await storageChecks();
  } else {
  await check("block lifecycle tools default off and egress transforms start absent or empty", async () => {
    const names = await manifestToolNames(); for (const name of lifecycleTools) assert(!names.includes(name), "default manifest must not advertise " + name);
    const config = await json(active.port, "/__bili/config"); assert.equal(config.status, 200, config.text); const file = JSON.parse(config.body.raw);
    assert.equal(file.compress.blockOps, undefined); assert.equal(file.egressTransforms, undefined);
    await applyConfiguration({ ...baseConfiguration, egressTransforms: [] });
    const empty = await json(active.port, "/__bili/config"); assert.deepEqual(JSON.parse(empty.body.raw).egressTransforms, []);
    await applyConfiguration(baseConfiguration);
  });
  if (hasKvMigration) await check("real startup migrates legacy affinity, order and conversation files into SQLite KV", async () => {
    const kv = await eventually(() => { const value = readKv(sessions); return value["prefix-affinity/v1"] && value["session-order/v1"] && value["plugin-conversations/table"] ? value : false; }, "KV startup migration");
    assert(kv["prefix-affinity/v1"].entries.some(x => x.sessionId === "e2e-legacy-affinity" && x.tailHash === "legacy-tail"));
    assert(kv["session-order/v1"].entries.some(x => x.id === "e2e-legacy-order" && x.tagHash === "legacy-tag"));
    assert.equal(kv["plugin-conversations/table"]["e2e-legacy-alias"].sessionId, parentCid); assertLegacyUnchanged(assert, legacy);
  }); else skip("SQLite KV migration", "candidate predates the three legacy-state KV carriers");
  await check("real normal turn records a session and stable message refs", async () => {
    const result = await chat(parentCid, messages); assert.equal(result.status, 200, result.text); assert.match(result.text, /MOCK_REPLY_/);
    parentRequest = gateway.http.at(-1); normalBody = parentRequest.decoded; assert(parentRequest.decoded.includes("ORIGINAL_USER_0"));
    assert.equal(typeof parentRequest.body.prompt_cache_key, "string", "default routing must emit a concrete cache key"); assert(parentRequest.body.prompt_cache_key.length > 0);
    parentSnap = await snapshot(parentCid); assert(parentSnap.orderedMessages.length >= 17); assert(parentSnap.orderedMessages.some(x => /^m\d{5,}$/.test(x.ref)));
    assert.equal(parentRequest.headers["x-accel-compress"], undefined); assert.equal(parentRequest.headers["x-accel-rid"], undefined);
  });
  await check("real plugin compression creates a retrievable block", async () => {
    const refs = parentSnap.orderedMessages.filter(x => x.ref); firstRef = refs[0].ref; firstRaw = parentSnap.messages.find(x => x.ref === firstRef)?.text;
    const result = await tool(parentCid, "compress", { content: JSON.stringify([{ startId: firstRef, endId: refs[5].ref, summary: SUMMARY }]) }, { toolCallId: "plugin_e2e_compress" });
    assert.equal(result.status, 200, result.text); assert.equal(result.body.outcome, "applied", result.text); assert(result.body.blocksCreated > 0, result.text);
    const saved = await detail(parentSnap.sessionId); const block = saved.blockDetails.find(x => x.active && x.summary?.includes(SUMMARY)); assert(block, JSON.stringify(saved.blockDetails)); blockId = block.blockId;
    coveredLabels = block.directMessageRefs.flatMap(ref => { const text = parentSnap.messages.find(m => m.ref === ref)?.text ?? ""; return text.match(/ORIGINAL_(?:USER|ASSISTANT)_\d+/g) ?? []; });
    assert(coveredLabels.length >= 6, "the lifecycle fixture must actually cover six original passages"); assert.equal(typeof firstRaw, "string"); assert(firstRaw.length > 60);
    const original = await json(active.port, `/__bili/sessions/${encodeURIComponent(parentSnap.sessionId)}/block-content?blockId=${encodeURIComponent(blockId)}&view=full`); assert.equal(original.status, 200, original.text); assert.match(original.text, /ORIGINAL_(?:USER|ASSISTANT)_/);
  });
  messages.push({ role: "assistant", content: "MOCK_PARENT_ACK" }, { role: "user", content: "PARENT_CONTINUE: continue after compression." });
  await check("continuation sends the compressed snapshot to the real local gateway", async () => {
    const result = await chat(parentCid, messages); assert.equal(result.status, 200, result.text); parentRequest = gateway.http.at(-1);
    assert(parentRequest.decoded.includes(SUMMARY), parentRequest.decoded.toString().slice(-4000)); assert(parentRequest.decoded.includes("PARENT_CONTINUE"));
    const beforeMarkers = (normalBody.toString().match(/ORIGINAL_(?:USER|ASSISTANT)_\d+/g) ?? []).length;
    const afterMarkers = (parentRequest.decoded.toString().match(/ORIGINAL_(?:USER|ASSISTANT)_\d+/g) ?? []).length;
    assert(afterMarkers < beforeMarkers, `covered originals must leave the wire view (${beforeMarkers} -> ${afterMarkers}; bytes ${normalBody.length} -> ${parentRequest.decoded.length})`); parentSnap = await snapshot(parentCid);
  });
  await check("explicit fork inherits compression, refs and the actual parent cache key", async () => {
    forkRequest = { protocolVersion: parentSnap.protocolVersion, parentConversationId: parentCid, childConversationId: childCid, parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: parentSnap.orderedMessages.length, orderHash: parentSnap.orderHash }, orderedMessages: parentSnap.orderedMessages, idempotencyKey: "e2e-fork-inheritance" };
    const fork = await json(active.port, "/__bili/plugin/fork", forkRequest); assert.equal(fork.status, 201, fork.text); assert.equal(fork.body.ok, true);
    const replay = await json(active.port, "/__bili/plugin/fork", forkRequest); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.replayed, true);
    const conflict = await json(active.port, "/__bili/plugin/fork", { ...forkRequest, idempotencyKey: "different-request" }); assert.equal(conflict.status, 409, conflict.text);
    const before = await snapshot(childCid); assert.deepEqual(before.orderedMessages.slice(0, parentSnap.orderedMessages.length), parentSnap.orderedMessages);
    currentChildMessages = [...messages, { role: "assistant", content: "MOCK_PARENT_REPLY" }, { role: "user", content: "CHILD_FIRST: keep the inherited summary." }];
    const result = await chat(childCid, currentChildMessages); assert.equal(result.status, 200, result.text);
    const forwarded = gateway.http.at(-1); assert(forwarded.decoded.includes(SUMMARY)); assert(forwarded.decoded.includes("CHILD_FIRST")); assert.equal(forwarded.body.prompt_cache_key, parentRequest.body.prompt_cache_key); childSnap = await snapshot(childCid);
  });
  await check("gzip and br compress the final folded body and expose matching receipts", async () => {
    for (const encoding of ["gzip", "br"]) {
      const rid = randomUUID(), result = await chat(parentCid, messages, encoding, rid); assert.equal(result.status, 200, result.text);
      const forwarded = gateway.http.at(-1); assert.equal(forwarded.headers["content-encoding"], encoding); assert.equal(Number(forwarded.headers["content-length"]), forwarded.wire.length); assert(forwarded.decoded.includes(SUMMARY));
      assert.equal(forwarded.headers["x-accel-compress"], undefined); assert.equal(forwarded.headers["x-accel-rid"], undefined);
      const records = await json(active.port, "/__bili/encode-stats?rid=" + rid); assert.equal(records.status, 200); assert.equal(records.body.records.length, 1, records.text);
      const receipt = records.body.records[0]; assert.equal(receipt.encoding, encoding); assert.equal(receipt.origBytes, forwarded.decoded.length); assert.equal(receipt.wireBytes, forwarded.wire.length); assert(receipt.wireBytes < receipt.origBytes * 0.95);
    }
  });
  await check("restart replaces the real process and cold-loads fork blocks and original refs", async () => {
    const replica = await json(active.port, "/__bili/replicas", { sessionId: parentSnap.sessionId, label: "e2e persistence checkpoint" }); assert.equal(replica.status, 201, replica.text);
    if (hasKvMigration) assertLegacyUnchanged(assert, legacy);
    const before = active.health; await stopProxy(active, true); const after = await startProxy(); assert.notEqual(after.health.instanceId, before.instanceId); assert.notEqual(after.health.pid, before.pid);
    const coldParent = await snapshot(parentCid), coldChild = await snapshot(childCid); assert.equal(coldParent.sessionId, parentSnap.sessionId); assert.equal(coldChild.sessionId, childSnap.sessionId); assert.deepEqual(coldParent.orderedMessages, parentSnap.orderedMessages);
    const original = await json(active.port, `/__bili/sessions/${encodeURIComponent(parentSnap.sessionId)}/message?ref=${encodeURIComponent(firstRef)}`); assert.equal(original.status, 200, original.text); assert(original.text.includes(firstRaw.slice(0, 60)), original.text);
    const childBlocks = (await detail(childSnap.sessionId)).blockDetails; assert(childBlocks.some(x => x.blockId === blockId && x.active && x.summary?.includes(SUMMARY)));
    currentParentMessages = [...messages, { role: "assistant", content: "MOCK_COLD_ACK" }, { role: "user", content: "PARENT_COLD_CONTINUE" }];
    const result = await chat(parentCid, currentParentMessages); assert.equal(result.status, 200, result.text); assert(gateway.http.at(-1).decoded.includes(SUMMARY));
  });
  const enabledBlockConfiguration = { ...baseConfiguration, compress: { ...baseConfiguration.compress, blockOps: { enabled: true } } };
  await applyConfiguration(enabledBlockConfiguration); const availableTools = await manifestToolNames();
  if (hasBlockLifecycle) await check("retired blocks invalidate old pinned views and remain retrievable before restoration", async () => {
    assert(lifecycleTools.every(name => availableTools.includes(name)), "a candidate implementing lifecycle must expose all three tools after explicit enable; missing tools are a failure, not an unsupported capability");
    // The plugin executor uses this session's last wire-resolved config. A new
    // real prepare adopts the enabled setting and leaves a pinned old view to
    // invalidate; a disabled acknowledgement is not a successful operation.
    const enabled = await chat(parentCid, currentParentMessages); assert.equal(enabled.status, 200, enabled.text); assert(gateway.http.at(-1).decoded.includes(SUMMARY));
    const retired = await tool(parentCid, "acp_retire", { blockId }); assert.equal(retired.status, 200, retired.text); assert(retired.body.result.startsWith("[acp_retire:"), retired.text); assert(retired.body.result.includes(blockId + " retired"), retired.text); assert(!retired.body.result.includes("FAILED"), retired.text);
    const result = await chat(parentCid, currentParentMessages); assert.equal(result.status, 200, result.text); const wire = gateway.http.at(-1).decoded.toString(); assert(!wire.includes(SUMMARY), "old pinned summary must not survive retirement");
    for (const label of coveredLabels) assert(!wire.includes(label), "retirement must not resurrect covered original " + label);
    const original = await tool(parentCid, "decompress", { blockId, full: true }); assert.equal(original.status, 200, original.text); assert.match(original.body.result, /ORIGINAL_(?:USER|ASSISTANT)_/);
    const restored = await tool(parentCid, "acp_restore", { blockId }); assert.equal(restored.status, 200, restored.text); assert(restored.body.result.startsWith("[acp_restore:"), restored.text); assert(restored.body.result.includes(blockId + " restored"), restored.text); assert(!restored.body.result.includes("FAILED"), restored.text);
    const continued = await chat(parentCid, currentParentMessages); assert.equal(continued.status, 200, continued.text); assert(gateway.http.at(-1).decoded.includes(SUMMARY), "restoration must replace the retired wire view with the active summary");
    const rewrittenSummary = SUMMARY.replace("ALPHA", "BETA");
    const rewritten = await tool(parentCid, "acp_rewrite", { blockId, summary: rewrittenSummary }); assert.equal(rewritten.status, 200, rewritten.text); assert(!rewritten.body.result.includes("FAILED"), rewritten.text);
    const changed = await chat(parentCid, currentParentMessages); assert.equal(changed.status, 200, changed.text); const final = gateway.http.at(-1).decoded.toString(); assert(final.includes(rewrittenSummary)); assert(!final.includes(SUMMARY), "an old view must not freeze the previous summary after rewrite");
    await applyConfiguration({ ...baseConfiguration, compress: { ...baseConfiguration.compress, blockOps: { enabled: false } } });
    const disabledNames = await manifestToolNames(); for (const name of lifecycleTools) assert(!disabledNames.includes(name), "disabled lifecycle tool must disappear: " + name);
    const refreshed = await chat(parentCid, currentParentMessages); assert.equal(refreshed.status, 200, refreshed.text);
    const disabledRetire = await tool(parentCid, "acp_retire", { blockId }); assert.equal(disabledRetire.status, 200, disabledRetire.text); assert.match(disabledRetire.body.result, /not enabled/);
    assert((await detail(parentSnap.sessionId)).blockDetails.some(block => block.blockId === blockId && block.active && block.summary === rewrittenSummary), "disabled tools must not mutate the active block");
  }); else skip("block lifecycle", "candidate does not expose the opt-in retire/restore tools");
  if (hasKvMigration) await check("cold startup honors fresher SQLite conversation routing over legacy files", async () => {
    await stopProxy(active, true);
    database(sessions, db => { const row = db.prepare("SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?").get("plugin-conversations", "table"); const table = JSON.parse(row.value_json); table["e2e-legacy-alias"] = { sessionId: childSnap.sessionId, lastSeen: Date.now() + 10000 }; db.prepare("UPDATE kv_store SET value_json = ?, updated_at = ? WHERE namespace = ? AND key = ?").run(JSON.stringify(table), Date.now(), "plugin-conversations", "table"); }, false);
    await startProxy(); const fromKv = await snapshot("e2e-legacy-alias"); assert.equal(fromKv.sessionId, childSnap.sessionId, "cold plugin lookup must follow the fresher KV alias without a model rebind"); assertLegacyUnchanged(assert, legacy);
    const kv = readKv(sessions); assert(kv["prefix-affinity/v1"].entries.some(x => x.sessionId === "e2e-legacy-affinity")); assert(kv["session-order/v1"].entries.some(x => x.id === "e2e-legacy-order"));
  });
  if (candidate.includes("codex-responses-ws")) await check("a real Codex Responses WebSocket frame crosses the candidate proxy and local gateway", async () => {
    const count = gateway.ws.length;
    const client = await openSocket(`ws://127.0.0.1:${active.port}/bili/${gateway.origin}/backend-api/codex/responses`, { "session-id": "e2e-codex-ws", "user-agent": "codex_cli_rs/e2e", authorization: "Bearer local-e2e-only" });
    const events = await wsExchange(client, wsBody([{ role: "user", content: "CODEX_WS_FIRST: acknowledge the real local WebSocket path." }]));
    assert(events.some(event => event.type === "response.completed")); assert(gateway.ws.length > count); assert(gateway.ws.at(-1).raw.includes("CODEX_WS_FIRST")); assert.equal(gateway.ws.at(-1).headers["session-id"], "e2e-codex-ws");
    client.close(); client.terminate(); clients.delete(client);
  }); else skip("Codex Responses WS bridge", "candidate does not contain the Codex WS codec");
  if (nativeCandidate.includes("installDshIntercepts")) await check(nativeCheckName, nativeWsChecks); else skip("native WS fork and cached connection identity", "candidate predates installDshIntercepts and its frame-preparation wrapper");
  await check("a one-shot SQLite transcript read miss recovers after the real queued save without double-counting the model request", async () => {
    const forwardedBefore = gateway.http.length;
    await stopProxy(active, true);
    const before = database(sessions, db => {
      const session = db.prepare("SELECT stats_json FROM sessions WHERE session_id = ?").get(childSnap.sessionId); const count = JSON.parse(session.stats_json).requests;
      const rows = db.prepare("SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ? AND ref = ?").all(childSnap.sessionId, firstRef); assert.equal(rows.length, 1);
      return { rows, count };
    });
    await startProxy(); const logStart = proxyLog().length;
    writeFileSync(sqliteFault, JSON.stringify({ sessionId: childSnap.sessionId, remaining: 1, fired: 0 }));
    let recovered;
    try { recovered = await chat(childCid, [...currentChildMessages, { role: "assistant", content: "MOCK_RECOVERY_ACK" }, { role: "user", content: "CHILD_RECOVERY_CONTINUE" }]); assert.equal(JSON.parse(readFileSync(sqliteFault, "utf8")).fired, 1, "the one-shot fault must hit the actual candidate transcript renderer"); }
    finally { rmSync(sqliteFault, { force: true }); }
    assert.equal(recovered.status, 200, recovered.text); const recoveredDetail = await detail(childSnap.sessionId); assert(gateway.http.at(-1).decoded.includes(SUMMARY), "recovery wire must retain the active summary; block details=" + JSON.stringify(recoveredDetail.blockDetails) + "\n" + proxyLog().slice(-5000)); assert(gateway.http.at(-1).decoded.includes("CHILD_RECOVERY_CONTINUE"));
    const recoveryLines = await eventually(() => { const lines = proxyLog().slice(logStart).split(/\r?\n/).filter(line => line.includes("[snapshot-recovery]") && line.includes(childSnap.sessionId)); return lines.length ? lines : false; }, "real snapshot recovery log"); assert.equal(recoveryLines.length, 1, "one bounded recovery must run"); assert.match(recoveryLines[0], /re-prepared once.*rendered=true/);
    assert.equal(gateway.http.length, forwardedBefore + 1, "one client request must make exactly one real model send after recovery");
    assert.deepEqual(database(sessions, db => db.prepare("SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ? AND ref = ?").all(childSnap.sessionId, firstRef)), before.rows, "the fault must preserve original SQLite content and stable refs");
    const original = await json(active.port, `/__bili/sessions/${encodeURIComponent(childSnap.sessionId)}/message?ref=${encodeURIComponent(firstRef)}`); assert.equal(original.status, 200); assert(original.text.includes(firstRaw.slice(0, 60)));
    // Compare actual persisted stats after the real graceful flush; public
    // snapshot payload shapes differ across upstream and patched builds.
    await stopProxy(active, true);
    const afterRequests = database(sessions, db => JSON.parse(db.prepare("SELECT stats_json FROM sessions WHERE session_id = ?").get(childSnap.sessionId).stats_json).requests);
    assert.equal(afterRequests, before.count + 1, "re-preparation must not count a second persisted model request");
    await startProxy();
  });
  if (candidate.includes("biliRetentionApply")) await check("concurrent slow success credits its own image while failed-image and text-only requests cannot overwrite the receipt", async () => {
    const aUrl = imageUrl([210, 30, 20]), bUrl = imageUrl([20, 30, 210]), cUrl = imageUrl([20, 180, 60]);
    for (const [cid, successImage, failedImage] of [["e2e-image-race-fail", aUrl, bUrl], ["e2e-image-race-text", cUrl, undefined]]) {
      const path = "/hold-" + cid + "/v1/chat/completions", held = gateway.holdPath(path), count = gateway.http.length;
      const successfulMessages = historicalImageMessages(successImage, "SLOW_IMAGE_" + cid), slow = chat(cid, successfulMessages, "off", randomUUID(), { path }).then(result => ({ result }), error => ({ error }));
      let other;
      try {
        await eventually(() => gateway.http.slice(count).some(record => record.path === path), "slow image request reached the actual gateway");
        other = failedImage
          ? await chat(cid, historicalImageMessages(failedImage, "FAILED_IMAGE_" + cid), "off", randomUUID(), { path: "/fail-reset/v1/chat/completions" })
          : await chat(cid, [{ role: "user", content: "TEXT_ONLY_INTERLEAVED: an independent text-only request while the image reply is held." }]);
        assert.equal(other.status, failedImage ? 502 : 200, other.text);
      } finally { held.release(); }
      const completed = await slow; if (completed.error) throw completed.error; assert.equal(completed.result.status, 200, completed.result.text);
      if (failedImage) { const retry = await chat(cid, historicalImageMessages(failedImage, "FAILED_IMAGE_" + cid)); assert.equal(retry.status, 200, retry.text); assert(gateway.http.at(-1).decoded.includes(failedImage), "a failed request's image must remain unseen until its own healthy retry succeeds"); }
      const continued = await chat(cid, [...successfulMessages, { role: "assistant", content: "MOCK_IMAGE_RACE_ACK" }, { role: "user", content: "IMAGE_RACE_CONTINUE" }]); assert.equal(continued.status, 200, continued.text);
      const wire = gateway.http.at(-1).decoded.toString(); assert(!wire.includes(successImage), "the slow successful request's image must be credited despite a concurrent request"); assert.match(wire, /已看过/, "continuation must carry a recoverable image placeholder");
    }
  }); else skip("concurrent image retention receipts", "candidate has no custom image-retention pass");
  if (candidate.includes("biliRetentionApply")) await imageOutboundChecks(); else skip("final-body and real loop image receipts", "candidate has no custom image-retention pass");
  await check("repeated connection failures remain Chinese 502 and healthy retry succeeds", async () => {
    for (let i = 0; i < 4; i++) {
      const result = await chat("e2e-failure", [{ role: "user", content: "local reset retry " + i }], "off", randomUUID(), { path: "/fail-reset/v1/chat/completions" });
      assert.equal(result.status, 502, result.text); const error = modelError(result); assert.match(error.message ?? "", /[\u4e00-\u9fff]/, result.text); assert(!/(acp-proxy failure|circuit open)/i.test(error.message ?? "")); assert.equal(result.headers["retry-after"], undefined); assert(error.detail || error.upstreamFailure, result.text);
    }
    const result = await chat("e2e-failure", [{ role: "user", content: "retry using the healthy local gateway" }]); assert.equal(result.status, 200, result.text);
  });
  await check("irreducible preflight and actual side-request overflow remain Chinese 413 without model sends", async () => {
    const start = gateway.http.length;
    const result = await chat("e2e-oversized", [{ role: "system", content: "irreducible system ".repeat(500) }, { role: "user", content: "tiny window" }], "off", randomUUID(), { model: "mock-tiny", headers: { "x-bili-plugin-model": "mock-tiny", "x-bili-plugin-context-window": "128", "x-bili-plugin-max-output": "16" } });
    assert.equal(result.status, 413, result.text); const error = modelError(result); assert.match(error.message, /[\u4e00-\u9fff]/); assert.equal(error.retryable, false); assert.equal(result.headers["retry-after"], undefined); assert(error.detail);
    assert.equal(gateway.http.length, start);
    const headers = { ...pluginHeaders("e2e-side-request-oversized"), "x-bili-plugin-model": "mock-side", "x-bili-plugin-context-window": "1024", "x-bili-plugin-max-output": "128" };
    delete headers["x-bili-plugin-agent"];
    const side = { model: "mock-side", max_tokens: 128, stream: false, messages: [] };
    for (let i = 0; i < 4; i++) side.messages.push({ role: i % 2 ? "assistant" : "user", content: `SIDE_HISTORY_${i}: ` + "s".repeat(2048) });
    side.messages.push({ role: "user", content: "SIDE_TITLE_REQUEST: derive a brief label from the prior history." });
    assert.equal(side.tools, undefined);
    const refusal = await json(active.port, `/bili/${gateway.origin}/v1/chat/completions`, side, headers), sideError = refusal.body.error;
    assert.equal(refusal.status, 413, refusal.text); assert.equal(refusal.headers["retry-after"], undefined); assert.equal(sideError?.type, "server_error"); assert.equal(sideError.code, "side_request_payload_too_large"); assert.equal(sideError.retryable, false);
    assert.match(sideError.message, /[\u4e00-\u9fff]/); assert(sideError.message.length <= 64);
    const original = /^side request payload ~(\d+) tokens reaches the effective context window (\d+) \(model=mock-side\); NOT forwarded — side requests bypass compression by design \(#388\)\. Shrink the conversation or raise the model's context window\.$/.exec(sideError.detail);
    assert(original, "the actual side guard must preserve the complete original detail: " + refusal.text); assert(Number(original[1]) > Number(original[2])); assert(Number(original[2]) > 0 && Number(original[2]) <= 1024);
    assert.equal(gateway.http.length, start, "side-request rejection must add no model sends");
    console.log(`  side request evidence: no tools, max_tokens=128, estimate=${original[1]}, effective window=${original[2]}, HTTP413 and zero model sends`);
  });
  await ingressChecks();
  await wsIngressChecks();
  if (hasKvMigration) await storageChecks(); else skip("isolated legacy, shadow and full storage mode fallbacks", "candidate predates the unified KV carriers");
  }
  assert.deepEqual(gateway.errors, []);
  assert.equal(createHash("sha256").update(readFileSync(entry)).digest("hex"), candidateHash, "candidate index changed during the E2E run");
  if (nativeHash) assert.equal(createHash("sha256").update(readFileSync(nativeEntry)).digest("hex"), nativeHash, "candidate native bundle changed during the E2E run");
  assert(!existsSync(egressLog) || readFileSync(egressLog, "utf8") === "", "external egress was attempted; test guard withheld it");
  console.log(`e2e mock ${nativeOnly ? "native-only " : storageOnly ? "storage-only " : ""}checks passed (${checks.length}); skipped=${skipped.length}; gateway HTTP=${gateway.http.length} WS=${gateway.ws.length}`);
} catch (error) {
  console.error(`e2e mock FAILED after ${checks.length} checks: ${error.stack ?? error}`);
  if (active) console.error("candidate log tail:\n" + active.stderr.slice(-16000));
  const logs = [...new Set([...processes].map(run => run.context.privateLog))];
  for (const path of logs) if (existsSync(path)) console.error("isolated private log tail (" + path + "):\n" + readFileSync(path, "utf8").slice(-16000));
  process.exitCode = 1;
} finally {
  for (const client of clients) { try { client.close(); client.terminate?.(); } catch {} }
  for (const run of auxiliary) { try { await stopAuxiliary(run); } catch (error) { console.error("native child cleanup failed:", error); process.exitCode = 1; } }
  for (const run of processes) { try { await stopProxy(run); } catch (error) { console.error("cleanup failed:", error); process.exitCode = 1; } }
  try { if (gateway) await gateway.close(); }
  catch (error) { console.error("gateway cleanup failed:", error); process.exitCode = 1; }
  finally { rmSync(root, { recursive: true, force: true }); }
  console.log("e2e mock cleanup: candidate children exited, localhost sockets closed, isolated files removed");
}
