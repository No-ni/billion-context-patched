#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFileSync(join(root, file), "utf8");
const spec = read("docs/SPEC.md"), maintenance = read("docs/MAINTENANCE.md");
const expected = [], expectedMapped = [];
for (const family of ["B", "W", "I"]) {
  const ranges = [...spec.matchAll(new RegExp(`\\b${family}1–${family}(\\d+)\\b`, "g"))];
  assert(ranges.length, "SPEC must declare its stable " + family + " range");
  const last = Math.max(...ranges.map(match => Number(match[1])));
  for (let n = 1; n <= last; n++) {
    const id = family + n;
    expected.push(id);
    expectedMapped.push(id);
  }
}
const imageRange = spec.match(/\bIMG-01–IMG-(\d{2})\b/);
assert(imageRange, "SPEC must declare its stable image ID range");
for (let n = 1; n <= Number(imageRange[1]); n++) {
  const id = "IMG-" + String(n).padStart(2, "0");
  assert(spec.includes("**" + id + " "), "SPEC must define " + id);
  expected.push(id);
}
const mapped = [...maintenance.matchAll(/^\| ((?:B|W|I)\d+) \|/gm)].map(match => match[1]);
assert.equal(new Set(mapped).size, mapped.length, "duplicate implementation mappings");
assert.deepEqual(mapped.toSorted(), expectedMapped.toSorted(), "SPEC and implementation/check mappings differ");
const rolloutBuild = read("vendor/billion-context/dist/index.js");
assert.match(rolloutBuild, /pluginMsgIdIncremental:\{percent:0\}/, "R1 incremental message IDs must default to 0%");
const rolloutPlan = rolloutBuild.match(/ROLLOUT_FEATURES=\{[^;]+;/)?.[0];
const rolloutFunctions = rolloutBuild.slice(
  rolloutBuild.indexOf("function rolloutEnvName("),
  rolloutBuild.indexOf("function rolloutDecisions("),
);
assert(rolloutPlan && rolloutFunctions.startsWith("function rolloutEnvName("), "R1 rollout resolver must be present");
const resolveRollout = new Function(
  "createHash10",
  "BP_MAX",
  "const " + rolloutPlan + rolloutFunctions + "return resolveRollout;",
)(createHash, 10000);
const rolloutFeature = "pluginMsgIdIncremental";
const rolloutId = "maintenance-check";
assert.equal(resolveRollout(rolloutFeature, { id: rolloutId, file: {}, env: {} }).enabled, false, "R1 default must disable incremental IDs");
const explicitlyEnabled = { features: { [rolloutFeature]: true } };
assert.equal(resolveRollout(rolloutFeature, { id: rolloutId, file: explicitlyEnabled, env: {} }).enabled, true, "R1 must preserve explicit config on");
assert.equal(resolveRollout(rolloutFeature, { id: rolloutId, file: explicitlyEnabled, env: { BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL: "false" } }).enabled, false, "R1 environment override must take precedence");
assert(spec.includes("### R1：") && maintenance.includes("| R1 |"), "R1 must be documented and mapped");
assert(maintenance.includes("IMG-10") && maintenance.includes("check-image-budget.mjs"), "IMG-10 must map to its budget check");
assert(/IMG-11[^\n]*已删除/.test(maintenance), "IMG-11 must be marked deleted");
assert(!maintenance.includes("check-image-retention.mjs") || maintenance.includes("已删除"), "deleted image checks must not be required");
const pck = spec.match(/PCK-01–PCK-(\d+)/);
assert(pck);
for (let n = 1; n <= Number(pck[1]); n++) assert(spec.includes("### PCK-" + String(n).padStart(2, "0") + "："));
const intro = read("README.md");
assert(!/当前版本|^## \d+\.\d+\.\d+/m.test(intro), "README must stay a project overview; versions belong in CHANGELOG");
const documents = ["README.md", "AGENTS.md", "CHANGELOG.md", "patches/README.md"];
function collect(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) collect(join(dir, entry.name));
    else if (entry.isFile() && entry.name.endsWith(".md")) documents.push(join(dir, entry.name));
  }
}
collect("docs");
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const result = new Set(), seen = new Map();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (fenced || !/^#+ /.test(line)) continue;
    const base = line.replace(/^#+\s*/, "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    result.add(base + (count ? "-" + count : "")); seen.set(base, count + 1);
  }
  anchorCache.set(file, result); return result;
}
let links = 0;
for (const file of documents) {
  for (const match of read(file).matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    const link = match[1].replace(/^<|>$/g, "");
    if (/^[a-z]+:/i.test(link)) continue;
    const [target, fragment] = link.split("#");
    const path = target ? resolve(root, dirname(file), decodeURIComponent(target)) : resolve(root, file);
    assert(existsSync(path), `${file}: missing target ${link}`);
    if (fragment && extname(path) === ".md") assert(anchors(path).has(decodeURIComponent(fragment)), `${file}: missing anchor ${link}`);
    links++;
  }
}
console.log(`maintenance: ${expected.length} B/W/I/IMG stable IDs, ${documents.length} documents, ${links} local links OK`);
