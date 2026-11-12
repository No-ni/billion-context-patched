#!/usr/bin/env node
// Prepare reviewable files only. Git commits/tags/pushes need task authorization;
// GitHub Actions is the sole publisher for versions using the new workflow.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, currentRelease, stableVersion } from "./check-release.mjs";

const version = process.argv[2];
assert(process.argv.length === 3 && stableVersion(version), "usage: node scripts/release.mjs X.Y.Z");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain"), "", "commit/review existing work before preparing a version");
assert(git("branch", "--show-current"), "use a named branch");
assert.equal(git("rev-list", "--count", "HEAD..origin/main"), "0", "merge origin/main first (fetch it before preparing)");
const previous = currentRelease();
const left = version.split(".").map(Number), right = previous.version.split(".").map(Number);
const changed = left.findIndex((value, i) => value !== right[i]);
assert(changed >= 0 && left[changed] > right[changed], "new version must be greater than the current version");
assert(previous.unreleased, "record user-facing changes under Unreleased first");
assert(!git("tag", "--list", "v" + version), "version tag already exists");
const manifestPath = join(root, "package.json"), changesPath = join(root, "CHANGELOG.md");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(changesPath, readFileSync(changesPath, "utf8").replace(/^## Unreleased$/m,
  `## Unreleased\n\n## ${version} · ${new Date().toISOString().slice(0, 10)}`));
// Leave candidate edits available for review if build/check fails; do not reset
// or stash them automatically, and never claim that preparation published them.
for (const args of [["scripts/install.mjs", "--build"], ["scripts/check-all.mjs", "--offline"]]) {
  execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
}
console.log(`Prepared ${version}; review the diff, then follow docs/RELEASING.md. Nothing committed or published.`);
