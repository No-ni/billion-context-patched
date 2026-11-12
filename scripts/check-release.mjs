#!/usr/bin/env node
// One parser supplies both the local check and the release archive's notes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const stableVersion = version => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) && version.split('.').every(part => Number.isSafeInteger(Number(part)));
export function releaseInfo(manifest, changelog, tag) {
  assert(stableVersion(manifest.version), "package version must be a stable three-part version");
  const sections = [...changelog.matchAll(/^## (.+)$/gm)];
  assert.equal(sections[0]?.[1], "Unreleased", "CHANGELOG must start with ## Unreleased");
  const latest = sections[1];
  assert(latest, "CHANGELOG has no version entry");
  assert.match(latest[1], /^\d+\.\d+\.\d+ · \d{4}-\d{2}-\d{2}$/, "latest entry needs a version and date");
  assert.equal(latest[1].split(" · ")[0], manifest.version, "package and latest CHANGELOG version differ");
  const unreleased = changelog.slice(sections[0].index + sections[0][0].length, latest.index)
    .replace(/<!--[\s\S]*?-->/g, "").trim();
  const notes = changelog.slice(latest.index + latest[0].length, sections[2]?.index ?? changelog.length).trim();
  assert(notes && /^- /m.test(notes), "latest release notes must contain user-facing changes");
  if (tag !== undefined) {
    assert.equal(tag, "v" + manifest.version, "tag and package version differ");
    assert.equal(unreleased, "", "tagged release still has Unreleased changes");
  }
  return { version: manifest.version, notes, unreleased };
}
export function currentRelease(tag) {
  const info = releaseInfo(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
    readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), tag);
  if (tag !== undefined) {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    assert.equal(git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`), git("rev-parse", "HEAD"), "tag must name the checked-out commit");
  }
  return info;
}
function selfCheck() {
  const manifest = { version: "1.2.3" }, text = "# 更新记录\n\n## Unreleased\n\n## 1.2.3 · 2026-11-12\n\n- 用户可见修复。\n\n## 1.2.2 · 2026-11-11\n\n- 旧修复。\n";
  assert.equal(releaseInfo(manifest, text, "v1.2.3").notes, "- 用户可见修复。");
  assert.throws(() => releaseInfo(manifest, text, "v1.2.4"));
  assert.throws(() => releaseInfo({ version: "1.2.4" }, text));
  const pending = text.replace("## Unreleased\n", "## Unreleased\n\n- 待发布。\n");
  assert(releaseInfo(manifest, pending).unreleased);
  assert.throws(() => releaseInfo(manifest, pending, "v1.2.3"));
  assert.throws(() => releaseInfo(manifest, text.replace("- 用户可见修复。", "")));
  assert(!stableVersion("01.2.3") && !stableVersion("1.2.3-beta") && !stableVersion("99999999999999999.2.3"));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  selfCheck();
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 2 && args[0] === "--tag", "usage: check-release.mjs [--tag vX.Y.Z]");
  let tag = args[1];
  // A next-version candidate can be prepared while HEAD still names the old
  // release. Implicit tag checks describe committed metadata only; packaging
  // always supplies an explicit tag and requires the entire tree to be clean.
  const metadataChanged = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "package.json", "CHANGELOG.md"], { cwd: root, encoding: "utf8" }).trim();
  if (!tag && !metadataChanged) {
    const tags = execFileSync("git", ["tag", "--points-at", "HEAD", "--list", "v*"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const present of tags) currentRelease(present);
  }
  const info = currentRelease(tag);
  console.log(`release metadata: ${info.version} OK${tag ? " (" + tag + ")" : ""}`);
}
