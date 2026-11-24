#!/usr/bin/env node
// Patch the selected complete native bundle before installer replacement.
// Its WebSocket identity stamps must override host case variants and tuples.
// Its config registry must recognize the DSH-native image budget keys consumed
// by the proxy.
//
//   node scripts/patch-bili-agent.mjs [dist/agent/dsh-native.js]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uniqueBlockSpan } from "./patch-bili-client.mjs";

export const NATIVE_WS_HEADERS_MARKERS = [
  "// <bili-native-ws-headers begin>",
  "// <bili-native-ws-headers end>",
];
const replacement = readFileSync(new URL("../patches/native-ws-headers.block.js", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n").trimEnd();

// Exact compiled helper from fixed upstream 0d94a8a2. Parse its boundary before
// comparing the baseline, so nested braces never turn a partial match into a
// successful patch. A changed upstream implementation needs a fresh audit.
const original = 'function mergeWsInitHeaders(arg,extra){if(extra===void 0||Object.keys(extra).length===0)return arg;if(arg===void 0||arg===null)return{headers:{...extra}};if(typeof arg==="string"||Array.isArray(arg))return{protocols:arg,headers:{...extra}};if(typeof arg==="object"){const init={...arg};const h=init.headers;if(h===void 0||h===null){init.headers={...extra}}else if(h instanceof Headers){const merged=new Headers(h);for(const[k2,v2]of Object.entries(extra))merged.set(k2,v2);init.headers=merged}else if(Array.isArray(h)){init.headers=[...h,...Object.entries(extra)]}else if(typeof h==="object"){init.headers={...h,...extra}}else{return arg}return init}return arg}';
const originalConfigKeys = ',"autoModeForge","imageRescale","guardrails","cacheKeepalive","egressTransforms"]);';
// Builds from the previous release already list the budget keys but predate the
// host-offload switch; migrate that exact form instead of rejecting the build.
const legacyPatchedConfigKeys = ',"autoModeForge","imageRescale","maxRequestImages","imageOffloadCountQuantum","requestImageMaxBytes","requestImagePixelBudget","maxRequestImageBytes","guardrails","cacheKeepalive","egressTransforms"]);';
const patchedConfigKeys = ',"autoModeForge","imageRescale","maxRequestImages","imageOffloadCountQuantum","imageRestoreHostOffload","requestImageMaxBytes","requestImagePixelBudget","maxRequestImageBytes","guardrails","cacheKeepalive","egressTransforms"]);';
// Use the native plugin's config path and parser, but fail closed on a broken
// draft rather than writing defaults from loadConfigFile's empty fallback. The
// proxy's budget installer reads the same file, so the export is not image
// behavior; it only reports whether the user authored a budget by hand.
// The minifier renumbers local fs aliases between builds (readFileSync2 became
// readFileSync3 in the 8cdad29 build), so the appended reader must borrow the
// alias loadConfigFile actually uses instead of pinning one name. Only the shape
// of that call is contractual: function loadConfigFile() reading configFile()
// through readFileSyncN(pathN,"utf8") and parsing it with parseBiliConfig(raw).
const configReaderAlias = (source) => {
  const matches = [...source.matchAll(/(?<![\w$])function\s+loadConfigFile\s*\(\s*\)\s*\{/g)];
  if (matches.length !== 1) throw new Error("native config reader: expected one loadConfigFile declaration, found " + matches.length + " — re-derive the patch");
  const body = source.slice(matches[0].index, matches[0].index + 400);
  const call = body.match(/readFileSync[\d]*\(path[\d]*,"utf8"\)/);
  if (!call) throw new Error("native config reader: loadConfigFile no longer reads its file through readFileSync(path,\"utf8\") — re-derive the patch");
  return call[0].slice(0, call[0].indexOf("("));
};
const configReaderFor = alias => `export { configFile as biliConfigPath };
export function readBiliConfig(path) {
  try { return parseBiliConfig(${alias}(path,"utf8").replace(/^\\uFEFF/,"")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}`;

const helperSpan = (source) => {
  const matches = [...source.matchAll(/(?<![\w$])function\s+mergeWsInitHeaders\s*\(/g)];
  if (matches.length !== 1) throw new Error("native WS headers: expected one mergeWsInitHeaders declaration, found " + matches.length + " — re-derive the patch");
  return uniqueBlockSpan(source, "native WS headers", matches[0][0], { expression: true });
};

/** Return a checked candidate string without changing the selected package. */
export function patchBiliAgentBundle(source) {
  if (typeof source !== "string") throw new TypeError("native agent: source must be a string");
  if (source.includes("readBiliImageConfig")) {
    throw new Error("native image config reader: this build still carries the removed image patches — rebuild from a clean upstream");
  }
  const configAnchors = [originalConfigKeys, legacyPatchedConfigKeys, patchedConfigKeys];
  const configCounts = configAnchors.map(anchor => source.split(anchor).length - 1);
  if (configCounts.reduce((sum, count) => sum + count, 0) !== 1) {
    throw new Error("native image budget config keys: expected one original, legacy, or patched anchor — re-derive the patch");
  }
  const configIndex = configCounts.indexOf(1);
  const configStep = "native image budget config keys: " +
    (configIndex === 2 ? "already patched" : configIndex === 1 ? "migrated from the previous patch" : "patched");
  source = source.replace(configAnchors[configIndex], patchedConfigKeys);
  if (!source.includes("function readBiliConfig(path) {")) {
    if (source.includes("readBiliConfig") || !/function configFile\(\)\{|function loadConfigFile\(\)/.test(source) ||
        !source.includes("parseBiliConfig(raw)")) {
      throw new Error("native config reader: upstream changed");
    }
    source += "\n" + configReaderFor(configReaderAlias(source)) + "\n";
  }
  const span = helperSpan(source);
  const block = source.includes("\r\n") ? replacement.replaceAll("\n", "\r\n") : replacement;
  const [begin, end] = NATIVE_WS_HEADERS_MARKERS;
  const counts = NATIVE_WS_HEADERS_MARKERS.map(marker => source.split(marker).length - 1);
  if (counts.some(count => count !== 0)) {
    if (counts.some(count => count !== 1)) throw new Error("native WS headers: incomplete or duplicate patch markers");
    const from = source.indexOf(begin), to = source.indexOf(end) + end.length;
    if (from >= span.start || to <= span.end || source.slice(from, to) !== block) {
      throw new Error("native WS headers: changed or reordered patched block — re-derive the patch");
    }
    return { text: source, steps: [configStep, "native WS headers: already patched"] };
  }
  if (span.block !== original) throw new Error("native WS headers: upstream helper changed — re-derive the patch");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const text = source.slice(0, span.start) + block + newline + source.slice(span.end);
  helperSpan(text);
  return { text, steps: [configStep, "native WS headers: authoritative stamps replace host case variants"] };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolve(process.argv[2] ?? fileURLToPath(new URL("../vendor/billion-context/dist/agent/dsh-native.js", import.meta.url)));
  const source = readFileSync(target, "utf8"), candidate = patchBiliAgentBundle(source);
  for (const step of candidate.steps) console.log(step);
  if (candidate.text !== source) {
    writeFileSync(target, candidate.text);
    console.log("wrote " + target);
  }
}
