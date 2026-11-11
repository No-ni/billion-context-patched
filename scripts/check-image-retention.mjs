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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const distPath = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "index.js");

let failures = 0;
const ok = (name, cond, extra) => {
  if (cond) return;
  failures++;
  console.log("FAIL " + name + (extra === void 0 ? "" : " — " + extra));
};
const okEq = (name, value, expected) => ok(name, value === expected, "got " + JSON.stringify(value) + ", want " + JSON.stringify(expected));

// ── structural: the seams that the patch script owns ────────────────────────
const dist = readFileSync(distPath, "latin1");
ok("dist: helpers inserted", dist.includes("function biliRetentionApply("));
ok("dist: retention runs before the shedder", dist.indexOf("await biliRetentionApply(wireBody,prepared.protocol") > 0);
ok("dist: retention runs before shedEgressIfOverBudget", dist.indexOf("await biliRetentionApply(wireBody,prepared.protocol") < dist.indexOf("const shed=await shedEgressIfOverBudget(wireBody,prepared.protocol"));
ok("dist: commit hook on forward", dist.includes("function noteSuccessfulForward(inp){try{biliRetentionCommit(inp&&inp.sessionId)}catch(err3){}try{armInternal(inp)}"));
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

function makeApi(config, cfgState) {
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
    refForItemBytes: () => "m00042",
    READ_ORIGINAL_IMAGE_TOOL_NAME: "acp_read_original_image"
  };
  const body = blockText + "\nreturn { biliRetentionApply, biliRetentionCommit, biliRetentionNote, biliRetentionEnabled, biliImageConventionText, biliRetentionShrinkOne, biliRetentionShrink, biliRetentionMaxDim, biliRetentionBackendOrder, biliRetentionBackendSteps, biliRetentionBackends };";
  const fn = new Function(...Object.keys(shims), body);
  const api = fn(...Object.values(shims));
  api.state = state;
  return api;
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
const bigPng = makePng(1500, 1000);
const session = () => ({ id: "s1", metadata: {} });

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

// ── behaviour ───────────────────────────────────────────────────────────────
async function main() {
  // 1. a picture is folded only after it made it upstream once
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { tools: true }));
    const first = await api.biliRetentionApply(body, "anthropic", s, {});
    ok("first sight is not folded", first.changed === false, JSON.stringify(first));
    ok("first sight is pending", (s.metadata.biliImageSeen ?? []).length === 0);
    api.biliRetentionCommit("s1");
    ok("commit records the look", (s.metadata.biliImageSeen ?? []).length >= 1);
    const second = await api.biliRetentionApply(body, "anthropic", s, {});
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
    await api.biliRetentionApply(body, "anthropic", s, {});
    api.biliRetentionCommit("s1");
    const again = await api.biliRetentionApply(body, "anthropic", s, {});
    ok("fresh upload stays", again.changed === false, JSON.stringify(again));
  }

  // 3. with the exemption off, even the newest upload folds
  {
    const api = makeApi({ imageRetentionKeepLastUser: false });
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { imageLast: true }));
    await api.biliRetentionApply(body, "anthropic", s, {});
    api.biliRetentionCommit("s1");
    const again = await api.biliRetentionApply(body, "anthropic", s, {});
    ok("fresh upload folds when asked", again.folded === 1, JSON.stringify(again));
  }

  // 4. a screenshot returned by a tool folds like any other picture
  {
    const api = makeApi({});
    const s = session();
    const body = JSON.stringify(anthropicBody(smallPng, { toolResult: true }));
    await api.biliRetentionApply(body, "anthropic", s, {});
    api.biliRetentionCommit("s1");
    const again = await api.biliRetentionApply(body, "anthropic", s, {});
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
    await api.biliRetentionApply(body, "google", s, {});
    api.biliRetentionCommit("s1");
    const again = await api.biliRetentionApply(body, "google", s, {});
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
    await api.biliRetentionApply(body, "openai", s, {});
    api.biliRetentionCommit("s1");
    const again = await api.biliRetentionApply(body, "openai", s, {});
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
    await api.biliRetentionApply(body, "responses", s, {});
    api.biliRetentionCommit("s1");
    const again = await api.biliRetentionApply(body, "responses", s, {});
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
    const res = await api.biliRetentionApply(body, "anthropic", s, {});
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

  if (failures > 0) {
    console.log(failures + " check(s) failed");
    process.exit(1);
  }
  console.log("image retention: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
