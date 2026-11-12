#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFileSync(join(root, file), "utf8");
const spec = read("docs/SPEC.md"), maintenance = read("docs/MAINTENANCE.md");
const expected = [];
for (const family of ["B", "W", "I"]) {
  const ranges = [...spec.matchAll(new RegExp(`\\b${family}1–${family}(\\d+)\\b`, "g"))];
  assert(ranges.length, "SPEC must declare its stable " + family + " range");
  const last = Math.max(...ranges.map(match => Number(match[1])));
  for (let n = 1; n <= last; n++) expected.push(family + n);
}
const mapped = [...maintenance.matchAll(/^\| ((?:B|W|I)\d+) \|/gm)].map(match => match[1]);
assert.equal(new Set(mapped).size, mapped.length, "duplicate implementation mappings");
assert.deepEqual(mapped.toSorted(), expected.toSorted(), "SPEC and implementation/check mappings differ");
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
console.log(`maintenance: ${expected.length} stable IDs, ${documents.length} documents, ${links} local links OK`);
