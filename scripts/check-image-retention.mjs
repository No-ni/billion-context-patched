#!/usr/bin/env node
// Offline checks for the image retention pass and the image convention prompt.
// The pass is a pure request-body transform, so nothing here needs a model: the
// block is evaluated with stand-ins for the handful of dist helpers it calls and
// fed real wire bodies. Structural checks confirm the patched dist carries the
// same seams. The encoder backends (sips on macOS, PowerShell's System.Drawing
// on Windows, ImageMagick anywhere) are checked as pure functions plus one real
// shrink when the host has one; the Windows end-to-end path needs a Windows box
// and is skipped elsewhere. Usage: node scripts/check-image-retention.mjs [dist]
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deflateSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const distPath = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");

let failures = 0;
let checks = 0;
const ok = (name, cond, extra) => {
  checks++;
  if (cond) return;
  failures++;
  console.log("FAIL " + name + (extra === void 0 ? "" : " — " + extra));
};
const okEq = (name, value, expected) => ok(name, value === expected, "got " + JSON.stringify(value) + ", want " + JSON.stringify(expected));

// ── structural: the seams that the patch script owns ────────────────────────
const dist = readFileSync(distPath, "latin1");
ok("dist: helpers inserted", dist.includes("function biliRetentionApply("));
ok("dist: final wire reconciler inserted", dist.includes("function biliRetentionFinalize("));
ok("dist: retention runs before the shedder", dist.indexOf("await biliRetentionApply(wireBody,prepared.protocol") > 0);
ok("dist: retention runs before shedEgressIfOverBudget", dist.indexOf("await biliRetentionApply(wireBody,prepared.protocol") < dist.indexOf("const shed=await shedEgressIfOverBudget(wireBody,prepared.protocol"));
const initialFinalize = dist.indexOf("biliRetentionFinalize(wireBody,prepared.protocol,prepared.session,biliImageAttempt)");
const initialShed = dist.indexOf("const shed=await shedEgressIfOverBudget(wireBody,prepared.protocol");
const initialSign = dist.indexOf("applyResign(headers,wireBody)", initialShed);
ok("dist: final image accounting follows shedding and precedes signing", initialShed >= 0 && initialFinalize > initialShed && initialSign > initialFinalize);
ok("dist: commit hook passes its request receipt", dist.includes("biliRetentionCommit(inp&&inp.sessionId,inp&&inp.biliImageReceipt)"));
ok("dist: prompt seam (function builder)", dist.includes("+biliImageConventionText()}function buildCompressHybridSystemPrompt("));
ok("dist: prompt seam (hybrid builder)", dist.includes("+biliImageConventionText()}function createContentStore("));
ok("dist: config keys registered", dist.includes('"imageRetention","imageRetentionKeepLastUser","imageRetentionMaxDim","imagePrompt"'));
ok("dist: the image block sits between sentinels", dist.includes("// <bili-image-blocks begin>") && dist.includes("// <bili-image-blocks end>"));
ok("dist: the platform chooser is in", dist.includes("function biliRetentionBackendOrder("));
ok("dist: the Windows backend is in", dist.includes("Add-Type -AssemblyName System.Drawing") && dist.includes("HighQualityBicubic") && dist.includes("Format32bppArgb"));
ok("dist: the macOS-only helper is gone", !dist.includes("function biliRetentionSips("));

// ── the block under test ────────────────────────────────────────────────────
const blockText = readFileSync(join(here, "patches", "image-retention.block.js"), "utf8")
  + "\n" + readFileSync(join(here, "patches", "image-convention.block.js"), "utf8");
const publishedBlock = "// <bili-image-blocks begin>\n" + ["image-convention.block.js", "image-retention.block.js"]
  .map((file) => readFileSync(join(here, "patches", file), "utf8").replace(/\s+$/, "")).join("\n")
  + "\n// <bili-image-blocks end>";
ok("dist: image helpers match the checked sources", dist.includes(publishedBlock));

function decodePngOrJpegDims(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 24) return void 0;
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return void 0;
}

function parseDataUrlText(url) {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return m ? { mediaType: m[1], base64: m[2] } : void 0;
}

function makeApi(config, cfgState, overrides = {}) {
  const state = cfgState ?? { config: config ?? {} };
  const shims = {
    require,
    isObj4: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    loadConfigFile: () => state.config,
    hashContent: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    markDirty: () => {},
    tIntLoose: (name, fileValue) => {
      const raw = process.env[name];
      if (raw !== void 0 && raw !== "") return Number.parseInt(raw, 10);
      return typeof fileValue === "number" && Number.isFinite(fileValue) ? fileValue : NaN;
    },
    decodeImageDims: decodePngOrJpegDims,
    b64Bytes2: (b64) => Buffer.byteLength(b64, "base64"),
    dataUrl: (mt, b64) => "data:" + mt + ";base64," + b64,
    parseDataUrl: parseDataUrlText,
    // Match the upstream contract: even a fixture reference arrives async.
    refForItemBytes: async () => "m00042",
    READ_ORIGINAL_IMAGE_TOOL_NAME: "acp_read_original_image",
    retentionShrink: void 0,
    ...overrides
  };
  const body = blockText + "\nif (typeof retentionShrink === 'function') biliRetentionShrink = retentionShrink;\nreturn { biliRetentionApply, biliRetentionFinalize, biliRetentionCommit, biliRetentionNote, biliRetentionEnabled, biliImageConventionText, biliRetentionShrinkOne, biliRetentionShrink, biliRetentionMaxDim, biliRetentionBackendOrder, biliRetentionBackendSteps, biliRetentionBackends };";
  const fn = new Function(...Object.keys(shims), body);
  const api = fn(...Object.values(shims));
  api.state = state;
  api.fixtureForwards = new WeakMap;
  return api;
}

// Most fixtures model sequential retries in one forward. Explicit concurrent
// fixtures below use raw helpers and separate attempt objects, like relay.ts.
function fixtureForward(api, s) {
  let forward = api.fixtureForwards.get(s);
  if (forward === void 0) {
    forward = { attempt: {}, receipt: void 0 };
    api.fixtureForwards.set(s, forward);
  }
  return forward;
}

function applyRetention(api, body, protocol, s, ctx = {}) {
  const forward = fixtureForward(api, s);
  forward.receipt = void 0;
  return api.biliRetentionApply(body, protocol, s, { ...ctx, attempt: forward.attempt });
}

function finalizeRetention(api, body, protocol, s) {
  const forward = fixtureForward(api, s);
  forward.receipt = api.biliRetentionFinalize(body, protocol, s, forward.attempt);
  return forward.receipt;
}

// Extract complete function expressions with JavaScript's parser. In
// particular, the ref resolver's await/readFile path and the original-image
// tool must come from the candidate dist, rather than a synchronous mock.
function publishedFunction(name) {
  const matches = [...dist.matchAll(new RegExp("(?:async )?function " + name + "\\(", "g"))];
  if (matches.length !== 1) throw new Error("expected one published " + name + ", got " + matches.length);
  const start = matches[0].index;
  for (let end = dist.indexOf("}", start); end !== -1; end = dist.indexOf("}", end + 1)) {
    const source = dist.slice(start, end + 1);
    try {
      new Function("return (" + source + ");");
      return source;
    } catch {}
  }
  throw new Error("could not extract published " + name);
}

function successfulForward(api) {
  return new Function("biliRetentionCommit", "armInternal", "log",
    publishedFunction("noteSuccessfulForward") + "\nreturn noteSuccessfulForward;")(
    api.biliRetentionCommit, () => {}, () => {});
}

function commitForward(api, body, protocol, s) {
  const biliImageReceipt = finalizeRetention(api, body, protocol, s);
  successfulForward(api)({ sessionId: s.id, protocol, wireBody: body, biliImageReceipt });
}

function forwardSuccess(api, s, fields = {}) {
  successfulForward(api)({ ...fields, sessionId: s.id, biliImageReceipt: fixtureForward(api, s).receipt });
}

function publishedOriginalImageApi() {
  const refSource = publishedFunction("refForItemBytes");
  const readSource = publishedFunction("executeReadOriginalImage");
  const shims = {};
  // esbuild may renumber imported bindings when the upstream bundle changes.
  for (const source of [refSource, readSource]) {
    const reads = [...source.matchAll(/await (readFile\d*)\(/g)];
    if (reads.length === 0) throw new Error("published image helper has no filesystem read");
    for (const match of reads) shims[match[1]] = readFile;
  }
  const hashName = /([A-Za-z_$][\w$]*)\("sha256"\)\.update\(buf\)/.exec(readSource)?.[1];
  const patternName = /if\(!([A-Za-z_$][\w$]*)\.test\(ref\)\)/.exec(readSource)?.[1];
  const byteCounter = /const want=([A-Za-z_$][\w$]*)\(b64\)/.exec(refSource)?.[1];
  if (!hashName || !patternName || !byteCounter) throw new Error("published image helper dependencies changed");
  shims[hashName] = createHash;
  const pattern = new RegExp("var " + patternName + "=(/[^;]+/);", "g");
  const declarations = [...dist.matchAll(pattern)];
  if (declarations.length !== 1) throw new Error("expected one original-image ref pattern");
  shims[patternName] = new Function("return " + declarations[0][1])();
  const source = [publishedFunction(byteCounter), publishedFunction("formatKb"),
    publishedFunction("toolOk"), publishedFunction("toolFail"), refSource, readSource].join("\n");
  return new Function(...Object.keys(shims), source + "\nreturn {refForItemBytes, executeReadOriginalImage};")(
    ...Object.values(shims));
}

// ── fixtures ────────────────────────────────────────────────────────────────
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}
function makePng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 4;
      raw[p] = (x * 13 + y * 7) & 255;
      raw[p + 1] = (x * 3 + y * 11) & 255;
      raw[p + 2] = (x ^ y) & 255;
      raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]).toString("base64");
}

const smallPng = makePng(8, 8);
const otherPng = makePng(9, 8);
const bigPng = makePng(1500, 1000);
const session = () => ({ id: "s1", metadata: {} });
const imageHash = (b64) => createHash("sha256").update(b64, "utf8").digest("hex").slice(0, 32);
const nonImageData = Buffer.from("audio/video/PDF payload: keep these bytes").toString("base64");

function anthropicBody(b64, opts = {}) {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } };
  const messages = [
    { role: "user", content: "here it is" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [image] }
  ];
  if (opts.imageLast !== true) messages.push({ role: "user", content: "and now?" });
  if (opts.toolResult) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }] });
  }
  const body = { messages };
  if (opts.tools) body.tools = [{ name: "acp_read_original_image", input_schema: {} }];
  return body;
}

function googleToolBody(images = [smallPng], opts = {}) {
  return {
    contents: [
      { role: "user", parts: [{ text: "inspect the screenshot" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: opts.toolName ?? "capture", args: {} } }] },
      { role: "user", parts: [{ functionResponse: {
        id: "c1", name: opts.toolName ?? "capture",
        response: opts.response ?? { result: "captured", kept: { answer: 42 } },
        parts: [
          ...images.map((b64) => ({ inlineData: { mimeType: "image/png", data: b64 } })),
          ...(opts.keepOtherMedia ? [
            { inlineData: { mimeType: "audio/wav", data: nonImageData } },
            { inlineData: { mimeType: "video/mp4", data: nonImageData } },
            { inlineData: { mimeType: "application/pdf", data: nonImageData } },
            { fileData: { mimeType: "application/pdf", fileUri: "https://example.invalid/manual.pdf" } }
          ] : [])
        ]
      } }] }
    ],
    tools: [{ functionDeclarations: [
      { name: "unrelated" }, { name: "acp_read_original_image", parameters: { type: "object" } }
    ] }]
  };
}

// ── behaviour ───────────────────────────────────────────────────────────────
async function main() {
  // 1. a picture is folded only after it made it upstream once
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { tools: true }));
    const first = await applyRetention(api, body, "anthropic", s, {});
    ok("first sight is not folded", first.changed === false, JSON.stringify(first));
    ok("first sight is pending", (s.metadata.biliImageSeen ?? []).length === 0);
    commitForward(api, first.body, "anthropic", s);
    ok("commit records the look", (s.metadata.biliImageSeen ?? []).length >= 1);
    const second = await applyRetention(api, body, "anthropic", s, {});
    ok("second sight is folded", second.changed === true && second.folded === 1, JSON.stringify(second));
    ok("pixels are gone", second.body.indexOf("base64") === -1, second.body.slice(0, 200));
    ok("note keeps the ref", second.body.includes("m00042"));
    const foldedPart = JSON.parse(second.body).messages[2].content[0];
    ok("note is a text part", foldedPart.type === "text");
    ok("note offers the original", typeof foldedPart.text === "string" && foldedPart.text.includes('acp_read_original_image("m00042")'), foldedPart.text);
  }

  // 2. the upload the user is looking at is exempt
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { imageLast: true }));
    await applyRetention(api, body, "anthropic", s, {});
    commitForward(api, body, "anthropic", s);
    const again = await applyRetention(api, body, "anthropic", s, {});
    ok("fresh upload stays", again.changed === false, JSON.stringify(again));
  }

  // 3. with the exemption off, even the newest upload folds
  {
    const api = makeApi({ imageRetentionKeepLastUser: false });
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { imageLast: true }));
    await applyRetention(api, body, "anthropic", s, {});
    commitForward(api, body, "anthropic", s);
    const again = await applyRetention(api, body, "anthropic", s, {});
    ok("fresh upload folds when asked", again.folded === 1, JSON.stringify(again));
  }

  // 4. a screenshot returned by a tool folds like any other picture
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { toolResult: true }));
    await applyRetention(api, body, "anthropic", s, {});
    commitForward(api, body, "anthropic", s);
    const again = await applyRetention(api, body, "anthropic", s, {});
    ok("tool result folds", again.folded >= 1, JSON.stringify(again));
  }

  // 5. google: inlineData carries no "base64" substring at all
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: "look" }] },
        { role: "model", parts: [{ text: "ok" }] },
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: smallPng } }] },
        { role: "model", parts: [{ text: "seen" }] }
      ]
    });
    ok("google fixture has no base64 word", body.indexOf("base64") === -1);
    await applyRetention(api, body, "google", s, {});
    commitForward(api, body, "google", s);
    const again = await applyRetention(api, body, "google", s, {});
    ok("google folds", again.folded === 1, JSON.stringify(again));
    ok("google parts swapped", JSON.parse(again.body).contents.at(-2).parts[0].text.includes("[image:"));
  }

  // 6. openai chat: image_url
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + smallPng } }] },
        { role: "assistant", content: "seen" }
      ]
    });
    await applyRetention(api, body, "openai", s, {});
    commitForward(api, body, "openai", s);
    const again = await applyRetention(api, body, "openai", s, {});
    ok("openai folds", again.folded === 1, JSON.stringify(again));
  }

  // 7. responses: function_call_output carries the screenshot
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "look" }] },
        { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "data:image/png;base64," + smallPng }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "seen" }] }
      ]
    });
    await applyRetention(api, body, "responses", s, {});
    commitForward(api, body, "responses", s);
    const again = await applyRetention(api, body, "responses", s, {});
    ok("responses folds", again.folded === 1, JSON.stringify(again));
    ok("responses note is input_text", JSON.parse(again.body).input.at(-2).output[0].type === "input_text");
  }

  // 8. the off switch and the config file
  {
    const api = makeApi({ imageRetention: false });
    const s = session();
    ok("config off", api.biliRetentionEnabled() === false);
    const body = JSON.stringify(anthropicBody(smallPng));
    s.metadata.biliImageSeen = [createHash("sha256").update(smallPng, "utf8").digest("hex").slice(0, 32)];
    const res = await applyRetention(api, body, "anthropic", s, {});
    ok("config off is a no-op", res.changed === false && res.body === body);
  }

  // 9. the encoder backends: platform order and the exact command lines
  {
    const api = makeApi({});
    okEq("backends on macOS", JSON.stringify(api.biliRetentionBackendOrder("darwin")), JSON.stringify(["sips", "magick", "convert"]));
    okEq("backends on Windows", JSON.stringify(api.biliRetentionBackendOrder("win32")), JSON.stringify(["powershell", "magick", "convert"]));
    okEq("backends elsewhere", JSON.stringify(api.biliRetentionBackendOrder("linux")), JSON.stringify(["magick", "convert"]));
    okEq("backends on a freebsd box", JSON.stringify(api.biliRetentionBackendOrder("freebsd")), JSON.stringify(["magick", "convert"]));

    const sips = api.biliRetentionBackendSteps({ id: "sips", bin: "/usr/bin/sips" }, "/tmp/in.png", "/tmp", 1200);
    okEq("sips runs twice", sips.length, 2);
    ok("sips jpeg step bounds the long edge", sips[0].args.join(" ").startsWith("-Z 1200 -s format jpeg -s formatOptions 80 "));
    okEq("sips steps write jpeg then png", sips.map((step) => step.outs[0].mime).join(","), "image/jpeg,image/png");

    const ps = api.biliRetentionBackendSteps({ id: "powershell", bin: "C:\\Windows\\powershell.exe" }, "C:\\tmp\\in.png", "C:\\tmp", 1200);
    okEq("powershell runs once", ps.length, 1);
    okEq("powershell runs unattended", ps[0].args.slice(0, 2).join(" "), "-NoProfile -NonInteractive");
    const psScript = ps[0].args[3];
    ok("powershell decodes through System.Drawing", psScript.includes("Add-Type -AssemblyName System.Drawing"));
    ok("powershell honours maxDim", psScript.includes("$max=1200;"));
    ok("powershell only shrinks pixels", psScript.includes("[Math]::Min(1.0,$max/[Math]::Max($w,$h))"));
    ok("powershell flattens onto white", psScript.includes("$g.Clear([System.Drawing.Color]::White)"));
    ok("powershell saves a transparent png twin", psScript.includes("Format32bppArgb") && psScript.includes("$ga.Clear([System.Drawing.Color]::Transparent)") && psScript.includes("ImageFormat]::Png"));
    okEq("powershell writes both encodings", ps[0].outs.map((out) => out.mime).join(","), "image/jpeg,image/png");
    const quoted = api.biliRetentionBackendSteps({ id: "powershell", bin: "x" }, "C:\\O'Brien\\in.png", "C:\\t", 900);
    ok("powershell escapes apostrophes", quoted[0].args[3].includes("'C:\\O''Brien\\in.png'"), quoted[0].args[3].slice(0, 120));
    const quotedOut = api.biliRetentionBackendSteps({ id: "powershell", bin: "x" }, "/tmp/in.png", "/tmp/it's", 900);
    ok("powershell escapes output paths too", quotedOut[0].args[3].includes(join("/tmp", "it''s", "out.jpg")));

    const magick = api.biliRetentionBackendSteps({ id: "magick", bin: "magick" }, "/tmp/in.png", "/tmp", 1200);
    ok("magick only shrinks", magick[0].args.join(" ").includes("-resize 1200x1200>"));
    ok("magick keeps the quality", magick[0].args.join(" ").includes("-quality 80"));
    okEq("magick steps write jpeg then png", magick.map((step) => step.outs[0].mime).join(","), "image/jpeg,image/png");

    const tiny = await api.biliRetentionShrinkOne("image/png", smallPng, 1200);
    ok("small pixels are left alone", tiny === null, JSON.stringify(tiny));
    const unknown = await api.biliRetentionShrinkOne("image/webp", bigPng, 1200);
    ok("unknown encodings are left alone", unknown === null);
  }

  // 10. shrinking: oversized pixels leave smaller, and never above the ratio
  {
    const api = makeApi({});
    ok("max dim default", api.biliRetentionMaxDim() === 1200);
    const shrunk = await api.biliRetentionShrinkOne("image/png", bigPng, 1200);
    if (api.biliRetentionBackends().length === 0) {
      console.log("SKIP shrink (no encoder backend on this host)");
    } else {
      ok("available encoder must resize the fixture", shrunk !== null, JSON.stringify(api.biliRetentionBackends()));
    }
    if (shrunk !== null) {
      ok("shrink keeps the ratio", shrunk.bytes <= shrunk.origBytes * 0.8, shrunk.bytes + " vs " + shrunk.origBytes);
      ok("shrink bounds the long edge", Math.max(shrunk.width ?? 0, shrunk.height ?? 0) <= 1200, JSON.stringify([shrunk.width, shrunk.height]));
      ok("shrink returns a known mime", shrunk.mime === "image/jpeg" || shrunk.mime === "image/png", shrunk.mime);
      ok("shrink decodes back", decodePngOrJpegDims(shrunk.base64) !== void 0);
      if (process.platform === "darwin" || process.platform === "win32") {
        okEq("shrink used the platform backend", api.biliRetentionBackends()[0]?.id, process.platform === "darwin" ? "sips" : "powershell");
      }
      console.log("encoder: " + api.biliRetentionBackends()[0].id + " resized 1500x1000 to " + shrunk.width + "x" + shrunk.height + ", " + shrunk.origBytes + " -> " + shrunk.bytes + " bytes");
      api.state.config = { imageRetentionMaxDim: 1200 };
      const first = await api.biliRetentionShrink("image/png", bigPng);
      api.state.config = { imageRetentionMaxDim: 600 };
      const second = await api.biliRetentionShrink("image/png", bigPng);
      ok("updated maxDim takes effect for a cached image", first !== null && second !== null &&
        Math.max(first.width, first.height) === 1200 && Math.max(second.width, second.height) <= 600);
    }
    if (process.platform === "win32") {
      ok("Windows filesystem convert is not an encoder", !api.biliRetentionBackends().some((backend) =>
        /[\\/](?:System32|SysWOW64)[\\/]convert\.exe$/i.test(backend.bin)));
    }
  }

  // 11. the convention paragraph
  {
    const api = makeApi({});
    const text = api.biliImageConventionText();
    ok("convention starts on a new paragraph", text.startsWith("\n\n"));
    ok("convention names the cost", text.includes("图片有体积和重传成本"));
    ok("convention names the escape hatch", text.includes("acp_read_original_image"));
    ok("convention is stable between turns", api.biliImageConventionText() === text);
    const off = makeApi({ imagePrompt: false });
    ok("convention off", off.biliImageConventionText() === "");
  }

  // 12. Google inlineData is a media union, not necessarily an image.
  {
    let refCalls = 0;
    let shrinkCalls = 0;
    const api = makeApi({ imageRetentionKeepLastUser: false }, void 0, {
      refForItemBytes: async () => { refCalls++; return "m00042"; },
      retentionShrink: async () => { shrinkCalls++; return null; }
    });
    for (const mime of ["audio/wav", "audio/mpeg", "video/mp4", "application/pdf", "text/plain", ""]) {
      const s = session();
      const body = JSON.stringify({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: smallPng } }] }] });
      const first = await applyRetention(api, body, "google", s, {});
      ok("Google " + mime + " remains byte-exact on first send", first.body === body && !first.changed);
      commitForward(api, first.body, "google", s);
      okEq("Google " + mime + " never enters the image ledger", (s.metadata.biliImageSeen ?? []).length, 0);
      // Even identical payload bytes to a seen PNG must not fold another MIME.
      s.metadata.biliImageSeen = [imageHash(smallPng)];
      const seen = await applyRetention(api, body, "google", s, {});
      ok("Google " + mime + " cannot borrow an image sighting", seen.body === body && seen.folded === 0);
    }
    okEq("non-image Google data never queries an image reference", refCalls, 0);
    okEq("non-image Google data never reaches an encoder", shrinkCalls, 0);
    const s = session();
    const toolOnly = JSON.stringify(googleToolBody([], { keepOtherMedia: true }));
    const untouched = await applyRetention(api, toolOnly, "google", s, {});
    commitForward(api, untouched.body, "google", s);
    ok("non-image functionResponse media remains intact", !untouched.changed && untouched.body === toolOnly);
    okEq("non-image functionResponse media has no image ledger entry", (s.metadata.biliImageSeen ?? []).length, 0);
  }

  // 13. Missing Google MIME keeps the compatibility default; actual image
  // MIME matching is case-insensitive. Only a plain newest user is exempt.
  {
    const api = makeApi({});
    const s = session();
    const parsed = {
      contents: [{ role: "user", parts: [
        { inlineData: { data: smallPng } },
        { inlineData: { mimeType: "IMAGE/PNG", data: otherPng } }
      ] }],
      tools: [{ functionDeclarations: [{ name: "acp_read_original_image" }] }]
    };
    const body = JSON.stringify(parsed);
    const first = await applyRetention(api, body, "google", s, {});
    commitForward(api, first.body, "google", s);
    const fresh = await applyRetention(api, body, "google", s, {});
    ok("Google plain newest user upload is exempt", !fresh.changed && fresh.body === body);
    parsed.contents.push({ role: "model", parts: [{ text: "processed" }] });
    const old = await applyRetention(api, JSON.stringify(parsed), "google", s, {});
    okEq("Google absent and uppercase image MIME both fold", old.folded, 2);
    const text = JSON.parse(old.body).contents[0].parts.map((p) => p.text).join("\n");
    ok("Google default MIME still supplies a PNG note", text.includes("[image: png 8x8"));
    ok("Google functionDeclarations arms the original-image instruction", text.includes('acp_read_original_image("m00042")'));
    parsed.contents.pop();
    parsed.contents[0].parts.push({ functionResponse: { name: "capture", response: { result: "ok" } } });
    const toolTail = await applyRetention(api, JSON.stringify(parsed), "google", s, {});
    okEq("Google media accompanying a tool response is not upload-exempt", toolTail.folded, 2);
  }

  // 14. A real Google tool response gets its first look, then only its images
  // fold. FunctionResponse.parts must remain valid media parts, with text
  // carried by the response JSON and unrelated fields preserved.
  {
    const api = makeApi({});
    const s = session();
    const parsed = googleToolBody([smallPng], { keepOtherMedia: true });
    const before = parsed.contents.at(-1).parts[0].functionResponse;
    const body = JSON.stringify(parsed);
    const first = await applyRetention(api, body, "google", s, {});
    ok("Google tool image is preserved for its first look", !first.changed && first.body === body);
    finalizeRetention(api, first.body, "google", s);
    okEq("Google tool image has no seen entry before success", (s.metadata.biliImageSeen ?? []).length, 0);
    for (const failure of ["upstream rejection", "timeout", "connection failure"]) {
      const retry = await applyRetention(api, body, "google", s, {});
      finalizeRetention(api, retry.body, "google", s);
      ok("Google " + failure + " keeps its retry pixels", retry.folded === 0 && retry.body === body);
      okEq("Google " + failure + " records no look", (s.metadata.biliImageSeen ?? []).length, 0);
    }
    forwardSuccess(api, s, { wireBody: body, protocol: "google" });
    okEq("successful Google tool image records exactly one image", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
    const next = await applyRetention(api, body, "google", s, {});
    okEq("Google newest role=user functionResponse image folds", next.folded, 1);
    const after = JSON.parse(next.body).contents.at(-1).parts[0].functionResponse;
    okEq("Google folded tool keeps the call id", after.id, before.id);
    okEq("Google folded tool keeps the function name", after.name, before.name);
    okEq("Google folded tool keeps the original result", after.response.result, before.response.result);
    okEq("Google folded tool keeps unrelated JSON", JSON.stringify(after.response.kept), JSON.stringify(before.response.kept));
    okEq("Google folded tool keeps audio/video/PDF/file parts", JSON.stringify(after.parts), JSON.stringify(before.parts.slice(1)));
    ok("Google tool note sits in the JSON response", JSON.stringify(after.response).includes("[image: png 8x8 m00042"));
    ok("Google tool note offers the original-image tool", JSON.stringify(after.response).includes('acp_read_original_image(\\"m00042\\")'));
    ok("Google tool media array never contains a text part", after.parts.every((p) => typeof p.text !== "string"));
    okEq("Google original inbound body was not mutated", JSON.stringify(parsed), body);
  }

  // 15. Removing multiple nested media parts must not shift later image
  // targets or overwrite a caller-owned response field.
  {
    const api = makeApi({});
    const s = session();
    const response = { output: "original output", biliImageNotes: { callerOwned: true } };
    const body = JSON.stringify(googleToolBody([smallPng, otherPng, smallPng], { response }));
    const first = await applyRetention(api, body, "google", s, {});
    commitForward(api, first.body, "google", s);
    const next = await applyRetention(api, body, "google", s, {});
    okEq("all nested tool images fold after one success", next.folded, 3);
    const result = JSON.parse(next.body).contents.at(-1).parts[0].functionResponse;
    ok("empty Google functionResponse media list is removed", !Object.hasOwn(result, "parts"));
    ok("Google JSON output preserves its original text", result.response.output.startsWith(response.output + "\n"));
    ok("Google image notes reach its selected output", result.response.output.includes("acp_read_original_image(\"m00042\")"));
    okEq("caller-owned Google notes field is preserved", JSON.stringify(result.response.biliImageNotes), JSON.stringify(response.biliImageNotes));
    okEq("each removed Google image has a JSON note", (JSON.stringify(result.response).match(/\[image:/g) ?? []).length, 3);
  }

  // 16. No valid ref means no fold, including actual resolver ambiguity and
  // asynchronous errors. Shrinking the outbound copy is still allowed.
  {
    for (const [name, resolver] of [
      ["missing reference", async () => void 0],
      ["rejected reference query", async () => { throw new Error("read failed"); }],
      ["invalid reference value", async () => ({ ref: "m00042" })],
      ["invalid reference string", async () => "invalid-ref"],
      ["whitespace reference string", async () => " "]
    ]) {
      const api = makeApi({}, void 0, { refForItemBytes: resolver });
      const s = session();
      s.metadata.biliImageSeen = [imageHash(smallPng)];
      const body = JSON.stringify(googleToolBody());
      const kept = await applyRetention(api, body, "google", s, {});
      ok(name + " preserves recoverable pixels", !kept.changed && kept.body === body && kept.folded === 0);
    }
    const api = makeApi({}, void 0, {
      refForItemBytes: async () => void 0,
      retentionShrink: async () => ({ base64: smallPng, mime: "image/png" })
    });
    const s = session();
    const body = JSON.stringify(googleToolBody([bigPng]));
    const smaller = await applyRetention(api, body, "google", s, {});
    ok("missing ref still allows first-send resizing", smaller.shrunk === 1 && smaller.folded === 0);
    ok("missing-ref resize does not erase the inbound original", body.includes(bigPng));
  }

  // 17. Finalization accounts for the actual plaintext wire after shedding,
  // rather than marking every pre-shed occurrence as successfully seen.
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(googleToolBody([smallPng, otherPng]));
    await applyRetention(api, body, "google", s, {});
    successfulForward(api)({ sessionId: s.id, wireBody: body });
    okEq("an unfinalized attempt cannot promote staged pixels", (s.metadata.biliImageSeen ?? []).length, 0);
    await applyRetention(api, body, "google", s, {});
    const shed = JSON.parse(body);
    shed.contents.at(-1).parts[0].functionResponse.parts.shift();
    const finalWire = JSON.stringify(shed);
    finalizeRetention(api, finalWire, "google", s);
    okEq("finalization by itself is not a successful look", (s.metadata.biliImageSeen ?? []).length, 0);
    forwardSuccess(api, s, { wireBody: finalWire });
    okEq("only the post-shed surviving picture is seen", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(otherPng)]));
    const next = await applyRetention(api, body, "google", s, {});
    okEq("previously shed unseen pixels still get their first look", next.folded, 1);
    const images = JSON.parse(next.body).contents.at(-1).parts[0].functionResponse.parts;
    okEq("the shed original survives the next request", images[0].inlineData.data, smallPng);

    for (const [name, finalBody] of [
      ["all pictures shed", JSON.stringify(googleToolBody([]))],
      ["malformed final body", "{"],
      ["non-object final body", "[]"],
      ["unknown secondary pixel transform", JSON.stringify(googleToolBody([makePng(10, 8)]))]
    ]) {
      const isolated = makeApi({});
      const fresh = session();
      await applyRetention(isolated, body, "google", fresh, {});
      commitForward(isolated, finalBody, "google", fresh);
      okEq(name + " cannot credit the staged originals", (fresh.metadata.biliImageSeen ?? []).length, 0);
    }
    const isolated = makeApi({ imageRetentionKeepLastUser: false });
    const fresh = session();
    const stage = JSON.stringify({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: smallPng } }] }] });
    await applyRetention(isolated, stage, "google", fresh, {});
    const audioInstead = stage.replace("image/png", "audio/wav");
    commitForward(isolated, audioInstead, "google", fresh);
    okEq("same bytes under a final non-image MIME do not count as pixels", (fresh.metadata.biliImageSeen ?? []).length, 0);
    const compressedApi = makeApi({});
    const compressedSession = session();
    const staged = await applyRetention(compressedApi, stage, "google", compressedSession, {});
    finalizeRetention(compressedApi, staged.body, "google", compressedSession);
    forwardSuccess(compressedApi, compressedSession, { wireBody: gzipSync(staged.body) });
    okEq("encoding after plaintext finalization preserves successful image accounting", JSON.stringify(compressedSession.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
  }

  // 18. Each attempt replaces pending work, even when a later successful
  // attempt carries no images or the feature has just been disabled.
  {
    for (const disabled of [false, true]) {
      const api = makeApi({});
      const s = session();
      const imageBody = JSON.stringify(googleToolBody());
      const failed = await applyRetention(api, imageBody, "google", s, {});
      const failedReceipt = finalizeRetention(api, failed.body, "google", s);
      if (disabled) api.state.config = { imageRetention: false };
      const body = disabled ? imageBody : JSON.stringify({ contents: [{ role: "user", parts: [{ text: "no pixels" }] }] });
      const next = await applyRetention(api, body, "google", s, {});
      successfulForward(api)({ sessionId: s.id, biliImageReceipt: failedReceipt });
      okEq("new retry invalidates its predecessor receipt", (s.metadata.biliImageSeen ?? []).length, 0);
      commitForward(api, next.body, "google", s);
      okEq((disabled ? "disabled" : "text-only") + " attempt cannot commit a failed predecessor", (s.metadata.biliImageSeen ?? []).length, 0);
    }
    const api = makeApi({});
    const firstSession = session();
    const secondSession = { id: "s2", metadata: {} };
    const first = await applyRetention(api, JSON.stringify(googleToolBody()), "google", firstSession, {});
    const second = await applyRetention(api, JSON.stringify(googleToolBody([otherPng])), "google", secondSession, {});
    finalizeRetention(api, first.body, "google", firstSession);
    finalizeRetention(api, second.body, "google", secondSession);
    forwardSuccess(api, secondSession);
    okEq("successful attempts do not borrow another session's pending", (firstSession.metadata.biliImageSeen ?? []).length, 0);
    okEq("successful session commits only its own image", JSON.stringify(secondSession.metadata.biliImageSeen), JSON.stringify([imageHash(otherPng)]));
  }

  // 19. Exercise the published asynchronous resolver's filesystem path and
  // the published original-image tool, not a fixed fixture reference.
  {
    const upstream = publishedOriginalImageApi();
    const dir = await mkdtemp(join(tmpdir(), "bili-image-check-"));
    try {
      const originalPath = join(dir, "original.png");
      const otherPath = join(dir, "other-original.png");
      const decoyPath = join(dir, "same-size-decoy.png");
      const largePath = join(dir, "large-original.png");
      const bytes = Buffer.from(smallPng, "base64");
      const decoy = Buffer.from(bytes);
      decoy[decoy.length - 1] ^= 1;
      await writeFile(originalPath, bytes);
      await writeFile(otherPath, Buffer.from(otherPng, "base64"));
      await writeFile(decoyPath, decoy);
      await writeFile(largePath, Buffer.from(bigPng, "base64"));
      const entry = (path) => ({ path, mediaType: "image/png", bytes: bytes.length, width: 8, height: 8 });
      const s = session();
      s.incomingImageIndex = new Map([
        ["m00041", [entry(decoyPath)]], ["m00042", [entry(originalPath)]]
      ]);
      const api = makeApi({}, void 0, { refForItemBytes: upstream.refForItemBytes });
      const body = JSON.stringify(googleToolBody());
      const first = await applyRetention(api, body, "google", s, {});
      commitForward(api, first.body, "google", s);
      const second = await applyRetention(api, body, "google", s, {});
      const response = JSON.parse(second.body).contents.at(-1).parts[0].functionResponse.response;
      const note = Object.values(response).flatMap((v) => Array.isArray(v) ? v : [])
        .find((v) => typeof v === "string" && v.includes("[image: "));
      const ref = /acp_read_original_image\("([^"]+)"\)/.exec(note ?? "")?.[1];
      okEq("published async resolver matches exact bytes among equal-sized originals", ref, "m00042");
      ok("published async ref never renders a Promise", !second.body.includes("[object Promise]"));
      const restored = await upstream.executeReadOriginalImage({ ref }, s, () => {});
      okEq("published original-image tool succeeds for the folded ref", restored.outcome, "success");
      okEq("published original-image tool returns the original bytes", restored.image?.base64, smallPng);
      okEq("published original-image tool keeps the original MIME", restored.image?.mediaType, "image/png");
      ok("published tool receipt identifies the actual original digest", restored.text.includes(
        "Billion original image receipt v1 sha256=" + createHash("sha256").update(bytes).digest("hex")));
      okEq("retention never rewrites the original file", (await readFile(originalPath)).toString("base64"), smallPng);

      const readSession = { id: "restored", metadata: {}, incomingImageIndex: s.incomingImageIndex };
      const readApi = makeApi({}, void 0, { refForItemBytes: upstream.refForItemBytes });
      const receiptBody = JSON.stringify(googleToolBody([restored.image.base64], {
        toolName: "acp_read_original_image", response: { result: restored.text }
      }));
      const receiptFirst = await applyRetention(readApi, receiptBody, "google", readSession, {});
      ok("original-image tool receipt gets its first unsighted look", !receiptFirst.changed && receiptFirst.body === receiptBody);
      commitForward(readApi, receiptFirst.body, "google", readSession);
      const receiptNext = await applyRetention(readApi, receiptBody, "google", readSession, {});
      okEq("original-image name and receipt do not create a permanent exemption", receiptNext.folded, 1);
      okEq("folding keeps the original-image receipt text", JSON.parse(receiptNext.body).contents.at(-1).parts[0].functionResponse.response.result, restored.text);

      for (const [name, index] of [
        ["no incoming image index", void 0],
        ["ambiguous duplicate originals", new Map([["m00042", [entry(originalPath)]], ["m00043", [entry(originalPath)]]])],
        ["evicted originals", new Map([["m00042", [entry(join(dir, "missing-a.png"))]], ["m00043", [entry(join(dir, "missing-b.png"))]]])]
      ]) {
        const missing = { id: name, metadata: { biliImageSeen: [imageHash(smallPng)] }, incomingImageIndex: index };
        const isolated = makeApi({}, void 0, { refForItemBytes: upstream.refForItemBytes });
        const kept = await applyRetention(isolated, body, "google", missing, {});
        ok("published resolver " + name + " retains pixels", kept.body === body && kept.folded === 0);
      }

      const large = { id: "large", metadata: {}, incomingImageIndex: new Map([["m00044", [{
        path: largePath, mediaType: "image/png", bytes: Buffer.byteLength(bigPng, "base64"), width: 1500, height: 1000
      }]]]) };
      const resizedApi = makeApi({}, void 0, {
        refForItemBytes: upstream.refForItemBytes,
        retentionShrink: async () => ({ base64: smallPng, mime: "image/png" })
      });
      const largeBody = JSON.stringify(googleToolBody([bigPng]));
      const resized = await applyRetention(resizedApi, largeBody, "google", large, {});
      okEq("outbound-only shrink changes the carrier", resized.shrunk, 1);
      commitForward(resizedApi, resized.body, "google", large);
      const folded = await applyRetention(resizedApi, largeBody, "google", large, {});
      ok("resized original keeps its original dimensions and ref", folded.body.includes("png 1500x1000 m00044"));
      const fullResolution = await upstream.executeReadOriginalImage({ ref: "m00044" }, large, () => {});
      okEq("original-image tool retrieves byte-exact full resolution after resizing", fullResolution.image?.base64, bigPng);

      // The actual async resolver can yield while another forward in this
      // SAME session prepares/sends. Both pending work and finalized receipts
      // must remain attached to the request that owns them.
      for (const timing of ["awaiting-ref", "awaiting-success"]) {
        for (const textOnlyB of [false, true]) {
          const shared = { id: timing + String(textOnlyB), metadata: {}, incomingImageIndex: new Map([
            ["m00042", [entry(originalPath)]], ["m00045", [{ path: otherPath, mediaType: "image/png",
              bytes: Buffer.byteLength(otherPng, "base64"), width: 9, height: 8 }]]
          ]) };
          let unblockA;
          let enteredA;
          const blockedA = new Promise((resolve) => { unblockA = resolve; });
          const entered = new Promise((resolve) => { enteredA = resolve; });
          let pauseA = timing === "awaiting-ref";
          const concurrent = makeApi({}, void 0, { refForItemBytes: async (owner, mime, b64) => {
            if (pauseA && b64 === smallPng) {
              pauseA = false;
              enteredA();
              await blockedA;
            }
            return upstream.refForItemBytes(owner, mime, b64);
          } });
          const attemptA = {};
          const attemptB = {};
          const runningA = concurrent.biliRetentionApply(body, "google", shared, { attempt: attemptA });
          let sentA;
          let receiptA;
          if (timing === "awaiting-ref") await entered;
          else {
            sentA = await runningA;
            receiptA = concurrent.biliRetentionFinalize(sentA.body, "google", shared, attemptA);
          }
          const bodyB = textOnlyB ? JSON.stringify({ contents: [{ role: "user", parts: [{ text: "no picture" }] }] })
            : JSON.stringify(googleToolBody([otherPng]));
          const sentB = await concurrent.biliRetentionApply(bodyB, "google", shared, { attempt: attemptB });
          const receiptB = concurrent.biliRetentionFinalize(sentB.body, "google", shared, attemptB);
          if (textOnlyB) successfulForward(concurrent)({ sessionId: shared.id, biliImageReceipt: receiptB });
          okEq(timing + " B cannot credit slow A before A succeeds", (shared.metadata.biliImageSeen ?? []).length, 0);
          if (timing === "awaiting-ref") {
            unblockA();
            sentA = await runningA;
            receiptA = concurrent.biliRetentionFinalize(sentA.body, "google", shared, attemptA);
          }
          successfulForward(concurrent)({ sessionId: shared.id, biliImageReceipt: receiptA });
          okEq(timing + (textOnlyB ? " text-only B" : " failed image B") + " cannot overwrite A receipt",
            JSON.stringify(shared.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
          const firstLookB = await concurrent.biliRetentionApply(JSON.stringify(googleToolBody([otherPng])), "google", shared, { attempt: {} });
          okEq(timing + " failed/absent B pixels still get their first look", firstLookB.folded, 0);
          const seenA = await concurrent.biliRetentionApply(body, "google", shared, { attempt: {} });
          okEq(timing + " successful A folds using its real original ref", seenA.folded, 1);
          ok(timing + " successful A note names its original", seenA.body.includes("m00042"));
        }
      }
    } finally {
      const tempRoot = resolve(tmpdir()) + sep;
      if (!resolve(dir).startsWith(tempRoot) || !basename(dir).startsWith("bili-image-check-")) {
        throw new Error("refusing image fixture cleanup outside its temporary directory");
      }
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 20. Retrying an outbound variant keeps its original identity without a
  // second resize. Identity aliases alone never count as a successful look.
  {
    let encodes = 0;
    const api = makeApi({}, void 0, { retentionShrink: async (_mime, b64) => {
      encodes++;
      return { base64: b64 === bigPng ? smallPng : otherPng, mime: "image/png" };
    } });
    const s = session();
    const body = JSON.stringify(googleToolBody([bigPng]));
    const first = await applyRetention(api, body, "google", s, {});
    const failedReceipt = finalizeRetention(api, first.body, "google", s);
    okEq("failed resized first attempt has no seen ledger", (s.metadata.biliImageSeen ?? []).length, 0);
    const retry = await applyRetention(api, first.body, "google", s, {});
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: failedReceipt });
    okEq("resized retry invalidates its failed predecessor receipt", (s.metadata.biliImageSeen ?? []).length, 0);
    ok("variant retry carries its existing pixels", !retry.changed && retry.body === first.body && retry.folded === 0);
    okEq("variant retry is not resized a second time", encodes, 1);
    commitForward(api, retry.body, "google", s);
    okEq("successful resized retry records original and wire hashes", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(bigPng), imageHash(smallPng)]));
    const next = await applyRetention(api, body, "google", s, {});
    okEq("original folds after a successful variant retry", next.folded, 1);
    okEq("seen original folds before any further resize", encodes, 1);

    const otherSession = { id: "different-session", metadata: {} };
    const foreign = await applyRetention(api, first.body, "google", otherSession, {});
    okEq("a different session cannot borrow the variant identity", foreign.shrunk, 1);
    okEq("a different session has no borrowed seen ledger", (otherSession.metadata.biliImageSeen ?? []).length, 0);

    for (const change of ["maxDim", "MIME"]) {
      let calls = 0;
      const isolated = makeApi({}, void 0, { retentionShrink: async (mime, b64) => {
        calls++;
        return { base64: b64 === bigPng ? smallPng : otherPng, mime };
      } });
      const fresh = session();
      const first = await applyRetention(isolated, body, "google", fresh, {});
      finalizeRetention(isolated, first.body, "google", fresh);
      const changed = JSON.parse(first.body);
      if (change === "maxDim") isolated.state.config = { imageRetentionMaxDim: 600 };
      else changed.contents.at(-1).parts[0].functionResponse.parts[0].inlineData.mimeType = "image/jpeg";
      const again = await applyRetention(isolated, JSON.stringify(changed), "google", fresh, {});
      okEq("changed " + change + " permits another resize", again.shrunk, 1);
      okEq("changed " + change + " uses the new encoding context", calls, 2);
      commitForward(isolated, again.body, "google", fresh);
      ok("changed " + change + " preserves the original hash association", fresh.metadata.biliImageSeen.includes(imageHash(bigPng)));
    }

    const ambiguous = makeApi({}, void 0, { retentionShrink: async () => ({ base64: smallPng, mime: "image/png" }) });
    const fresh = session();
    const largeFirst = await applyRetention(ambiguous, body, "google", fresh, {});
    await applyRetention(ambiguous, JSON.stringify(googleToolBody([otherPng])), "google", fresh, {});
    const ambiguousRetry = await applyRetention(ambiguous, largeFirst.body, "google", fresh, {});
    commitForward(ambiguous, ambiguousRetry.body, "google", fresh);
    okEq("colliding variant identities never guess an original", JSON.stringify(fresh.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
    const shedApi = makeApi({}, void 0, { retentionShrink: async () => ({ base64: smallPng, mime: "image/png" }) });
    const shedSession = session();
    const resized = await applyRetention(shedApi, body, "google", shedSession, {});
    commitForward(shedApi, JSON.stringify(googleToolBody([])), "google", shedSession);
    okEq("a shed resized image credits neither original nor wire hash", (shedSession.metadata.biliImageSeen ?? []).length, 0);
    const reintroduced = await applyRetention(shedApi, resized.body, "google", shedSession, {});
    ok("variant identity cannot fold an unseen image previously shed", reintroduced.folded === 0 && reintroduced.body === resized.body);

    const collided = makeApi({}, void 0, { retentionShrink: async () => ({ base64: smallPng, mime: "image/png" }) });
    const collisionSession = session();
    const originals = JSON.stringify(googleToolBody([bigPng, otherPng]));
    const identicalWire = await applyRetention(collided, originals, "google", collisionSession);
    const partiallyShed = JSON.parse(identicalWire.body);
    partiallyShed.contents.at(-1).parts[0].functionResponse.parts.shift();
    commitForward(collided, JSON.stringify(partiallyShed), "google", collisionSession);
    okEq("partial shed of colliding resized pixels never guesses which original survived",
      JSON.stringify(collisionSession.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
    const originalRetry = await applyRetention(collided, originals, "google", collisionSession);
    okEq("an ambiguous seen variant cannot fold either unproven original", originalRetry.folded, 0);
    commitForward(collided, originalRetry.body, "google", collisionSession);
    ok("sending all colliding variants credits both known original identities", [imageHash(bigPng), imageHash(otherPng)].every((hash) => collisionSession.metadata.biliImageSeen.includes(hash)));

    const duplicated = makeApi({}, void 0, { retentionShrink: async () => ({ base64: smallPng, mime: "image/png" }) });
    const duplicateSession = session();
    const duplicateWire = await applyRetention(duplicated, JSON.stringify(googleToolBody([bigPng, bigPng])), "google", duplicateSession);
    const oneCopy = JSON.parse(duplicateWire.body);
    oneCopy.contents.at(-1).parts[0].functionResponse.parts.pop();
    commitForward(duplicated, JSON.stringify(oneCopy), "google", duplicateSession);
    okEq("one surviving duplicate still proves the same original was seen",
      JSON.stringify(duplicateSession.metadata.biliImageSeen), JSON.stringify([imageHash(bigPng), imageHash(smallPng)]));
  }

  // 21. Execute the candidate's actual retention-to-shed seam, proving that
  // the shedder sees the reduced body and the common rewrite flag is set.
  {
    const start = dist.indexOf("const biliImages=await biliRetentionApply(wireBody,prepared.protocol");
    const marker = "wireBody=shed.body;";
    const end = start === -1 ? -1 : dist.indexOf(marker, start);
    if (start === -1 || end === -1) throw new Error("candidate retention-to-shed seam changed");
    const seam = dist.slice(start, end + marker.length);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction("biliRetentionApply", "shedEgressIfOverBudget", "prepared", "log2", "body", "biliImageAttempt", "invalidateSeparatorOwnership",
      "let wireBody=body;let outboundCopyRewritten=false;" + seam + "\nreturn {wireBody,outboundCopyRewritten};");
    const api = makeApi({});
    const s = session();
    s.metadata.biliImageSeen = [imageHash(smallPng)];
    const body = JSON.stringify(googleToolBody());
    const order = [];
    let shedInput;
    let invalidations = 0;
    const final = await run(async (...args) => {
      order.push("retention");
      return api.biliRetentionApply(...args);
    }, async (wire) => {
      order.push("shed");
      shedInput = wire;
      return { body: wire };
    }, { protocol: "google", session: s }, () => {}, body, {}, () => {
      invalidations++;
      order.push("invalidate");
    });
    okEq("candidate invalidates changed retention before shedding", order.join(","), "retention,invalidate,shed");
    okEq("candidate invalidates changed retention exactly once when shed is unchanged", invalidations, 1);
    ok("candidate shedder receives the folded tool response", !shedInput.includes(smallPng) && shedInput.includes("[image: "));
    ok("candidate folded body is physically smaller", Buffer.byteLength(shedInput) < Buffer.byteLength(body));
    ok("retention sets the shared outbound rewrite flag even when shed is unchanged", final.outboundCopyRewritten && final.wireBody === shedInput);
    let unchangedInvalidations = 0;
    const fresh = session();
    const unchanged = await run((...args) => api.biliRetentionApply(...args), async (wire) => ({ body: wire }),
      { protocol: "google", session: fresh }, () => {}, body, {}, () => { unchangedInvalidations++; });
    ok("unchanged retention preserves its outbound body and rewrite flag", unchanged.wireBody === body && !unchanged.outboundCopyRewritten);
    okEq("unchanged retention does not invalidate separator ownership", unchangedInvalidations, 0);
  }

  // 22. Tool returns (including named original-image calls and receipt text)
  // are never mistaken for the newest ordinary user upload on any protocol.
  {
    const receipt = "Billion original image receipt v1 sha256=" + createHash("sha256").update(Buffer.from(smallPng, "base64")).digest("hex");
    const imageUrl = "data:image/png;base64," + smallPng;
    const fixtures = [
      ["anthropic", { messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "acp_read_original_image", input: { ref: "m00042" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
          { type: "text", text: receipt }, { type: "image", source: { type: "base64", media_type: "image/png", data: smallPng } }
        ] }] }
      ], tools: [{ name: "acp_read_original_image" }] }, 1],
      ["openai", { messages: [
        { role: "assistant", tool_calls: [{ id: "t1", type: "function", function: { name: "acp_read_original_image", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: [
          { type: "text", text: receipt }, { type: "image_url", image_url: imageUrl },
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
        ] }
      ], tools: [{ type: "function", function: { name: "acp_read_original_image" } }] }, 2],
      ["responses", { input: [
        { type: "custom_tool_call", call_id: "t1", name: "acp_read_original_image", input: "m00042" },
        { type: "custom_tool_call_output", call_id: "t1", output: [
          { type: "input_text", text: receipt }, { type: "input_image", image_url: imageUrl }
        ] }
      ], tools: [{ type: "function", name: "acp_read_original_image" }] }, 1],
      ["google", googleToolBody([smallPng], { toolName: "acp_read_original_image", response: { result: receipt } }), 1]
    ];
    for (const [protocol, fixture, count] of fixtures) {
      const api = makeApi({});
      const s = session();
      const body = JSON.stringify(fixture);
      const first = await applyRetention(api, body, protocol, s, {});
      ok(protocol + " tool image receives its first look", !first.changed && first.body === body);
      commitForward(api, first.body, protocol, s);
      const second = await applyRetention(api, body, protocol, s, {});
      okEq(protocol + " tool receipt image folds after success", second.folded, count);
      ok(protocol + " tool receipt text remains intact", second.body.includes(receipt));
      ok(protocol + " tool image placeholder retains a usable ref", second.body.includes("m00042") && !second.body.includes("[object Promise]"));
    }
    for (const [protocol, fixture] of [
      ["openai", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageUrl } }] }] }],
      ["responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] }] }],
      ["responses", { input: [{ role: "user", content: [{ type: "input_image", image_url: imageUrl }] }] }]
    ]) {
      const s = session();
      s.metadata.biliImageSeen = [imageHash(smallPng)];
      const body = JSON.stringify(fixture);
      const api = makeApi({});
      const kept = await applyRetention(api, body, protocol, s, {});
      ok(protocol + " plain newest user image remains exempt", !kept.changed && kept.body === body);
      const disabledExemption = makeApi({ imageRetentionKeepLastUser: false });
      const folded = await applyRetention(disabledExemption, body, protocol, s, {});
      okEq(protocol + " newest-user exemption can be disabled", folded.folded, 1);
    }
  }

  // 23. Accounting needs the actual request-local, finalized, single-use
  // receipt. A session id, another context, or a caller-made token is no proof.
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(googleToolBody());
    const missing = await api.biliRetentionApply(body, "google", s, {});
    ok("missing request context preserves the first pixels", !missing.changed && missing.body === body);
    okEq("unrelated context produces no receipt", api.biliRetentionFinalize(body, "google", s, {}), void 0);
    successfulForward(api)({ sessionId: s.id });
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: {} });
    okEq("session-only and forged-receipt successes do not record images", (s.metadata.biliImageSeen ?? []).length, 0);
    s.metadata.biliImageSeen = [imageHash(smallPng)];
    const uninstrumented = await api.biliRetentionApply(body, "google", s, {});
    ok("missing request context preserves even previously seen pixels", !uninstrumented.changed && uninstrumented.body === body);
    s.metadata = {};

    const attempt = {};
    await api.biliRetentionApply(body, "google", s, { attempt });
    const receipt = api.biliRetentionFinalize(body, "google", s, attempt);
    ok("finalized receipt is an opaque object", receipt !== void 0 && Object.keys(receipt).length === 0);
    successfulForward(api)({ sessionId: "wrong-session", biliImageReceipt: receipt });
    okEq("a receipt cannot credit another session id", (s.metadata.biliImageSeen ?? []).length, 0);
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: receipt });
    okEq("the matching receipt credits its own request", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
    s.metadata = {};
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: receipt });
    okEq("a consumed receipt cannot re-credit images after a reset", (s.metadata.biliImageSeen ?? []).length, 0);

    await api.biliRetentionApply(body, "google", s, { attempt });
    const foreign = { id: s.id, metadata: {} };
    okEq("finalization rejects another session object with the same id", api.biliRetentionFinalize(body, "google", foreign, attempt), void 0);
    successfulForward(api)({ sessionId: s.id });
    okEq("rejected finalization has no session fallback", (s.metadata.biliImageSeen ?? []).length, 0);

    const both = JSON.stringify(googleToolBody([smallPng, otherPng]));
    await api.biliRetentionApply(both, "google", s, { attempt });
    const beforeShed = api.biliRetentionFinalize(both, "google", s, attempt);
    const onlyOther = JSON.stringify(googleToolBody([otherPng]));
    const afterShed = api.biliRetentionFinalize(onlyOther, "google", s, attempt);
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: beforeShed });
    okEq("re-finalizing revokes a receipt for older wire pixels", (s.metadata.biliImageSeen ?? []).length, 0);
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: afterShed });
    okEq("re-finalized receipt credits only final surviving pixels", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(otherPng)]));
  }

  // 24. Google output/error selectors must carry the image instructions
  // themselves, while every original value and unrelated JSON field survives.
  {
    for (const [field, value] of [
      ["output", "tool output text"],
      ["output", { result: { answer: 42 }, biliImageNotes: { callerOwned: true } }],
      ["output", [{ result: 42 }, "caller text"]],
      ["output", 42],
      ["output", null],
      ["error", "tool error text"],
      ["error", { code: 7, details: ["caller error"] }]
    ]) {
      const api = makeApi({});
      const s = session();
      const response = { [field]: value, sibling: { untouched: true } };
      const body = JSON.stringify(googleToolBody([smallPng, otherPng], { response }));
      const first = await applyRetention(api, body, "google", s);
      commitForward(api, first.body, "google", s);
      const next = await applyRetention(api, body, "google", s);
      const finalResponse = JSON.parse(next.body).contents.at(-1).parts[0].functionResponse.response;
      const effective = finalResponse[field];
      const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
      const name = "Google " + field + " " + type;
      okEq(name + " folds each tool image", next.folded, 2);
      okEq(name + " preserves sibling data", JSON.stringify(finalResponse.sibling), JSON.stringify(response.sibling));
      okEq(name + " contains all image notes in the selected value", (JSON.stringify(effective).match(/\[image:/g) ?? []).length, 2);
      ok(name + " exposes the original-image instruction", JSON.stringify(effective).includes("acp_read_original_image"));
      if (typeof value === "string") ok(name + " preserves original text", effective.startsWith(value + "\n"));
      else if (Array.isArray(value)) okEq(name + " preserves original array entries", JSON.stringify(effective.slice(0, value.length)), JSON.stringify(value));
      else if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) okEq(name + " preserves original " + key, JSON.stringify(effective[key]), JSON.stringify(value[key]));
      } else okEq(name + " preserves its original primitive", effective.biliOriginalValue, value);
      okEq(name + " does not mutate the inbound response", JSON.stringify(response), JSON.stringify({ [field]: value, sibling: { untouched: true } }));
    }
  }

  // 25. The Responses codec also accepts role/content message shorthand.
  // Its historical images fold after success and its current upload is exempt.
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify({ input: [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + smallPng }] },
      { role: "assistant", content: [{ type: "output_text", text: "seen" }] }
    ], tools: [{ type: "function", name: "acp_read_original_image" }] });
    const first = await applyRetention(api, body, "responses", s);
    ok("Responses shorthand first upload keeps its pixels", !first.changed && first.body === body);
    commitForward(api, first.body, "responses", s);
    const next = await applyRetention(api, body, "responses", s);
    okEq("Responses shorthand historical image folds after success", next.folded, 1);
    ok("Responses shorthand note keeps a retrievable reference", next.body.includes("m00042") && next.body.includes("acp_read_original_image"));
  }

  // 26. The Google loop serializes a v1internal envelope after wireTransform.
  // Image retention and final accounting see its inner native request while
  // all outer fields (including any unrelated media) remain byte-for-byte data.
  {
    const upstream = publishedOriginalImageApi();
    const wrapperMeta = { project: "mock-project", model: "gemini-mock", requestId: "r-envelope-1",
      userAgent: "mock-client", clientMetadata: { trace: ["first", "second"], enabled: true },
      diagnostic: { inlineData: { mimeType: "image/png", data: smallPng } } };
    const publishedWrap = new Function(publishedFunction("wrapV1Internal") + "\nreturn wrapV1Internal;")();
    const wrap = (request) => publishedWrap(request, structuredClone(wrapperMeta));
    const metadataOf = (wire) => {
      const parsed = typeof wire === "string" ? JSON.parse(wire) : wire;
      const { request, ...metadata } = parsed;
      return JSON.stringify(metadata);
    };
    const expectedMeta = JSON.stringify(wrapperMeta);
    const dir = await mkdtemp(join(tmpdir(), "bili-image-check-envelope-"));
    try {
      const originalPath = join(dir, "large-original.png");
      const smallPath = join(dir, "small-original.png");
      await writeFile(originalPath, Buffer.from(bigPng, "base64"));
      await writeFile(smallPath, Buffer.from(smallPng, "base64"));
      const s = { id: "envelope", metadata: {}, incomingImageIndex: new Map([
        ["m00044", [{ path: originalPath, mediaType: "image/png", bytes: Buffer.byteLength(bigPng, "base64"), width: 1500, height: 1000 }]],
        ["m00042", [{ path: smallPath, mediaType: "image/png", bytes: Buffer.byteLength(smallPng, "base64"), width: 8, height: 8 }]]
      ]) };
      let encodes = 0;
      const api = makeApi({}, void 0, { refForItemBytes: upstream.refForItemBytes, retentionShrink: async (_mime, b64) => {
        encodes++;
        return b64 === bigPng ? { base64: smallPng, mime: "image/png" } : null;
      } });
      const inbound = wrap(googleToolBody([bigPng], { keepOtherMedia: true, response: { output: "captured", kept: { answer: 42 } } }));
      const body = JSON.stringify(inbound);
      const first = await applyRetention(api, body, "google", s);
      okEq("v1internal first tool image shrinks before send", first.shrunk, 1);
      okEq("v1internal first tool image is not folded", first.folded, 0);
      const initialTool = JSON.parse(first.body).request.contents.at(-1).parts[0].functionResponse;
      okEq("v1internal shrink updates the inner image carrier", initialTool.parts[0].inlineData.data, smallPng);
      okEq("v1internal shrink preserves other media", JSON.stringify(initialTool.parts.slice(1)), JSON.stringify(inbound.request.contents.at(-1).parts[0].functionResponse.parts.slice(1)));
      okEq("v1internal shrink preserves wrapper metadata", metadataOf(first.body), expectedMeta);
      const failedReceipt = finalizeRetention(api, first.body, "google", s);
      ok("v1internal final plaintext creates an owned receipt", failedReceipt !== void 0);
      okEq("v1internal failed first send has no seen ledger", (s.metadata.biliImageSeen ?? []).length, 0);
      const retry = await applyRetention(api, first.body, "google", s);
      ok("v1internal retry keeps its already resized inner pixels", !retry.changed && retry.body === first.body && retry.folded === 0);
      okEq("v1internal retry avoids a second resize", encodes, 1);
      successfulForward(api)({ sessionId: s.id, biliImageReceipt: failedReceipt });
      okEq("v1internal retry revokes the failed predecessor receipt", (s.metadata.biliImageSeen ?? []).length, 0);
      commitForward(api, retry.body, "google", s);
      okEq("v1internal successful retry records original and wire hashes", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(bigPng), imageHash(smallPng)]));
      const next = await applyRetention(api, body, "google", s);
      okEq("v1internal nested tool image folds after success", next.folded, 1);
      const foldedTool = JSON.parse(next.body).request.contents.at(-1).parts[0].functionResponse;
      ok("v1internal tools in the inner request arm original-image retrieval", foldedTool.response.output.includes('acp_read_original_image("m00044")'));
      ok("v1internal image note names the original dimensions", foldedTool.response.output.includes("1500x1000 m00044"));
      okEq("v1internal fold preserves wrapper metadata", metadataOf(next.body), expectedMeta);
      okEq("v1internal fold preserves unrelated response JSON", JSON.stringify(foldedTool.response.kept), JSON.stringify(initialTool.response.kept));
      okEq("v1internal fold preserves other media", JSON.stringify(foldedTool.parts), JSON.stringify(initialTool.parts.slice(1)));
      okEq("v1internal inbound envelope remains unchanged", JSON.stringify(inbound), body);
      okEq("v1internal retention leaves the original file intact", (await readFile(originalPath)).toString("base64"), bigPng);
      const restored = await upstream.executeReadOriginalImage({ ref: "m00044" }, s, () => {});
      okEq("v1internal folded ref retrieves the byte-exact full-resolution original", restored.image?.base64, bigPng);

      const upload = JSON.stringify(wrap({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: smallPng } }] }], tools: inbound.request.tools }));
      const current = await applyRetention(api, upload, "google", s);
      ok("v1internal newest ordinary upload remains exempt", !current.changed && current.body === upload);
      const older = JSON.parse(upload);
      older.request.contents.push({ role: "model", parts: [{ text: "processed" }] });
      const historical = await applyRetention(api, JSON.stringify(older), "google", s);
      okEq("v1internal historical ordinary upload folds", historical.folded, 1);
      okEq("v1internal historical fold preserves wrapper metadata", metadataOf(historical.body), expectedMeta);

      const staged = makeApi({});
      const shedSession = { id: "envelope-shed", metadata: {} };
      const two = JSON.stringify(wrap(googleToolBody([smallPng, otherPng])));
      await applyRetention(staged, two, "google", shedSession);
      const one = JSON.parse(two);
      one.request.contents.at(-1).parts[0].functionResponse.parts.shift();
      commitForward(staged, JSON.stringify(one), "google", shedSession);
      okEq("v1internal finalization sees only surviving inner pixels", JSON.stringify(shedSession.metadata.biliImageSeen), JSON.stringify([imageHash(otherPng)]));
      const again = await applyRetention(staged, two, "google", shedSession);
      okEq("v1internal previously shed picture remains unsighted", again.folded, 1);
      okEq("v1internal shed original still has its first-look pixels", JSON.parse(again.body).request.contents.at(-1).parts[0].functionResponse.parts[0].inlineData.data, smallPng);
      okEq("v1internal finalization never credits unrelated wrapper media", shedSession.metadata.biliImageSeen.includes(imageHash(smallPng)), false);
      const removed = makeApi({});
      const removedSession = { id: "envelope-removed", metadata: {} };
      const innerOnly = JSON.stringify(googleToolBody());
      await applyRetention(removed, innerOnly, "google", removedSession);
      commitForward(removed, JSON.stringify(wrap(googleToolBody([]))), "google", removedSession);
      okEq("wrapper media cannot stand in for an inner image removed after Apply", (removedSession.metadata.biliImageSeen ?? []).length, 0);
      const wrappedAfter = makeApi({});
      const wrappedSession = { id: "envelope-wrap-after-apply", metadata: {} };
      const inner = await applyRetention(wrappedAfter, innerOnly, "google", wrappedSession);
      commitForward(wrappedAfter, JSON.stringify(wrap(JSON.parse(inner.body))), "google", wrappedSession);
      okEq("finalization accepts a v1internal wrapper added after inner Apply", JSON.stringify(wrappedSession.metadata.biliImageSeen), JSON.stringify([imageHash(smallPng)]));
    } finally {
      const tempRoot = resolve(tmpdir()) + sep;
      if (!resolve(dir).startsWith(tempRoot) || !basename(dir).startsWith("bili-image-check-envelope-")) throw new Error("refusing envelope image cleanup outside its temporary directory");
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 27. Execute the candidate's actual retry finalizer. The receipt belongs
  // to the post-shed, post-plugin plaintext; signing and wrapping follow it.
  {
    const start = dist.indexOf("const finalizeEgress=async variant=>{");
    const marker = ";const steerRaw=";
    const end = start === -1 ? -1 : dist.indexOf(marker, start);
    if (start === -1 || end === -1) throw new Error("candidate retry finalizer changed");
    const declaration = dist.slice(start, end + 1);
    const makeRetry = new Function("biliRetentionApply", "biliRetentionFinalize", "shedEgressIfOverBudget", "shedWireImagesToCount",
      "normalizeUpstreamOrigin", "refForItemBytes", "prepared", "log2", "biliImageAttempt", "invalidateSeparatorOwnership", "runEgress",
      "applyResign", "v1Wrap", "headers", "upstreamUrl", "__biliPlaintextHeaders",
      "let biliImageReceipt;let outboundCopyRewritten=false;" + declaration
      + "\nreturn { finalizeEgress, receipt:()=>biliImageReceipt, rewritten:()=>outboundCopyRewritten };");
    const api = makeApi({});
    const s = { id: "actual-retry", metadata: {}, stats: {} };
    const protocol = "google";
    const body = JSON.stringify(googleToolBody([smallPng, otherPng]));
    const order = [];
    const signed = [];
    let removeSmall = false;
    let invalidations = 0;
    const retry = makeRetry(async (...args) => {
      order.push("retention");
      return api.biliRetentionApply(...args);
    }, (...args) => {
      order.push("finalize");
      return api.biliRetentionFinalize(...args);
    }, async (wire) => { order.push("shed"); return { body: wire }; },
    async (wire) => ({ body: wire }), () => "https://example.invalid", async () => "m00042",
    { protocol, session: s, sidePassthrough: false }, () => {}, {}, () => { invalidations++; }, async (wire) => {
      order.push("egress");
      if (!removeSmall) return wire;
      const parsed = JSON.parse(wire);
      parsed.contents.at(-1).parts[0].functionResponse.parts.shift();
      return JSON.stringify(parsed);
    }, (_headers, wire) => { order.push("sign"); signed.push(wire); }, (wire) => {
      order.push("wrap");
      return JSON.stringify({ request: JSON.parse(wire), requestId: "actual-retry-wire" });
    }, {}, "https://example.invalid/v1/generate", headers => ({ ...headers }));
    const first = await retry.finalizeEgress(body);
    const failedReceipt = retry.receipt();
    okEq("candidate retry signs only after final image accounting", order.join(","), "retention,shed,egress,finalize,sign,wrap");
    okEq("candidate retry wraps the exact signed plaintext", JSON.stringify(JSON.parse(first).request), signed.at(-1));
    okEq("candidate failed retry has no seen ledger", (s.metadata.biliImageSeen ?? []).length, 0);
    order.length = 0;
    removeSmall = true;
    const finalWire = await retry.finalizeEgress(body);
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: failedReceipt });
    okEq("candidate retry finalizer revokes a failed predecessor receipt", (s.metadata.biliImageSeen ?? []).length, 0);
    successfulForward(api)({ sessionId: s.id, biliImageReceipt: retry.receipt() });
    okEq("candidate retry receipt credits only plugin-surviving images", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(otherPng)]));
    okEq("candidate retry plugin mutation invalidates provenance", invalidations, 1);
    ok("candidate retry plugin mutation sets outbound rewrite flag", retry.rewritten());
    okEq("candidate retry final wrapper contains only the surviving image", JSON.parse(finalWire).request.contents.at(-1).parts[0].functionResponse.parts[0].inlineData.data, otherPng);
  }

  // 28. Execute the loop's actual Apply/shed/egress/Finalize/sign sequence and
  // its accepted-send commit statement, with the real published v1 wrapper.
  {
    const start = dist.indexOf("const biliLoopImageAttempt={};");
    const marker = "requestOptions.resign?.(requestOptions.headers,wireBodyStr);";
    const end = start === -1 ? -1 : dist.indexOf(marker, start);
    if (start === -1 || end === -1) throw new Error("candidate image loop seam changed");
    const seam = dist.slice(start, end + marker.length);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction("biliRetentionApply", "biliRetentionFinalize", "shedEgressIfOverBudget", "scrubLoneSurrogateEscapesOnJson",
      "ctx", "requestOptions", "log", "body", "wireObj",
      "let wireBodyStr=body;let wireShedRewrote=false;" + seam
      + "\nreturn {wireBodyStr,wireShedRewrote,biliLoopImageReceipt};");
    const acceptedStart = dist.indexOf("const upstreamSend=await throttledSend;");
    const acceptedEnd = acceptedStart === -1 ? -1 : dist.indexOf("noteUpstreamThrottleResolved(", acceptedStart);
    if (acceptedStart === -1 || acceptedEnd === -1) throw new Error("candidate loop successful-send seam changed");
    const commitAccepted = new AsyncFunction("throttledSend", "biliRetentionCommit", "ctx", "biliLoopImageReceipt",
      dist.slice(acceptedStart, acceptedEnd) + "\nreturn upstreamSend;");
    const api = makeApi({});
    const s = { id: "actual-envelope-loop", metadata: {}, stats: {} };
    const wrap = new Function(publishedFunction("wrapV1Internal") + "\nreturn wrapV1Internal;")();
    const meta = { model: "gemini-mock", requestId: "actual-loop-wire", project: "mock-project", client: { untouched: true } };
    const request = wrap(googleToolBody([smallPng, otherPng]), meta);
    const body = JSON.stringify(request);
    const order = [];
    const headers = { authorization: "test-fixture" };
    let signed;
    const ctx = { protocol: "google", session: s };
    const final = await run(async (...args) => { order.push("retention"); return api.biliRetentionApply(...args); },
      (...args) => { order.push("finalize"); return api.biliRetentionFinalize(...args); },
      async (wire) => { order.push("shed"); return { body: wire }; }, (wire) => wire, ctx,
      { headers, egress: async (wire) => {
        order.push("egress");
        const parsed = JSON.parse(wire);
        parsed.request.contents.at(-1).parts[0].functionResponse.parts.shift();
        return JSON.stringify(parsed);
      }, resign: (receivedHeaders, wire) => { order.push("sign"); signed = wire; ok("candidate loop signs with its own headers", receivedHeaders === headers); } },
      () => {}, body, request);
    okEq("candidate loop executes image accounting around shed/egress before signing", order.join(","), "retention,shed,egress,finalize,sign");
    ok("candidate loop records a receipt from its wrapped final plaintext", final.biliLoopImageReceipt !== void 0 && signed === final.wireBodyStr);
    ok("candidate loop flags plugin rewrites for image/provenance accounting", final.wireShedRewrote);
    const { request: inner, ...actualMeta } = JSON.parse(final.wireBodyStr);
    okEq("candidate loop preserves v1internal metadata", JSON.stringify(actualMeta), JSON.stringify(meta));
    okEq("candidate loop finalizer retains only the surviving image", inner.contents.at(-1).parts[0].functionResponse.parts[0].inlineData.data, otherPng);
    let failed = false;
    const rejected = Promise.reject(new Error("mock upstream rejected"));
    await commitAccepted(rejected, api.biliRetentionCommit, ctx, final.biliLoopImageReceipt).catch(() => { failed = true; });
    ok("candidate loop rejected send remains a failure", failed);
    okEq("candidate loop rejected send cannot commit its finalized images", (s.metadata.biliImageSeen ?? []).length, 0);
    await commitAccepted(Promise.resolve({ response: { ok: true } }), api.biliRetentionCommit, ctx, final.biliLoopImageReceipt);
    okEq("candidate loop accepted send commits only its final surviving image", JSON.stringify(s.metadata.biliImageSeen), JSON.stringify([imageHash(otherPng)]));
    const next = await api.biliRetentionApply(body, "google", s, { attempt: {} });
    okEq("candidate loop failed/shed original remains unsighted after successful peer pixels", next.folded, 1);
    okEq("candidate loop unsighted original still leaves as pixels", JSON.parse(next.body).request.contents.at(-1).parts[0].functionResponse.parts[0].inlineData.data, smallPng);
  }

  if (failures > 0) {
    console.log(failures + " check(s) failed");
    process.exit(1);
  }
  console.log("image retention: all checks passed (" + checks + " assertions)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
