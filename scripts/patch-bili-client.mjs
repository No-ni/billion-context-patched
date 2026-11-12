#!/usr/bin/env node
// The changes we make to billion-context's browser bundle
// (dist/agent/dsh-native-client.js). install.mjs applies them to the string it
// merges into lib/client.js, so every build derives the client from upstream
// again instead of keeping an older copy around.
//
//   B20. no upstream status banner — the proxy injected a red overlay panel
//        ("1 个上游不可用 · host · kind code ×N · 约 Ns 后重试") into
//        shell.overlay and polled GET /__bili/upstreams every 10s to feed it.
//        That panel restated what dsh already shows on the failed request, in
//        internal vocabulary, and could not be dismissed. The circuit breaker
//        behind it is gone as well (B19 in scripts/patch-bili-build.mjs), so the
//        panel has neither data nor purpose: the whole surface is removed here
//        rather than hidden behind a switch.
//
//   B21b. the embed probe's failure line reads in plain Chinese now.
//
// Every step checks its own anchors, so upstream moving this code stops the
// build instead of shipping a banner nobody asked for.
export const BANNER_MARKERS = ["bili-upstreams", "upstreams_down_one"];

const count = (text, find) => text.split(find).length - 1;

const expectOne = (text, label, find) => {
  const hits = count(text, find);
  if (hits !== 1) {
    throw new Error(label + ": expected exactly one anchor, found " + hits + " — upstream changed, re-derive the patch");
  }
};

// Cut a braced block (a function or an arrow assignment) out of the bundle:
// find the signature, then walk to its matching close brace. The blocks removed
// here carry no regular-expression literals, so quotes, template literals and
// comments are all the scanner has to understand.
const removeBlock = (text, label, signature) => {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(label + ": signature not found — upstream changed, re-derive the patch");
  if (text.indexOf(signature, start + 1) >= 0) throw new Error(label + ": signature is not unique — upstream changed");
  const open = text.indexOf("{", start);
  if (open < 0) throw new Error(label + ": no block after the signature");
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index];
    if (quote !== null) {
      if (ch === "\\") index += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && text[index + 1] === "/") { index = text.indexOf("\n", index); if (index < 0) break; continue; }
    if (ch === "/" && text[index + 1] === "*") { const end = text.indexOf("*/", index); if (end < 0) break; index = end + 1; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        while (text[end] === ";" || text[end] === "\n") end += 1;
        return text.slice(0, start) + text.slice(end);
      }
    }
  }
  throw new Error(label + ": unbalanced braces — upstream changed, re-derive the patch");
};

// Both locales carry the key, so each one has to disappear exactly twice.
const withoutKeys = (text, label, keys) => {
  let out = text;
  for (const key of keys) {
    const pattern = new RegExp('^[ \\t]*"' + key + '"[^\\n]*\\n', "gm");
    const hits = (out.match(pattern) ?? []).length;
    if (hits !== 2) throw new Error(label + ": key " + key + " appears " + hits + " times, expected 2 (zh + en)");
    out = out.replace(pattern, "");
  }
  return out;
};

// Rewrite one probe_error value, keeping the JSON escaping the file already uses.
const replaceProbeLine = (text, index, value) => {
  const key = '"probe_error": ';
  let at = -1;
  for (let seen = 0; seen <= index; seen += 1) {
    at = text.indexOf(key, at + 1);
    if (at < 0) throw new Error("probe_error: occurrence " + index + " not found — upstream changed");
  }
  const start = at + key.length;
  let end = start + 1;
  while (end < text.length && text[end] !== '"') {
    if (text[end] === "\\") end += 1;
    end += 1;
  }
  const current = text.slice(start, end + 1);
  const next = JSON.stringify(value);
  if (current !== next) text = text.slice(0, start) + next + text.slice(end + 1);
  return text;
};

const OVERLAY_INJECT = [
  "  ctx.slots.inject(",
  '    "shell.overlay",',
  '    () => ctx.slots.register({ name: "shell.overlay", id: "bili-upstreams", order: 100, label: () => t("upstreams_label"), locale: NS }, upstreamBanner())',
  "  );",
  "",
].join("\n");

export const patchBiliClientBundle = (source) => {
  let text = source;
  const steps = [];

  if (BANNER_MARKERS.every((marker) => !text.includes(marker))) {
    steps.push("upstream banner: already removed");
  } else {
    expectOne(text, "upstream banner", "var UPSTREAM_POLL_MS = 1e4;\n");
    text = text.replace("var UPSTREAM_POLL_MS = 1e4;\n", "");

    text = removeBlock(text, "parseUpstreamHealth", "function parseUpstreamHealth(raw) {");
    text = removeBlock(text, "upstreamBanner", "const upstreamBanner = () => () => {");

    expectOne(text, "upstream banner", OVERLAY_INJECT);
    text = text.replace(OVERLAY_INJECT, "");

    text = withoutKeys(text, "upstream banner", ["upstreams_label", "upstreams_down_one", "upstreams_down_many", "upstream_retry_hint"]);
    for (const marker of BANNER_MARKERS) {
      if (text.includes(marker)) throw new Error('upstream banner: "' + marker + '" survived the removal');
    }
    steps.push("upstream banner: removed");
  }

  text = replaceProbeLine(text, 0, "连接 bili 失败——最近一次连接错误（可复制用于反馈）：");
  text = replaceProbeLine(text, 1, "Failed to connect to bili — last connection error (copyable for reporting):");
  if (!text.includes("连接 bili 失败")) throw new Error("probe_error: the Chinese line did not take");
  steps.push("probe_error: worded for the reader");

  return { text, steps };
};

// CLI: node scripts/patch-bili-client.mjs [path-to-dsh-native-client.js]
if (process.argv[1] !== void 0 && process.argv[1].endsWith("patch-bili-client.mjs")) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(dirname(fileURLToPath(import.meta.url)));
  const target = process.argv[2] ?? join(here, "vendor", "billion-context", "dist", "agent", "dsh-native-client.js");
  const before = readFileSync(target, "utf8");
  const { text, steps } = patchBiliClientBundle(before);
  for (const step of steps) console.log(step);
  if (text !== before) {
    writeFileSync(target, text);
    console.log("wrote " + target);
  }
}
