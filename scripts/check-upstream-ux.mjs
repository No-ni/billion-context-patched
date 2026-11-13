#!/usr/bin/env node
// Execute B19–B21 on the candidate that ships: HTTP errors, both stream error
// shapes, the real loop adapters, legal terminal handling, the SSE-to-WS sink
// and the merged client.
// No user database, browser, gateway or model is contacted.
//
//   node scripts/check-upstream-ux.mjs [dist/index.js] [lib/client.js]
//                                      [dist/agent/dsh-native.js]
//
// The merged client is optional while install.mjs stages the proxy candidate;
// check-wrapper supplies it once the complete package exists.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { BANNER_MARKERS, patchBiliClientBundle, uniqueBlockSpan } from "./patch-bili-client.mjs";
import { NATIVE_WS_HEADERS_MARKERS, patchBiliAgentBundle } from "./patch-bili-agent.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));

const expectAbsent = (text, needles, what) => {
  for (const needle of needles) {
    assert.equal(text.includes(needle), false, what + " still carries " + JSON.stringify(needle));
  }
};

const expectPresent = (text, needles, what) => {
  for (const needle of needles) {
    assert.equal(text.includes(needle), true, what + " is missing " + JSON.stringify(needle));
  }
};

// Match the declaration uniquely, then let V8 parse its complete expression.
// No dependency on whatever declaration upstream happens to put next.
const functionSource = (text, name) => {
  assert.match(name, /^[A-Za-z_$][\w$]*$/);
  const escapedName = name.replace(/\$/g, "\\$");
  const pattern = new RegExp("(?<![\\w$])(?:async\\s+)?function(?:\\s+|\\s*\\*\\s*)" + escapedName + "\\s*\\(", "g");
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, "expected one shipped function " + name + ", found " + matches.length);
  return uniqueBlockSpan(text, name, matches[0][0], { expression: true }).block;
};

const classSource = (text, name) => {
  assert.match(name, /^[A-Za-z_$][\w$]*$/);
  const pattern = new RegExp("\\b(?:var|let|const)\\s+" + name.replace(/\$/g, "\\$") + "\\s*=\\s*class\\b", "g");
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, "expected one shipped class " + name + ", found " + matches.length);
  return uniqueBlockSpan(text, name, matches[0][0]).block;
};

const assertExtractor = () => {
  const nested = [
    "function sample(value) {",
    '  const text = `${`${value} { }`}`;',
    "  // } is not the end of this function",
    "  return /[{}]/.test(text); /* } */",
    "}",
  ].join("\n");
  const input = nested + "\nfunction after() { return 0; }";
  assert.equal(functionSource(input, "sample"), nested);
  const sample = runInNewContext("(" + functionSource(input, "sample") + ")");
  assert.equal(sample("value"), true);
  const generator = "async function* sample$(value) { yield `${value} }`; }";
  assert.equal(functionSource(generator + "\n" + input, "sample$"), generator);
  assert.throws(() => functionSource(input + "\nfunction sample (value) { return value; }", "sample"), /expected one shipped function/);
  assert.throws(() => functionSource("function missing() { const text = `unfinished }`;", "missing"), /no complete block/);
};

const assertFailureResponses = (text) => {
  const names = ["__biliFailureTextZh", "upstreamFailureOf", "withUpstreamFailure", "buildProxyFailureResponse"];
  const api = runInNewContext(names.map(name => functionSource(text, name)).join("\n") +
    "\n({ say: __biliFailureTextZh, mark: withUpstreamFailure, build: buildProxyFailureResponse });", {
    UPSTREAM_FAILURE: Symbol("upstreamFailure"),
  });
  const labels = [
    ["connect-timeout", "连接超时，三次握手没有完成", "ETIMEDOUT"],
    ["connect-refused", "拒绝连接", "ECONNREFUSED"],
    ["dns", "域名解析失败", "ENOTFOUND"],
    ["tls", "TLS 握手失败", "CERT_HAS_EXPIRED"],
    ["proxy-reset", "连接被中间代理掐断", "ECONNRESET"],
    ["upstream-reset", "连接被上游掐断", "ECONNRESET"],
    ["upstream-unreachable", "网络不可达", "ENETUNREACH"],
    ["upstream-timeout", "响应超时，一直等不到数据", "UND_ERR_BODY_TIMEOUT"],
    ["upstream-headers-timeout", "迟迟没有返回第一个字节", "UPSTREAM_FIRST_BYTE_TIMEOUT"],
    ["unknown", "连接失败", "EUNKNOWN"],
    ["unheard-of", "请求失败", "ENEW"],
  ];
  const detail = "proxy request failed: original English diagnostics";
  for (const [kind, label, code] of labels) {
    const uf = { kind, code, host: "api.example.com", hint: "original upstream hint" };
    const expected = "api.example.com " + label + " [" + code + "]——dsh 会自动重试";
    assert.equal(api.say(detail, uf), expected);
    const response = api.build(detail, api.mark(new Error(detail), uf));
    const body = JSON.parse(response.body);
    assert.equal(response.status, 502);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["retry-after"], undefined);
    assert.equal(body.error, expected);
    assert.equal(body.detail, detail);
    assert.deepEqual(body.upstreamFailure, uf);
    assert.equal(body.error.includes(detail), false);
  }
  assert.equal(api.say(detail, { kind: "connect-refused" }), "上游端点 拒绝连接——dsh 会自动重试");
  assert.equal(api.say(detail, { kind: "client-abort", host: "api.example.com" }), "api.example.com：请求被本机取消了");
  assert.equal(api.say(detail, undefined), "bili 代理请求失败，详情见日志");
  assert.equal(api.say(detail, {}), "上游端点 请求失败——dsh 会自动重试");
  assert.equal(api.say(detail, { kind: 4, code: null, host: "" }), "上游端点 请求失败——dsh 会自动重试");
  for (const [message, status] of [[detail, 502], ["request body exceeds the endpoint limit", 413]]) {
    const response = api.build(message, new Error(message));
    const body = JSON.parse(response.body);
    assert.equal(response.status, status);
    assert.equal(response.headers["retry-after"], undefined);
    assert.equal(body.detail, message);
    assert.equal(body.upstreamFailure, undefined);
    if (status === 413) assert.match(body.error, /^请求体太大/);
    else assert.equal(body.error, "bili 代理请求失败，详情见日志");
  }
  // A legacy annotation must not reintroduce a circuit response on an upgrade.
  const legacy = api.build(detail, api.mark(new Error(detail), {
    kind: "connect-timeout", circuitOpen: true, retryAfterSeconds: 60,
  }));
  assert.equal(legacy.status, 502);
  assert.equal(legacy.headers["retry-after"], undefined);
  assert.deepEqual(JSON.parse(legacy.body).upstreamFailure, { kind: "connect-timeout" });
  console.log("  OK shipped HTTP errors preserve Chinese, original detail and 413/502 without a circuit response");
};

class CaptureResponse {
  headers = {};
  chunks = [];
  endCalls = 0;
  writableEnded = false;
  constructor(throwOnWrite = false) { this.throwOnWrite = throwOnWrite; }
  write(chunk) {
    if (this.throwOnWrite) throw new Error("closed response");
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.endCalls++;
    this.writableEnded = true;
  }
}

const sseFrames = (body) => body.replace(/\r\n|\r/g, "\n").split("\n\n").flatMap(block => {
  const lines = block.split("\n");
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return [];
  const frame = JSON.parse(data), event = lines.find(line => line.startsWith("event:"));
  if (event) assert.equal(frame.type, event.slice(6).trim(), "SSE event and payload type must agree");
  return [frame];
});

const visibleText = (value) => {
  const parts = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      if (["detail", "meta", "upstreamFailure"].includes(key)) continue;
      if (typeof item === "string" && ["message", "text", "delta", "content"].includes(key)) parts.push(item);
      else visit(item);
    }
  };
  visit(value);
  return parts.join("\n");
};

const hasDetail = (value, detail) => {
  if (Array.isArray(value)) return value.some(item => hasDetail(item, detail));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => key === "detail" && item === detail || hasDetail(item, detail));
};

const assertStreamResponses = (text) => {
  const names = ["__biliFailureTextZh", "__biliStreamErrorInfo", "safeWrite", "nativeErrorChunk", "legacyCompletionChunk", "emitStreamError", "emitUpstreamTruncation"];
  const api = runInNewContext(names.map(name => functionSource(text, name)).join("\n") +
    "\n({ __biliStreamErrorInfo, emitStreamError, emitUpstreamTruncation });");
  const detail = "upstream HTTP 502: original English gateway diagnostics";
  const info = api.__biliStreamErrorInfo(detail);
  assert.match(info.message, /[\u4e00-\u9fff]/);
  assert.equal(info.message.includes(detail), false);
  assert.equal(info.detail, detail);
  for (const protocol of ["openai", "responses", "anthropic", "google"]) {
    for (const shape of ["protocol", "completion"]) {
      const res = new CaptureResponse(), logs = [];
      api.emitStreamError(res, protocol, detail, message => logs.push(message), shape);
      const body = res.chunks.join(""), frames = sseFrames(body), visible = visibleText(frames);
      assert.match(visible, /[\u4e00-\u9fff]/, protocol + " " + shape + " needs a Chinese visible error");
      expectAbsent(visible, [detail, "acp-proxy:", "upstream HTTP"], protocol + " " + shape + " visible error");
      assert(hasDetail(frames, detail), protocol + " " + shape + " lost original detail");
      assert(logs.some(line => line.includes(detail)), "stream diagnostics must remain in the log");
      assert.equal(res.endCalls, 1);
      assert.equal(res.headers["retry-after"], undefined);
      if (shape === "protocol" || protocol === "google") {
        const error = frames[0].error ?? frames[0];
        assert.equal(error.code, protocol === "google" ? 502 : "stream_error");
        assert.equal(error.detail, detail);
      }
      if (protocol === "openai") assert.match(body, /data: \[DONE\]\n\n$/);
      else if (protocol === "responses") {
        assert.equal(frames.at(-1).type, shape === "protocol" ? "error" : "response.completed");
      } else if (protocol === "anthropic") {
        assert.equal(frames.at(-1).type, shape === "protocol" ? "error" : "message_stop");
      }
    }
    const closed = new CaptureResponse(true);
    api.emitStreamError(closed, protocol, detail);
    assert.equal(closed.endCalls, 1, "write failure must still end the response");

    const diag = { classification: "transport", cause: "remote-close", code: "ECONNRESET" };
    const res = new CaptureResponse();
    api.emitUpstreamTruncation(res, protocol, false, undefined, diag);
    const error = sseFrames(res.chunks.join(""))[0];
    const payload = error.error ?? error;
    assert.match(payload.message, /[\u4e00-\u9fff]/);
    assert.deepEqual(payload.meta, diag);
    assert.equal(payload.code, protocol === "google" ? 502 : "upstream_stream_truncated");
    assert.equal(res.endCalls, 1);
    const transparent = new CaptureResponse();
    api.emitUpstreamTruncation(transparent, protocol, false, undefined, diag, true);
    assert.equal(transparent.chunks.length, 0, "transparent streams keep host truncation handling");
    assert.equal(transparent.endCalls, 1);
  }
  for (const protocol of ["openai", "anthropic", "google"]) {
    const res = new CaptureResponse();
    api.emitUpstreamTruncation(res, protocol, true);
    const frames = sseFrames(res.chunks.join(""));
    assert.equal(visibleText(frames), "", "a delivered finish reason needs no visible failure");
    if (protocol === "openai") assert.equal(res.chunks.join(""), "data: [DONE]\n\n");
    else if (protocol === "anthropic") assert.equal(frames.at(-1).type, "message_stop");
    else assert.equal(res.chunks.length, 0);
    assert.equal(res.endCalls, 1);
  }
  console.log("  OK four stream protocols keep Chinese/detail, both error shapes and legal terminal handling");
};

// Construct the complete shipped factories, including their own builders and
// closure state. Parsing and request-building methods stay idle, so no model,
// filter, database or transport stand-in determines these error bytes.
const assertLoopAdapterErrors = (text) => {
  const names = ["__biliFailureTextZh", "__biliStreamErrorInfo", "sseFrame",
    "createOpenaiAdapter", "createAnthropicAdapter", "createResponsesAdapter", "createGoogleAdapter"];
  const api = runInNewContext(names.map(name => functionSource(text, name)).join("\n") +
    "\n({ createOpenaiAdapter, createAnthropicAdapter, createResponsesAdapter, createGoogleAdapter });", { Buffer });
  const diagnostics = [
    "upstream stream truncated (upstream stream error: original English diagnostics; round 2, 9 text chars + 0 reasoning chars received)",
    "compression committed; the follow-up request to the model failed (connection reset) before any response — original English diagnostics",
    "上游返回错误 502 after 2 attempt(s)：original English diagnostics",
    "上游返回错误 502：响应体为空；original English diagnostics",
  ];
  const factories = [
    ["openai", "protocol", () => api.createOpenaiAdapter({ model: "mock" })],
    ["openai", "completion", () => api.createOpenaiAdapter({ model: "mock" }, undefined, undefined, undefined, "completion")],
    ["anthropic", "protocol", () => api.createAnthropicAdapter({ model: "mock" })],
    ["anthropic", "completion", () => api.createAnthropicAdapter({ model: "mock" }, undefined, undefined, "completion")],
    ["responses", "protocol", () => api.createResponsesAdapter()],
    ["google", "protocol", () => api.createGoogleAdapter({ model: "mock" })],
  ];
  for (const [protocol, shape, create] of factories) {
    for (const detail of diagnostics) {
      const adapter = create(), label = protocol + " loop " + shape;
      for (const call of [0, 1]) {
        const wire = adapter.emitError(detail);
        assert(Buffer.isBuffer(wire), label + " must keep the loop's Buffer contract");
        const body = wire.toString("utf8"), frames = sseFrames(body), visible = visibleText(frames);
        assert.match(visible, /[\u4e00-\u9fff]/, label + " needs a Chinese visible error");
        expectAbsent(visible, [detail, "original English diagnostics", "acp-proxy:", "after 2 attempt(s)"], label + " visible error");
        assert(hasDetail(frames, detail), label + " lost the original loop diagnostic");
        if (protocol === "openai") {
          assert.match(body, /data: \[DONE\]\n\n$/);
          if (shape === "protocol") {
            assert.equal(frames.length, 1);
            assert.equal(frames[0].error.code, "upstream_error");
            assert.equal(frames[0].error.type, "server_error");
            assert.equal(frames[0].error.detail, detail);
            assert.equal(frames[0].choices, undefined, "native loop errors must preserve the client's failure channel");
          } else {
            assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
            assert.equal(frames.at(-1).choices[0].delta.content, undefined);
          }
        } else if (protocol === "anthropic") {
          assert.equal(frames.filter(frame => frame.type === "message_start").length, call === 0 ? 1 : 0,
            "loop errors must create a missing message once");
          if (call === 0) {
            assert.equal(frames[0].message.role, "assistant");
            assert.equal(frames[0].message.model, "mock");
          }
          if (shape === "protocol") {
            assert.match(body, /event: error\ndata: /);
            assert.equal(frames.at(-1).type, "error");
            assert.equal(frames.at(-1).error.code, "upstream_error");
            assert.equal(frames.at(-1).error.type, "server_error");
            assert.equal(frames.at(-1).error.detail, detail);
            assert.equal(frames.some(frame => frame.type === "message_stop"), false,
              "native loop errors must not acquire a success terminal");
          } else {
            assert.equal(frames.at(-1).type, "message_stop");
            assert.equal(frames.at(-2).delta.stop_reason, "end_turn");
            const start = frames.find(frame => frame.type === "content_block_start");
            const stop = frames.find(frame => frame.type === "content_block_stop");
            assert(start && stop, "completion errors must close their text block");
            assert.equal(start.index, stop.index);
          }
        } else if (protocol === "responses") {
          assert.match(body, /event: response.failed\ndata: /);
          assert.equal(frames.filter(frame => frame.type === "response.created").length, call === 0 ? 1 : 0,
            "loop errors must create a missing response once");
          assert.equal(frames.at(-1).type, "response.failed");
          assert.equal(frames.at(-1).response.status, "failed");
          assert.equal(frames.at(-1).response.error.code, "server_error");
          assert.equal(frames.at(-1).response.error.detail, detail);
          if (call === 0) assert.equal(frames[0].response.id, frames.at(-1).response.id);
          assert.equal(frames.some(frame => frame.type === "response.completed"), false);
        } else {
          assert.equal(frames.length, 1);
          assert.equal(frames[0].error.code, 500);
          assert.equal(frames[0].error.status, "INTERNAL");
          assert.equal(frames[0].error.detail, detail);
          assert.equal(frames[0].candidates, undefined);
        }
      }
    }
  }
  // Responses has a separate locally synthesized failure in emitCompletion.
  // It is already terminal, so the WS sink forwards it without a fallback.
  const missing = api.createResponsesAdapter();
  for (const call of [0, 1]) {
    const frames = sseFrames(missing.emitCompletion({ finishReason: "failed" }).toString("utf8"));
    assert.equal(frames.filter(frame => frame.type === "response.created").length, call === 0 ? 1 : 0);
    assert.equal(frames.at(-1).type, "response.failed");
    assert.equal(frames.at(-1).response.status, "failed");
    assert.equal(frames.at(-1).response.error.code, "server_error");
    assert.match(visibleText(frames), /[\u4e00-\u9fff]/);
    expectAbsent(visibleText(frames), ["upstream returned no response"], "missing Responses terminal");
    assert.equal(frames.at(-1).response.error.detail, "upstream returned no response");
  }
  console.log("  OK the four shipped loop adapters hide raw diagnostics, retain detail and terminate protocol/completion errors correctly");
};

// The real candidate classes do the framing and lifecycle work. The only
// substitutes here are the HTTP base object, peer socket and receive budget.
const assertResponsesWsSink = (text) => {
  const output = classSource(text, "ResponsesWsOutput");
  const response = classSource(text, "ResponsesWsResponse");
  const predicates = [...new Set([...output.matchAll(/\b(object\d*)\(/g), ...response.matchAll(/\b(object\d*)\(/g)].map(match => match[1]))];
  const httpName = response.match(/extends\s+([\w$]+)\.ServerResponse/)?.[1];
  assert(httpName, "WS sink no longer extends the expected HTTP response base");
  const socketNames = [...new Set([...response.matchAll(/\b([\w$]+)\.OPEN\b/g)].map(match => match[1]))];
  assert(socketNames.length > 0, "WS sink has no recognizable open-peer guard");
  class ServerResponseStub extends EventEmitter {
    statusCode = 200;
    destroyed = false;
    destroy() { this.destroyed = true; return this; }
  }
  const names = ["__biliFailureTextZh", "__biliStreamErrorInfo", "errorFrame", "normalizeSseLineEndings", "finalizeSseLineEndings",
    "createResponsesAdapter", ...predicates];
  const context = { Buffer, TextDecoder, Uint8Array, limitsReceiveBytes: () => 1024 * 1024,
    [httpName]: { ServerResponse: ServerResponseStub } };
  for (const name of socketNames) context[name] = { OPEN: 1 };
  const { Sink, createResponsesAdapter } = runInNewContext(names.map(name => functionSource(text, name)).join("\n") +
    "\n" + output + ";\n" + response + ";\n({ Sink: ResponsesWsResponse, createResponsesAdapter });", context);
  const fixture = (readyState = 1) => {
    const peer = { readyState, bufferedAmount: 0, frames: [], closes: [],
      send(data) { this.frames.push(JSON.parse(String(data))); },
      close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; } };
    const res = new Sink({ socket: {} }, peer);
    const events = { finish: 0, close: 0 };
    res.on("finish", () => events.finish++);
    res.on("close", () => events.close++);
    return { peer, res, events };
  };
  const detail = "original English HTTP failure diagnostics";
  for (const status of [413, 502]) {
    const { peer, res, events } = fixture();
    res.statusCode = status;
    const message = status === 413 ? "请求体太大，请减少历史或图片。" : "连接上游失败，DSH 会自动重试。";
    res.end(JSON.stringify({ error: message, detail,
      upstreamFailure: { kind: "connect-timeout", host: "api.example.com" } }));
    res.end();
    assert.equal(peer.frames.length, 1);
    const frame = peer.frames[0];
    assert.equal(frame.type, "error"); assert.equal(frame.status, status);
    assert.equal(frame.error.code, "proxy_failure");
    assert.equal(frame.error.message, message);
    assert.equal(frame.error.detail, detail);
    assert.deepEqual(frame.upstreamFailure, { kind: "connect-timeout", host: "api.example.com" });
    assert.deepEqual(events, { finish: 1, close: 1 });
    assert.equal(res.writableEnded, true);
  }
  for (const status of [401, 429]) {
    const { peer, res } = fixture();
    res.statusCode = status;
    const error = { type: "server_error", code: "upstream_rejected", message: "上游拒绝请求", detail };
    res.end(JSON.stringify({ error }));
    assert.deepEqual(peer.frames[0].error, error, "an already structured error must keep its protocol fields");
    assert.equal(peer.frames[0].status, status, "real upstream HTTP statuses keep their forwarding semantics");
  }
  const incomplete = fixture();
  incomplete.res.end();
  assert.equal(incomplete.peer.frames.length, 1);
  assert.equal(incomplete.peer.frames[0].error.code, "incomplete_response");
  assert.equal(incomplete.peer.frames[0].status, 502);
  assert.match(incomplete.peer.frames[0].error.message, /[\u4e00-\u9fff]/);
  assert(hasDetail(incomplete.peer.frames[0], "Responses exchange ended without a terminal event"));

  for (const type of ["response.completed", "response.failed", "response.incomplete", "error"]) {
    const { peer, res, events } = fixture();
    const frame = type === "response.completed" ? { type, response: { id: "r1", output: [] } }
      : { type, error: { message: "本轮结束", detail } };
    // A final lone CR must be finalized at end(), including terminal frames.
    const wire = Buffer.from("event: " + type + "\r\ndata: " + JSON.stringify(frame) + "\r\n\r");
    res.write(wire.subarray(0, 13)); res.write(wire.subarray(13)); res.end();
    assert.deepEqual(peer.frames, [frame], "terminal SSE must not acquire an extra WS error");
    assert.equal(res.terminal, true);
    assert.deepEqual(events, { finish: 1, close: 1 });
  }
  const accumulated = fixture();
  accumulated.res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"m1","content":[]}}\n\n');
  accumulated.res.write('data: {"type":"response.completed","response":{"id":"r1","output":[]}}\n\n');
  accumulated.res.end();
  assert.equal(accumulated.res.response.output.length, 1);
  assert.equal(accumulated.res.restoredOutputItems, 1);
  assert.equal(accumulated.peer.frames.length, 2);

  for (const completion of [false, true]) {
    const { peer, res, events } = fixture(), adapter = createResponsesAdapter();
    const diagnostic = completion ? "upstream returned no response" : detail;
    const wire = completion ? adapter.emitCompletion({ finishReason: "failed" }) : adapter.emitError(diagnostic);
    const split = wire.findIndex(byte => byte >= 0xe0) + 1;
    assert(split > 0, "the adapter must supply a Chinese message before the WS sink");
    // Split inside a real Chinese UTF-8 code point, then finalize the stream.
    res.write(wire.subarray(0, split)); res.write(wire.subarray(split)); res.end();
    assert.equal(peer.frames.length, 2, "a loop failure must not acquire a third WS fallback frame");
    assert.equal(peer.frames[0].type, "response.created");
    assert.equal(peer.frames[1].type, "response.failed");
    assert.equal(peer.frames[1].response.status, "failed");
    assert.equal(peer.frames[1].response.error.detail, diagnostic);
    assert.match(visibleText(peer.frames), /[\u4e00-\u9fff]/);
    expectAbsent(visibleText(peer.frames), [diagnostic, "acp-proxy:"], "loop-to-WS visible error");
    assert.equal(res.terminal, true);
    assert.deepEqual(events, { finish: 1, close: 1 });
  }

  const closed = fixture(3); closed.res.end();
  assert.equal(closed.peer.frames.length, 0, "a closed peer receives no synthetic frame");
  const destroyed = fixture(3); destroyed.res.destroy(); destroyed.res.destroy(); destroyed.res.end();
  assert.deepEqual(destroyed.events, { finish: 1, close: 1 }, "destroy/end must not duplicate close or lose cancellation");
  const blocked = fixture(); blocked.peer.bufferedAmount = 2 * 1024 * 1024;
  blocked.res.write(""); blocked.res.end();
  assert.equal(blocked.peer.closes.length, 1);
  assert.equal(blocked.peer.closes[0].code, 1013);
  assert(Buffer.byteLength(blocked.peer.closes[0].reason) <= 123, "WS close reasons must fit the control-frame limit");
  assert.deepEqual(blocked.events, { finish: 1, close: 1 });
  console.log("  OK the shipped SSE-to-WS sink preserves wrapped errors, terminal frames and close/destroy semantics");
};

export const assertDistUpstreamUx = (distPath) => {
  const text = readFileSync(distPath, "latin1");
  expectAbsent(text, [
    "CIRCUIT_OPEN_AFTER", "circuitProbeCooldownMs", "MAX_CIRCUITS",
    "upstreamCircuitBlockReason", "upstreamCircuitLastFailureKind",
    "upstreamCircuitRetryAfterSeconds", "noteCircuitFailFastLog",
    "recordUpstreamCircuitFailure", "recordUpstreamCircuitSuccess",
    "getOpenUpstreamCircuits", "getUpstreamHealthReport", "/__bili/upstreams",
    "acp-proxy failure:", "circuit open", "retryAfterSeconds", "circuitOpen",
  ], "proxy build");
  expectPresent(text, [
    "__biliFailureTextZh", "__biliStreamErrorInfo", "classifyUpstreamFailure",
    "describeUpstreamFailure", "recordUpstreamAlert", "clearUpstreamAlertsForHost",
    "getUpstreamAlerts", 'result.includes("FAILED")',
  ], "proxy build");
  assertExtractor();
  assertFailureResponses(text);
  assertStreamResponses(text);
  assertLoopAdapterErrors(text);
  assertResponsesWsSink(text);
};

export const assertClientUpstreamUx = (clientPath) => {
  const text = readFileSync(clientPath, "utf8");
  expectAbsent(text, BANNER_MARKERS, "client bundle");
  expectPresent(text, ["连接 bili 失败"], "client bundle");
  assert.equal(patchBiliClientBundle(text).text, text, "published client is not the fully patched, idempotent result");
  // Derive the negative cases from the candidate, including a lone poll route
  // that the former two-marker 'already removed' test silently accepted.
  for (const marker of BANNER_MARKERS) {
    assert.throws(() => patchBiliClientBundle(text + "\nvoid " + JSON.stringify(marker) + ";\n"), /upstream banner/,
      "partial removal with " + marker + " must fail");
  }
  assert.throws(() => patchBiliClientBundle(text + '\nvoid ({"probe_error": "extra"});\n'), /exactly two locale/);
  const probes = [...text.matchAll(/"probe_error": ("(?:\\.|[^"\\])*")/g)];
  assert.equal(probes.length, 2, "published client must have exactly the two probe translations");
  const translations = probes.map(match => JSON.parse(match[1]));
  assert.deepEqual(translations, [
    "连接 bili 失败——最近一次连接错误（可复制用于反馈）：",
    "Failed to connect to bili — last connection error (copyable for reporting):",
  ]);
  assert.throws(() => patchBiliClientBundle(text.replace(probes[0][0], '"probe_error": 7')), /value must be a string/);
  const reversed = text.replace("var zh = {", "var __probeLocale = {").replace("var en = {", "var zh = {").replace("var __probeLocale = {", "var en = {");
  assert.throws(() => patchBiliClientBundle(reversed), /ordered locale/);
  assert.throws(() => patchBiliClientBundle(text + "\nvoid ("), /does not parse/);

  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const render = runInNewContext(functionSource(text, "renderProbeError") + "\nrenderProbeError;", {
    import_react: { createElement }, ACTION_BTN_STYLE: {},
  });
  const detail = "TypeError: Failed to fetch https://api.example.com";
  let copied = 0;
  const t = key => ({ probe_error: translations[0], copy: "复制", copied: "已复制" })[key];
  const box = render(t, detail, false, () => copied++);
  assert.equal(box.children[0].children[0], translations[0]);
  assert.equal(box.children[1].type, "code");
  assert.equal(box.children[1].children[0], detail);
  const button = box.children[2];
  assert.equal(button.type, "button"); assert.equal(button.props.title, detail);
  assert.equal(button.children[0], "复制"); button.props.onClick(); assert.equal(copied, 1);
  assert.equal(render(t, detail, true, () => {}).children[2].children[0], "已复制");
  console.log("  OK the client removes every banner/poll surface, rejects partial patches and keeps copyable diagnostics");
};

export const assertAgentUpstreamUx = (agentPath) => {
  const text = readFileSync(agentPath, "utf8");
  expectPresent(text, NATIVE_WS_HEADERS_MARKERS, "native agent bundle");
  assert.equal(patchBiliAgentBundle(text).text, text, "published native agent is not the idempotent patched result");
  const source = functionSource(text, "mergeWsInitHeaders");
  const merge = runInNewContext("(" + source + ")", { Headers });
  const stamps = Object.freeze({ "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "child",
    "x-bili-plugin-model": "mock-model", "x-bili-plugin-context-window": "1000000" });
  const hostRecord = { "X-Bili-Plugin-Conversation": "stale-host", "X-BILI-PLUGIN": "stale-plugin",
    "X-Bili-Plugin-Model": "stale-model", "Session-Id": "host-session", authorization: "Bearer local-test" };
  const tupleHeaders = [...Object.entries(hostRecord), ["x-bili-plugin-conversation", "stale-duplicate"],
    ["X-Trace", "first"], ["x-trace", "second"]];
  const frozenTuples = Object.freeze(tupleHeaders.map(pair => Object.freeze([...pair])));
  const protocols = Object.freeze(["proto-one", "proto-two"]);
  const fixtures = [
    ["object", Object.freeze({ ...hostRecord })],
    ["tuples", frozenTuples],
    ["Headers", new Headers(tupleHeaders)],
  ];
  for (const [shape, headers] of fixtures) {
    const before = [...new Headers(headers)], init = Object.freeze({ headers, protocols, keepAlive: true });
    const next = merge(init, stamps), merged = new Headers(next.headers);
    assert.notEqual(next, init);
    assert.notEqual(next.headers, headers, "identity stamping must rebuild the host's header container");
    assert.equal(next.protocols, protocols); assert.equal(next.keepAlive, true);
    assert.deepEqual([...new Headers(headers)], before, "identity stamping changed host headers");
    for (const [name, value] of Object.entries(stamps)) {
      assert.equal(merged.get(name), value, shape + " retained a conflicting host identity");
      assert.equal([...merged.keys()].filter(key => key.toLowerCase() === name).length, 1);
    }
    assert.equal(merged.get("session-id"), "host-session");
    assert.equal(merged.get("authorization"), "Bearer local-test");
    if (shape !== "object") assert.equal(merged.get("x-trace"), "first, second");
    assert.equal(next.headers instanceof Headers, shape === "Headers");
    assert.equal(Array.isArray(next.headers), shape === "tuples");
  }
  for (const arg of [undefined, null, "proto-one", protocols, {}, { headers: undefined }, { headers: null }]) {
    const merged = merge(arg, stamps);
    assert.deepEqual(Object.fromEntries(new Headers(merged.headers)), { ...stamps });
    if (typeof arg === "string" || Array.isArray(arg)) assert.equal(merged.protocols, arg);
  }
  const unsupported = [true, 7, () => {}, { headers: true }, { headers: 7 }, { headers: "unsupported" }];
  for (const arg of unsupported) assert.equal(merge(arg, stamps), arg, "unknown constructor forms must keep the original passthrough");
  for (const arg of [...unsupported, ...fixtures.map(([, headers]) => ({ headers })), protocols, "proto", undefined, null]) {
    assert.equal(merge(arg, undefined), arg); assert.equal(merge(arg, {}), arg);
  }
  assert.throws(() => patchBiliAgentBundle(text.replace(NATIVE_WS_HEADERS_MARKERS[1], "// broken marker")), /markers/);
  assert.throws(() => patchBiliAgentBundle(text + "\n" + NATIVE_WS_HEADERS_MARKERS[0]), /markers/);
  assert.throws(() => patchBiliAgentBundle(text + "\nfunction mergeWsInitHeaders (arg, extra) { return arg; }"), /expected one/);
  assert.throws(() => patchBiliAgentBundle(text.replace(source, source.replace("headers.set(key, value)", "headers.append(key, value)"))), /changed or reordered/);
  console.log("  OK the shipped native helper replaces mixed-case/tuple stamps, preserves host init and rejects partial patches");
};

export const assertUpstreamUx = (distPath, clientPath, agentPath) => {
  assertDistUpstreamUx(distPath);
  if (clientPath !== undefined) assertClientUpstreamUx(clientPath);
  if (agentPath !== undefined) assertAgentUpstreamUx(agentPath);
};

if (process.argv[1] !== void 0 && process.argv[1].endsWith("check-upstream-ux.mjs")) {
  const dist = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");
  const client = process.argv[3];
  const agent = process.argv[4];
  assertUpstreamUx(dist, client, agent);
  console.log("upstream ux checks passed");
}
