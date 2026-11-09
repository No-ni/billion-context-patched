#!/usr/bin/env node
// Smoke-test a candidate build's request-compression path before it replaces a
// working one.
//
// Why this exists: the compression helper used to write its own content-length
// after shrinking the body. Node's fetch also sets one for a Buffer body, and on
// Node 24 the two collapse into a single "5, 5" value, which undici rejects with
// UND_ERR_INVALID_ARG before a byte leaves the machine - the caller sees it as a
// 502 from the local proxy. The helper no longer writes that header; this test
// proves it, on the Node that is about to run the proxy.
//
// Usage: node scripts/smoke.mjs [path/to/dist/index.js]
// Exit 0 means the build is safe to install. Anything else means leave the
// installed build alone.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(process.argv[2] ?? join(here, "..", "dist", "index.js"));
const FORBIDDEN = 'h["content-length"]=String(';
const fail = (message) => {
  console.error("smoke: FAILED - " + message);
  process.exit(1);
};

const source = readFileSync(distPath, "utf8");
if (source.includes(FORBIDDEN)) {
  fail(
    "this build still writes content-length itself (" +
      FORBIDDEN +
      "); fetch adds its own, and on Node 24 the pair becomes an invalid header",
  );
}
// A private HOME: the helper writes its encode log and reads the machine-wide
// "default encoding for requests without a directive" file from there. Giving it
// a temporary one keeps this test from touching the real log - and lets us set
// that default deliberately, because the retry case below only means something
// when a fallback exists to be wrongly applied.
const home = mkdtempSync(join(tmpdir(), "bili-smoke-"));
mkdirSync(join(home, ".local", "state", "billion-context"), { recursive: true });
writeFileSync(join(home, ".local", "state", "billion-context", "upstream-encoding"), "gzip\n");
process.env.HOME = home;
process.env.USERPROFILE = home;

const start = source.indexOf("var __biliEncZlib=");
const end = source.indexOf("async function fetchWithTimeout(");
if (start < 0 || end <= start) fail("cannot find the compression helpers in " + distPath);
const build = new Function("require", source.slice(start, end) + "\nreturn __biliEncodeOutbound;");
const encode = build(createRequire(distPath));

const seen = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    seen.push({ raw: request.rawHeaders, body: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";
const payload = JSON.stringify({ model: "smoke", messages: [{ role: "user", content: "压缩请求体".repeat(20000) }] });

const headerPairs = (raw, name) => {
  const found = [];
  for (let index = 0; index < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === name) found.push(String(raw[index + 1]));
  }
  return found;
};

let cases = 0;
for (const test of [
  { name: "uncompressed", directive: "off" },
  { name: "brotli", directive: "br" },
  { name: "gzip", directive: "gzip" },
]) {
  const opts = {
    method: "POST",
    headers: { "content-type": "application/json", "x-accel-compress": test.directive },
    body: Buffer.from(payload),
  };
  encode(opts, url);
  const wire = opts.body.length;
  const encoding = opts.headers["content-encoding"] ?? "";
  // A retry hands the same opts back to the helper; it must not compress twice.
  encode(opts, url);
  if (opts.body.length !== wire) fail(test.name + ": a second call compressed the body again");
  if ((opts.headers["content-encoding"] ?? "") !== encoding) fail(test.name + ": a second call changed content-encoding");
  if (opts.headers["x-accel-compress"] !== undefined) fail(test.name + ": the internal directive header was forwarded upstream");

  const before = seen.length;
  const response = await fetch(url, opts);
  if (!response.ok) fail(test.name + ": mock upstream answered " + response.status);
  if (seen.length !== before + 1) fail(test.name + ": the request never reached the mock upstream");
  const record = seen[seen.length - 1];

  const lengths = headerPairs(record.raw, "content-length");
  if (lengths.length !== 1) {
    fail(test.name + ": saw " + lengths.length + " content-length headers (" + lengths.join(" | ") + ")");
  }
  if (!/^[0-9]+$/.test(lengths[0])) fail(test.name + ": content-length is not a single number: " + JSON.stringify(lengths[0]));
  if (Number(lengths[0]) !== record.body.length) {
    fail(test.name + ": content-length says " + lengths[0] + " but " + record.body.length + " bytes arrived");
  }
  const sent = headerPairs(record.raw, "content-encoding")[0] ?? "";
  const decoded =
    sent === "br" ? brotliDecompressSync(record.body) : sent === "gzip" ? gunzipSync(record.body) : record.body;
  if (decoded.toString("utf8") !== payload) fail(test.name + ": the body did not survive the round trip");
  if (test.directive === "off" && sent !== "") fail(test.name + ": an uncompressed route still carried content-encoding");
  if (test.directive !== "off" && sent !== test.directive) {
    fail(test.name + ": expected content-encoding " + test.directive + ", saw " + JSON.stringify(sent));
  }
  cases += 1;
  const original = Buffer.byteLength(payload);
  console.log("  " + test.name.padEnd(13) + original + " -> " + record.body.length + " bytes on the wire");
}

server.close();
rmSync(home, { recursive: true, force: true });
const electron = process.versions.electron === undefined ? "" : " (Electron " + process.versions.electron + ")";
console.log("smoke: OK - " + cases + " cases on Node " + process.version + electron);
