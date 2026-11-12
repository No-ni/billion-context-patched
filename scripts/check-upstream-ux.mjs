#!/usr/bin/env node
// B19 + B20 + B21, verified on a built artifact: the proxy no longer counts
// upstream failures behind the caller's back, the shell no longer renders a
// status panel for them, and a failed request reaches the transcript as one
// Chinese sentence.
//
//   node scripts/check-upstream-ux.mjs [dist/index.js] [lib/client.js]
//
// The first argument is the patched proxy build (what the smoke chain has just
// staged). The second is the merged client bundle, which only exists once a
// package is written, so it is optional and check-wrapper passes it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// The sentence the reader sees, rendered by the code that actually ships.
const failureText = (text) => {
  const from = text.indexOf("function __biliFailureTextZh(");
  assert.notEqual(from, -1, "proxy build has no __biliFailureTextZh");
  const to = text.indexOf("function buildProxyFailureResponse(", from);
  assert.notEqual(to, -1, "proxy build has no buildProxyFailureResponse after the failure text");
  return new Function("return " + text.slice(from, to))();
};

export const assertDistUpstreamUx = (distPath) => {
  const text = readFileSync(distPath, "latin1");
  expectAbsent(text, [
    "CIRCUIT_OPEN_AFTER",
    "circuitProbeCooldownMs",
    "upstreamCircuitBlockReason",
    "getUpstreamHealthReport",
    '"/__bili/upstreams"',
    "acp-proxy failure:",
    "circuit open",
    "retryAfterSeconds",
    "circuitOpen",
  ], "proxy build");
  expectPresent(text, [
    "__biliFailureTextZh",
    'errorField=__biliFailureTextZh(msg,uf)',
  ], "proxy build");

  const say = failureText(text);
  assert.equal(say("proxy request failed", { kind: "connect-timeout", code: "ETIMEDOUT", host: "api.example.com" }),
    "api.example.com 连接超时，三次握手没有完成 [ETIMEDOUT]——dsh 会自动重试");
  assert.equal(say("proxy request failed", { kind: "connect-refused" }),
    "上游端点 拒绝连接——dsh 会自动重试");
  assert.equal(say("proxy request failed", { kind: "client-abort", host: "api.example.com" }),
    "api.example.com：请求被本机取消了");
  assert.equal(say("proxy request failed", { kind: "unheard-of", host: "api.example.com" }),
    "api.example.com 请求失败——dsh 会自动重试");
  assert.match(say("request body exceeds the endpoint limit", {}), /^请求体太大/);
  // No upstream marker on the error at all: it may be a local failure, so it
  // must not be blamed on the upstream nor promise a retry dsh may not make.
  assert.equal(say("proxy request failed", undefined), "bili 代理请求失败，详情见日志");
  assert.equal(say("proxy request failed", {}), "上游端点 请求失败——dsh 会自动重试");
  console.log("  OK upstream failures arrive as one Chinese sentence, with no circuit breaker behind them");
};

export const assertClientUpstreamUx = (clientPath) => {
  const text = readFileSync(clientPath, "utf8");
  expectAbsent(text, [
    "bili-upstreams",
    "upstreams_down_one",
    "upstreams_down_many",
    "upstream_retry_hint",
    "parseUpstreamHealth",
    "upstreamBanner",
    "UPSTREAM_POLL_MS",
  ], "client bundle");
  expectPresent(text, ["连接 bili 失败"], "client bundle");
  console.log("  OK the client carries no upstream status panel");
};

export const assertUpstreamUx = (distPath, clientPath) => {
  assertDistUpstreamUx(distPath);
  if (clientPath !== undefined) assertClientUpstreamUx(clientPath);
};

if (process.argv[1] !== void 0 && process.argv[1].endsWith("check-upstream-ux.mjs")) {
  const dist = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");
  const client = process.argv[3];
  assertUpstreamUx(dist, client);
  console.log("upstream ux checks passed");
}
