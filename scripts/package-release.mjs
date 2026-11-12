#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { root, currentRelease } from "./check-release.mjs";

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--tag", "usage: node scripts/package-release.mjs --tag vX.Y.Z");
const info = currentRelease(args[1]);
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "", "package the clean, checked tag only");
const out = resolve(root, "release-artifacts");
mkdirSync(out, { recursive: true });
const name = `bili-context-patch-${info.version}.zip`, zip = join(out, name);
execFileSync("git", ["archive", "--format=zip", "--prefix=bili-context-patch/", "-o", zip, "HEAD"], { cwd: root, stdio: "inherit" });
const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(join(out, "SHA256SUMS"), `${hash}  ${name}\n`);
writeFileSync(join(out, "release-notes.md"), info.notes + "\n");
console.log(`packaged ${name}\n${hash}`);
