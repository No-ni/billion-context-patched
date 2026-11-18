#!/usr/bin/env node
// Focused offline check for the host-retired image reference bridge.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const source = await readFile(join(root, "patches", "image-retention.block.js"), "utf8");
const dir = await mkdtemp(join(tmpdir(), "bili-host-image-fallback-"));

function makeApi() {
  const shims = {
    Buffer,
    require,
    readFile6: readFile,
    isObj4: value => value !== null && typeof value === "object" && !Array.isArray(value),
    loadConfigFile: () => ({}),
    hashContent: value => createHash("sha256").update(value, "utf8").digest("hex"),
    markDirty: () => {},
    tIntLoose: () => undefined,
    decodeImageDims: () => undefined,
    b64Bytes2: value => Buffer.byteLength(value, "base64"),
    dataUrl: (mediaType, value) => `data:${mediaType};base64,${value}`,
    parseDataUrl: value => {
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value);
      return match && { mediaType: match[1], base64: match[2] };
    },
    refForItemBytes: async () => "m00042",
    READ_ORIGINAL_IMAGE_TOOL_NAME: "acp_read_original_image",
    retentionShrink: undefined,
  };
  return new Function(...Object.keys(shims), `${source}\nreturn { biliRetentionApply, biliRetentionFinalize, biliRetentionCommit, biliRetentionRememberHostImages, biliRetentionNote };`)(...Object.values(shims));
}

function bodyFor(protocol, image) {
  switch (protocol) {
    case "anthropic":
      return { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: image } }] }], tools: [{ name: "acp_read_original_image" }] };
    case "openai":
      return { messages: [{ role: "user", content: [{ type: "image_url", image_url: `data:image/png;base64,${image}` }] }], tools: [{ type: "function", function: { name: "acp_read_original_image" } }] };
    case "responses":
      return { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${image}` }] }], tools: [{ name: "acp_read_original_image" }] };
    case "google":
      return { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: image } }] }], tools: [{ functionDeclarations: [{ name: "acp_read_original_image" }] }] };
    default: throw new Error(`unknown protocol ${protocol}`);
  }
}

function placeholderFor(protocol, sha256, text = `[image omitted to fit request image limits; "photo.png" (sha256:${sha256}). Normalized copy (read-only; may be resized or re-encoded): "/tmp/dsh-attachments/${sha256}" (1x1px, image/png). Source dimensions, format, and byte size may differ. Copy to a writable path ending in .png before editing.]`) {
  switch (protocol) {
    case "anthropic": return { messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [{ name: "acp_read_original_image" }] };
    case "openai": return { messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [{ type: "function", function: { name: "acp_read_original_image" } }] };
    case "responses": return { input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], tools: [{ name: "acp_read_original_image" }] };
    case "google": return { contents: [{ role: "user", parts: [{ text }] }], tools: [{ functionDeclarations: [{ name: "acp_read_original_image" }] }] };
  }
}

function placeholderText(protocol, body) {
  if (protocol === "google") return (body.request ?? body).contents[0].parts[0].text;
  if (protocol === "responses") return body.input[0].content[0].text;
  return body.messages[0].content[0].text;
}

async function recordSuccessfulImage(api, protocol, session, b64) {
  const attempt = {};
  const body = bodyFor(protocol, b64);
  body.context = "ordinary request context ".repeat(20);
  const sent = await api.biliRetentionApply(JSON.stringify(body), protocol, session, { attempt });
  const receipt = api.biliRetentionFinalize(sent.body, protocol, session, attempt);
  assert.ok(receipt, `${protocol}: final request creates a success receipt`);
  api.biliRetentionCommit(session.id, receipt);
}

try {
  const bytes = Buffer.from("normalized original image bytes");
  const b64 = bytes.toString("base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const b64Hash = createHash("sha256").update(b64, "utf8").digest("hex");
  const path = join(dir, "image.png");
  await writeFile(path, bytes);

  for (const protocol of ["anthropic", "openai", "responses", "google"]) {
    const api = makeApi();
    const session = {
      id: protocol,
      metadata: {},
      incomingImageIndex: new Map([["m00042", [{ path, mediaType: "image/png", bytes: bytes.length }]]]),
    };
    await recordSuccessfulImage(api, protocol, session, b64);
    assert.equal(session.metadata.biliHostImageRefs?.[0]?.sha256, sha256, `${protocol}: hashes raw original bytes`);
    assert.notEqual(session.metadata.biliHostImageRefs?.[0]?.sha256, b64Hash, `${protocol}: does not hash base64 text`);
    const incoming = placeholderFor(protocol, sha256);
    const restored = await api.biliRetentionApply(JSON.stringify(incoming), protocol, session, { attempt: {} });
    const restoredText = placeholderText(protocol, JSON.parse(restored.body));
    assert.equal(restoredText, api.biliRetentionNote("image/png", b64, "m00042", true), `${protocol}: restores the exact plugin note with the image tool`);
    const withoutTool = placeholderFor(protocol, sha256);
    withoutTool.tools = [];
    const restoredWithoutTool = await api.biliRetentionApply(JSON.stringify(withoutTool), protocol, session, { attempt: {} });
    assert.equal(placeholderText(protocol, JSON.parse(restoredWithoutTool.body)), api.biliRetentionNote("image/png", b64, "m00042", false), `${protocol}: restores the exact plugin note without the image tool`);

    const actualHostText = `[image omitted to fit request image limits; sha256:${sha256}. Normalized copy (read-only; may be resized or re-encoded): "/tmp/dsh-attachments/${sha256}" (1x1px, image/png). Source dimensions, format, and byte size may differ. Copy to a writable path ending in .png before editing.]`;
    const actualHost = placeholderFor(protocol, sha256, actualHostText);
    const restoredActualHost = await api.biliRetentionApply(JSON.stringify(actualHost), protocol, session, { attempt: {} });
    assert.equal(placeholderText(protocol, JSON.parse(restoredActualHost.body)), api.biliRetentionNote("image/png", b64, "m00042", true), `${protocol}: accepts the host's actual no-name placeholder`);
    const unavailablePath = placeholderFor(protocol, sha256, `[image omitted to fit request image limits; sha256:${sha256}. No local normalized image path is available; ask the user to attach it again if needed.]`);
    const restoredUnavailablePath = await api.biliRetentionApply(JSON.stringify(unavailablePath), protocol, session, { attempt: {} });
    assert.equal(placeholderText(protocol, JSON.parse(restoredUnavailablePath.body)), api.biliRetentionNote("image/png", b64, "m00042", true), `${protocol}: accepts host placeholder without a local path`);
  }

  {
    const api = makeApi();
    const session = {
      id: "google-v1internal",
      metadata: {},
      incomingImageIndex: new Map([["m00042", [{ path, mediaType: "image/png", bytes: bytes.length }]]]),
    };
    await recordSuccessfulImage(api, "google", session, b64);
    const wrapped = { request: placeholderFor("google", sha256), project: "project-id" };
    const restored = await api.biliRetentionApply(JSON.stringify(wrapped), "google", session, { attempt: {} });
    const parsed = JSON.parse(restored.body);
    assert.equal(placeholderText("google", parsed), api.biliRetentionNote("image/png", b64, "m00042", true), "Google v1internal restores inside the native request envelope");
    assert.equal(parsed.project, "project-id", "Google outer metadata is preserved");
  }

  {
    const api = makeApi();
    const session = {
      id: "failed-send",
      metadata: {},
      incomingImageIndex: new Map([["m00042", [{ path, mediaType: "image/png", bytes: bytes.length }]]]),
    };
    const attempt = {};
    const body = bodyFor("anthropic", b64);
    body.context = "ordinary request context ".repeat(20);
    const first = await api.biliRetentionApply(JSON.stringify(body), "anthropic", session, { attempt });
    api.biliRetentionFinalize(first.body, "anthropic", session, attempt);
    const failed = await api.biliRetentionApply(JSON.stringify(placeholderFor("anthropic", sha256)), "anthropic", session, { attempt: {} });
    assert.equal(placeholderText("anthropic", JSON.parse(failed.body)), placeholderText("anthropic", placeholderFor("anthropic", sha256)), "failed send never creates a mapping");
    assert.equal(session.metadata.biliHostImageRefs, undefined, "failed send never persists a mapping");
  }

  {
    const api = makeApi();
    const session = {
      id: "unrelated-fields",
      metadata: { biliHostImageRefs: [{ sha256, ref: "m00042", mediaType: "image/png", noteWithTool: api.biliRetentionNote("image/png", b64, "m00042", true), noteWithoutTool: api.biliRetentionNote("image/png", b64, "m00042", false) }] },
    };
    const hostText = placeholderText("anthropic", placeholderFor("anthropic", sha256));
    const body = placeholderFor("anthropic", sha256, `User quoted: ${hostText}`);
    body.metadata = { copiedText: hostText };
    const result = await api.biliRetentionApply(JSON.stringify(body), "anthropic", session, { attempt: {} });
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.messages[0].content[0].text, `User quoted: ${hostText}`, "embedded user text is left unchanged");
    assert.equal(parsed.metadata.copiedText, hostText, "metadata strings are left unchanged");
  }

  {
    const api = makeApi();
    const session = {
      id: "lookalike-user-text",
      metadata: { biliHostImageRefs: [{ sha256, ref: "m00042", mediaType: "image/png", noteWithTool: api.biliRetentionNote("image/png", b64, "m00042", true), noteWithoutTool: api.biliRetentionNote("image/png", b64, "m00042", false) }] },
    };
    const lookalike = `[image omitted to fit request image limits; sha256:${sha256}. User-authored text, not a host image placeholder.]`;
    const incoming = placeholderFor("anthropic", sha256, lookalike);
    const result = await api.biliRetentionApply(JSON.stringify(incoming), "anthropic", session, { attempt: {} });
    assert.equal(placeholderText("anthropic", JSON.parse(result.body)), lookalike, "user text with a known hash but noncanonical host details stays unchanged");
  }

  {
    const api = makeApi();
    const session = { id: "unknown-id", metadata: { biliHostImageRefs: [{ sha256, ref: "m00042", mediaType: "image/png", noteWithTool: api.biliRetentionNote("image/png", b64, "m00042", true), noteWithoutTool: api.biliRetentionNote("image/png", b64, "m00042", false) }] } };
    const unknown = "f".repeat(64);
    const incoming = placeholderFor("responses", unknown);
    const result = await api.biliRetentionApply(JSON.stringify(incoming), "responses", session, { attempt: {} });
    assert.equal(placeholderText("responses", JSON.parse(result.body)), placeholderText("responses", incoming), "unknown host id stays unchanged");
  }

  {
    const api = makeApi();
    const session = { id: "incomplete-id", metadata: { biliHostImageRefs: [{ sha256, ref: "m00042", mediaType: "image/png", noteWithTool: api.biliRetentionNote("image/png", b64, "m00042", true), noteWithoutTool: api.biliRetentionNote("image/png", b64, "m00042", false) }] } };
    const incomplete = "[image omitted to fit request image limits; sha256:1234. no full identity]";
    const incoming = { contents: [{ role: "user", parts: [{ text: incomplete }] }] };
    const result = await api.biliRetentionApply(JSON.stringify(incoming), "google", session, { attempt: {} });
    assert.equal(placeholderText("google", JSON.parse(result.body)), incomplete, "incomplete hash stays unchanged");
  }

  {
    const api = makeApi();
    const session = { id: "ambiguous-id", metadata: { biliHostImageRefs: [
      { sha256, ref: "m00042", mediaType: "image/png", noteWithTool: api.biliRetentionNote("image/png", b64, "m00042", true), noteWithoutTool: api.biliRetentionNote("image/png", b64, "m00042", false) },
      { sha256, ref: "m00043", mediaType: "image/png", noteWithTool: api.biliRetentionNote("image/png", b64, "m00043", true), noteWithoutTool: api.biliRetentionNote("image/png", b64, "m00043", false) },
    ] } };
    const incoming = placeholderFor("google", sha256);
    const result = await api.biliRetentionApply(JSON.stringify(incoming), "google", session, { attempt: {} });
    assert.equal(placeholderText("google", JSON.parse(result.body)), placeholderText("google", incoming), "ambiguous host id stays unchanged");
  }

  {
    const api = makeApi();
    const session = {
      id: "removed-before-send",
      metadata: {},
      incomingImageIndex: new Map([["m00042", [{ path, mediaType: "image/png", bytes: bytes.length }]]]),
    };
    const attempt = {};
    const body = bodyFor("anthropic", b64);
    body.context = "ordinary request context ".repeat(20);
    const prepared = await api.biliRetentionApply(JSON.stringify(body), "anthropic", session, { attempt });
    const finalBody = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "host discarded image" }] }] });
    const receipt = api.biliRetentionFinalize(finalBody, "anthropic", session, attempt);
    api.biliRetentionCommit(session.id, receipt);
    assert.equal(prepared.changed, false, "fixture keeps original image until host-side retirement");
    assert.equal(receipt, undefined, "image removed from final wire body has no success receipt");
    assert.equal(session.metadata.biliHostImageRefs, undefined, "image removed from final wire body creates no fallback mapping");
  }

  {
    const api = makeApi();
    const session = { id: "bounded-cache", metadata: {} };
    const entries = Array.from({ length: 257 }, (_, index) => ({
      hostSha256: index.toString(16).padStart(64, "0"),
      ref: `m${String(index + 1).padStart(5, "0")}`,
      mediaType: "image/png",
      noteWithTool: `[image: png m${String(index + 1).padStart(5, "0")} seen]`,
      noteWithoutTool: `[image: png m${String(index + 1).padStart(5, "0")} seen]`,
    }));
    api.biliRetentionRememberHostImages(session, entries);
    assert.equal(session.metadata.biliHostImageRefs.length, 256, "host reference cache stays capped");
    assert.equal(session.metadata.biliHostImageRefs[0].sha256, entries[1].hostSha256, "cache evicts oldest mapping");
    assert.equal(session.metadata.biliHostImageRefs.at(-1).sha256, entries.at(-1).hostSha256, "cache retains newest mapping");
  }

  console.log("host image fallback: all checks passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
