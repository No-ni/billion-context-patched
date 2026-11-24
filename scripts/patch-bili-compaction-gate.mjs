#!/usr/bin/env node
// Guard the optional runtime preset lookup used by the compaction gate.
// Newer DSH hosts expose agentPresets only through inject(), and reading the
// traceable context property outside an injected scope throws instead of
// returning undefined. The gate must still provide its compaction service when
// runtime preset coverage is unavailable.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = 'function presetRegistryOf(ctx){if(ctx.agentPresets!==void 0)return ctx.agentPresets;if(typeof ctx.get!=="function")return void 0;const candidate=ctx.get("agentPresets");return candidate===null||typeof candidate!=="object"?void 0:candidate}';
const patched = 'function presetRegistryOf(ctx){try{if(ctx.agentPresets!==void 0)return ctx.agentPresets;if(typeof ctx.get!=="function")return void 0;const candidate=ctx.get("agentPresets");return candidate===null||typeof candidate!=="object"?void 0:candidate}catch{return void 0}}';

export function patchBiliCompactionGate(source) {
  if (typeof source !== "string") throw new TypeError("compaction gate: source must be a string");
  const originalCount = source.split(original).length - 1;
  const patchedCount = source.split(patched).length - 1;
  if (originalCount === 1 && patchedCount === 0) {
    return { text: source.replace(original, patched), step: "preset lookup guarded" };
  }
  if (originalCount === 0 && patchedCount === 1) {
    return { text: source, step: "preset lookup already guarded" };
  }
  throw new Error("compaction gate preset lookup: expected one unpatched or already guarded helper");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolve(process.argv[2] ?? fileURLToPath(new URL("../vendor/billion-context/dist/agent/dsh-compaction-gate.js", import.meta.url)));
  const source = readFileSync(target, "utf8");
  const candidate = patchBiliCompactionGate(source);
  console.log(candidate.step);
  if (candidate.text !== source) {
    writeFileSync(target, candidate.text);
    console.log("wrote " + target);
  }
}
