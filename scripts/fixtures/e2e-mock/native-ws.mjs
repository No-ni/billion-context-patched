// Isolated child: import the candidate's complete DSH native bundle, arm its
// real apply()/interception hooks, and send actual localhost Responses frames.
// Only the host services/session metadata/ALS carrier are simulated here.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LocalWebSocket } from "./websocket.mjs";

const [candidatePath, inputPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const candidate = await import(pathToFileURL(candidatePath).href);
assert.equal(typeof candidate.installDshIntercepts, "function", "candidate must export the real DSH fetch/WS installer");
const hostScope = new AsyncLocalStorage(), rawSockets = new Set(), clients = new Set();
const fetchAnchor = globalThis.fetch, fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch"), wsDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
let constructions = 0, toolsSettled = false, releaseTools;
let bodyPreparations = 0, inheritedBeforeWire = false;
const model = "mock-model", provider = "e2e-local";
const childHost = { model, session: { id: input.childCid, header: { isSeeded: true, parentSession: input.parentCid }, requestHeader: () => ({ config: { provider, model: hostScope.getStore()?.model ?? model } }) } };
const otherHost = { model, session: { id: "e2e-native-other", header: {}, requestHeader: childHost.session.requestHeader } };
const ctx = {
  tools: { register() {} }, commands: { register() {} },
  agents: { currentInitiator: () => hostScope.getStore(), get: id => id === input.childCid ? childHost : undefined },
  on() {}, inject(_services, callback) { callback(this); },
};
class HeaderWebSocket extends LocalWebSocket {
  constructor(url, options) {
    assert(toolsSettled, "tools-ready must settle before the actual HTTP upgrade");
    const headers = Object.fromEntries(new Headers(options?.headers));
    assert.equal(headers["x-bili-plugin"], "dsh");
    assert.equal(headers["x-bili-plugin-conversation"], input.childCid);
    assert.equal(headers["x-bili-plugin-model"], model);
    assert.equal(headers["x-bili-plugin-context-window"], "1000000");
    super(url, options); rawSockets.add(this); constructions++;
  }
  close(code, reason) { this.requestedCloseCode = code; super.close(code, reason); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function eventOnce(client, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`native local WS ${type} timed out`)), timeout);
    const listener = event => finish(undefined, event), failed = event => finish(event.error ?? new Error("native WS error before " + type));
    const finish = (error, event) => { clearTimeout(timer); client.removeEventListener(type, listener); if (type !== "error") client.removeEventListener("error", failed); error ? reject(error) : resolve(event); };
    client.addEventListener(type, listener, { once: true }); if (type !== "error") client.addEventListener("error", failed, { once: true });
  });
}
function response(client, body, host = childHost) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("native local Responses exchange timed out")), 12000);
    const events = [], message = event => { let frame; try { frame = JSON.parse(String(event.data)); } catch { return; } events.push(frame); if (frame.type === "response.completed") finish(); else if (frame.type === "error" || frame.type === "response.failed") finish(new Error(JSON.stringify(frame))); };
    const failed = event => finish(event.error ?? new Error("native Responses error"));
    const finish = error => { clearTimeout(timer); client.removeEventListener("message", message); client.removeEventListener("error", failed); error ? reject(error) : resolve(events); };
    client.addEventListener("message", message); client.addEventListener("error", failed, { once: true });
    hostScope.run(host, () => { try { client.send(JSON.stringify(body)); } catch (error) { finish(error); } });
  });
}
function construct(shape = "object") {
  const base = { "session-id": input.childCid, "user-agent": "codex_cli_rs/native-e2e", authorization: "Bearer local-e2e-only", "X-Bili-Plugin-Conversation": "host-conflicting-stamp" };
  const headers = shape === "tuples" ? [...Object.entries(base), ["x-bili-plugin-conversation", "second-host-conflicting-stamp"]] : shape === "headers" ? new Headers(base) : base;
  const client = hostScope.run(childHost, () => new globalThis.WebSocket(input.upstreamWs, { headers }));
  clients.add(client); return client;
}
async function refuse(client, host, marker, reason) {
  // Observe the production error dispatch and requested application close code.
  // The exact echoed network close may be 1006 if the bridge half-closes first.
  const errored = eventOnce(client, "error"), closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.removeEventListener("close", listener); reject(new Error("native refusal close timed out")); }, 10000);
    const listener = event => { clearTimeout(timer); resolve(event); }; client.addEventListener("close", listener, { once: true });
  });
  const body = { ...input.body, model: host.model, input: [...input.body.input, { type: "message", role: "user", content: [{ type: "input_text", text: marker }] }] };
  hostScope.run(host, () => client.send(JSON.stringify(body)));
  const [errorEvent, closeEvent] = await Promise.all([errored, closed]);
  assert.match(errorEvent.error?.message ?? "", reason);
  const latest = [...rawSockets].at(-1); assert.equal(latest.requestedCloseCode, 4008);
  assert.equal(client.readyState, 3);
  return { message: errorEvent.error.message, requestedCode: latest.requestedCloseCode, networkCode: closeEvent.code };
}

let state, originalBeforeSend;
try {
  candidate._resetRegisterForTest(input.proxyOrigin, true);
  state = candidate._nativeStateForTest(); state.origin = input.proxyOrigin; state.ready = Promise.resolve(input.proxyOrigin); delete state.wsOrigin;
  await candidate.apply(ctx);
  candidate._setModelInfoForTest({ provider, model, contextWindow: 1000000 });
  candidate._setModelInfoForTest({ provider, model: "mock-model-next", contextWindow: 1000000 });
  state.toolsReady = new Promise(resolve => { releaseTools = () => { toolsSettled = true; resolve(); }; });
  originalBeforeSend = state.beforeSend; assert.equal(typeof originalBeforeSend, "function");
  state.beforeSend = async (url, init) => {
    await originalBeforeSend(url, init);
    if (typeof init?.body !== "string" || JSON.parse(init.body)?.type !== "response.create") return;
    bodyPreparations++;
    if (inheritedBeforeWire || hostScope.getStore()?.session.id !== input.childCid) return;
    const result = await fetchAnchor(input.proxyOrigin + "/__bili/plugin/snapshot?conversationId=" + encodeURIComponent(input.childCid));
    const snap = await result.json(); assert.equal(result.status, 200); assert.equal(snap.ok, true);
    assert.deepEqual(snap.orderedMessages.slice(0, input.inheritedRefs.length), input.inheritedRefs);
    const blocksResponse = await fetchAnchor(input.proxyOrigin + "/__bili/sessions/" + encodeURIComponent(snap.sessionId) + "/detail");
    const blocks = await blocksResponse.json(); assert(blocks.blockDetails.some(block => block.active && block.summary?.includes(input.summary)), "fork must be fully published before the first response.create is emitted");
    inheritedBeforeWire = true;
  };
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: HeaderWebSocket });
  candidate.installDshIntercepts(state);
  const first = construct(), opened = eventOnce(first, "open");
  await pause(70); assert.equal(constructions, 0, "deferred wrapper must wait for the real tools gate");
  releaseTools(); await opened;
  const initial = await response(first, input.body); assert(initial.some(frame => frame.type === "response.completed")); assert(inheritedBeforeWire);
  const continuation = { ...input.body, input: [...input.body.input, { type: "message", role: "assistant", content: [{ type: "output_text", text: initial.find(frame => frame.type === "response.completed").response.output[0].content[0].text }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "NATIVE_WS_CONTINUE_ALLOWED" }] }] };
  await response(first, continuation);
  const identity = await refuse(first, otherHost, "NATIVE_WS_IDENTITY_FORBIDDEN", /identity\/model changed/);
  const second = construct("tuples"); await eventOnce(second, "open");
  const modelChange = await refuse(second, { ...childHost, model: "mock-model-next" }, "NATIVE_WS_MODEL_FORBIDDEN", /identity\/model changed/);
  const third = construct("headers"); await eventOnce(third, "open");
  state.origin = input.proxyOrigin + "/changed";
  const originChange = await refuse(third, childHost, "NATIVE_WS_ORIGIN_FORBIDDEN", /state\/origin changed/);
  state.origin = input.proxyOrigin;
  console.log("NATIVE_WS_E2E " + JSON.stringify({ completeCandidateBundle: true, simulatedHostMetadata: true, toolsGateHeldUpgrade: true, inheritedBeforeWire, bodyPreparations, authoritativeHeaderShapes: ["object", "tuples", "Headers"], identity, modelChange, originChange }));
} finally {
  releaseTools?.();
  for (const client of clients) { try { client.close(); } catch {} }
  for (const client of rawSockets) { try { client.close(); client.terminate(); } catch {} }
  if (state && originalBeforeSend) state.beforeSend = originalBeforeSend;
  candidate._resetRegisterForTest(undefined, false);
  await candidate._settleNativeForTest();
  if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
  if (wsDescriptor) Object.defineProperty(globalThis, "WebSocket", wsDescriptor);
  delete globalThis[Symbol.for("billion-context.native-intercept.active-state")];
  delete globalThis[Symbol.for("billion-context.native-intercept.active-state-seq")];
}
