// Execute complete shipped WS session/history/transport classes. Only peer,
// upstream socket and supplier responses are isolated; no network is opened.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { runInNewContext } from "node:vm";
import { uniqueBlockSpan } from "../patch-bili-client.mjs";

export async function assertResponsesWsLocalErrors(source) {
  const classes = ["ResponsesWsHistory", "ResponsesWsUpstream", "ResponsesWsSession"]
    .map(name => uniqueBlockSpan(source, name, "var " + name + "=class{").block);
  const classText = classes.join("\n");
  const predicates = [...new Set([...classText.matchAll(/\b(object\d*)\(/g)].map(match => match[1]))];
  const names = [...predicates, "errorFrame", "unsupportedTransportOptions", "describeEventType",
    "connectionNamedHeaders", "bodyToText", "isHandshakeRefusal", "releaseUpstreamWatchdog",
    "finalizeResponsesWsUpstreamHeaders", "stripRemoteCompactionBetaFeature", "isAzureOpenAiHost", "canonical", "closeCode",
    "__biliStreamErrorInfo"];
  const upstreamSocketName = classes[1].match(/new ([\w$.]+)\(wsUrl,/)?.[1];
  const httpName = classes[2].match(/new ([\w$.]+)\.IncomingMessage\(/)?.[1];
  const peerSocketNames = [...new Set([...classes[2].matchAll(/peer\.readyState===([\w$.]+)\.OPEN/g)].map(match => match[1]))];
  assert(upstreamSocketName && httpName && peerSocketNames.length, "actual WS constructor/module seams");
  const budget = 1024 * 1024, outbound = [], releases = [];
  let upstreamMode = "incomplete";
  class RefusingSocket extends EventEmitter {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0;
    constructor() { super(); queueMicrotask(() => this.emit("error", { type: "error" })); }
    addEventListener(name, listener) { this.on(name, listener); }
    removeEventListener(name, listener) { this.off(name, listener); }
    close() { this.readyState = 3; }
  }
  const context = { Buffer, URL, Headers, Response, TextDecoder, TextEncoder, ReadableStream, DOMException, AbortController,
    limitsReceiveBytes: () => budget, featureEnabled: () => true, getStore: () => undefined,
    UPSTREAM_HOP_HEADERS: new Set(["connection", "keep-alive", "host", "upgrade", "content-length", "transfer-encoding"]),
    BILI_HOP_HEADER: "x-bili-hop", BILI_TUNNEL_HEADER: "x-bili-tunnel",
    fetchWithTimeout: async (url, init) => {
      outbound.push({ url, body: JSON.parse(init.body) });
      if (upstreamMode === "network-failure") throw new TypeError("fetch failed");
      const body = 'event: response.created\ndata: {"type":"response.created","response":{"id":"mock-prewarm","status":"in_progress","output":[]}}\n\n';
      return { response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        clearTimer: () => releases.push(upstreamMode) };
    },
  };
  const setSymbol = (name, value) => {
    const parts = name.split("."); let cursor = context;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
    cursor[parts.at(-1)] = value;
  };
  for (const name of peerSocketNames) setSymbol(name, { OPEN: 1 });
  setSymbol(upstreamSocketName, RefusingSocket); setSymbol(httpName, http);
  const functions = names.map(name => uniqueBlockSpan(source, name, "function " + name + "(", { expression: true }).block).join("\n");
  const api = runInNewContext(functions + "\n" + classText +
    ";\n({Session:ResponsesWsSession,errorFrame});", context);
  const active = new Set();
  const fixture = () => {
    const peer = { readyState: 1, frames: [], bufferedAmount: 0,
      send(frame) { this.frames.push(JSON.parse(String(frame))); }, close() { this.readyState = 3; } };
    const session = new api.Session({ peer, source: { headers: {}, socket: {}, url: "/bili/https://mock.invalid/v1/responses" },
      upstreamUrl: "https://mock.invalid/v1/responses", codec: { allowStreamFlag: true }, log() {},
      dispatch: async () => assert.fail("local refusal must not enter the model pipeline") });
    active.add(session); return { session, peer };
  };
  const error = (frame, status, code, prefix) => {
    assert.equal(frame.type, "error"); assert.equal(frame.status, status);
    assert.equal(frame.error.code, code); assert.equal(frame.error.type, "invalid_request_error");
    assert.match(frame.error.message, /[\u4e00-\u9fff]/);
    assert(!frame.error.message.includes(prefix)); assert(frame.error.detail.startsWith(prefix));
  };
  try {
    // Neither the saved prior turn nor the raw delta exceeds the cap. Only the
    // actual History.expand result exceeds admission, before upstream dispatch.
    const sample = fixture();
    sample.session.history.commit({ model: "mock", input: [{ role: "user", content: "A".repeat(900 * 1024) }], stream: true },
      { id: "prior", status: "completed", output: [] });
    const frame = { type: "response.create", model: "mock", previous_response_id: "prior",
      input: [{ role: "user", content: "B".repeat(200 * 1024) }], stream: true };
    const raw = Buffer.from(JSON.stringify(frame));
    assert(raw.length < budget); assert(Buffer.byteLength(JSON.stringify(sample.session.history.expand(frame))) > budget);
    sample.session.onMessage(raw, false);
    assert.equal(sample.peer.frames.length, 1); assert.equal(outbound.length, 0);
    error(sample.peer.frames[0], 413, "request_too_large", "response.create exceeds");
    // Protocol/identity/conflict failures retain their exact existing contract.
    for (const status of [400, 403, 409]) {
      assert.deepEqual(JSON.parse(api.errorFrame("contract", "original contract text", status)), {
        type: "error", status, error: { type: "invalid_request_error", code: "contract", message: "original contract text" },
      });
    }
    assert.equal(JSON.parse(api.errorFrame("default", "default text")).status, 400);
    sample.session.shutdown("mock-complete"); active.delete(sample.session);
    // generate:false prewarm is a transport probe, separate from the canonical
    // model turn. Execute actual handshake -> HTTP fallback and error framing.
    for (const [mode, prefix, code] of [["incomplete", "Warmup ended without a terminal event", "incomplete_response"],
      ["network-failure", "Probe relay failed", "invalid_request"]]) {
      upstreamMode = mode;
      const sample = fixture(), before = outbound.length;
      sample.session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "mock", input: [], generate: false, stream: true })), false);
      for (let n = 0; sample.session.busy && n < 100; n++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(sample.session.busy, false); assert.equal(outbound.length, before + 1);
      assert.equal(outbound.at(-1).body.generate, false);
      const frame = sample.peer.frames.find(frame => frame.type === "error"); assert(frame);
      error(frame, 502, code, prefix);
      sample.session.shutdown("mock-complete"); active.delete(sample.session);
    }
    assert.equal(releases.length, 1, "actual HTTP fallback watchdog releases");
  } finally {
    for (const session of active) session.shutdown("mock-cleanup");
  }
}
