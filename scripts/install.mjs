#!/usr/bin/env node
// Install this build over an existing billion-context installation, and wire
// dsh-plugin-model-request-accelerator into the same install unit.
//
// One install: after this script the profile lists billion-context as the only
// bundle for both features, so removing billion-context stops both — while each
// plugin keeps its own settings page, its own repository and its own upgrades.
//
// Runs the same way on macOS, Linux and Windows: no shell, no lsof, no cp.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ACCELERATOR = "dsh-plugin-model-request-accelerator";
const ACCELERATOR_REPO = "https://github.com/No-ni/dsh-plugin-model-request-accelerator.git";
const MARKER = "# --- model-request-accelerator: merged by billion-context-patched ---";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const takesValue = new Set(["--accelerator", "--accelerator-repo"]);
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (takesValue.has(arg)) {
    index += 1;
    continue;
  }
  if (!arg.startsWith("--")) positional.push(arg);
}
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const dryRun = argv.includes("--dry-run");
const compressionOnly = argv.includes("--compression-only");

const target = resolve(
  positional[0] ??
    process.env.BILI_PKG ??
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context"),
);
const profile = resolve(target, "..", "..");
const manifestPath = join(profile, "package.json");
const bundleLayerPath = join(target, "dsh.bundle.patch.yml");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!existsSync(join(target, "package.json")) || !existsSync(join(target, "dist"))) {
  fail("no billion-context installation at " + target);
}
if (!existsSync(manifestPath)) {
  fail("no profile manifest at " + manifestPath);
}
if (!existsSync(bundleLayerPath)) {
  fail("no bundle layer at " + bundleLayerPath);
}

const pad = (value) => String(value).padStart(2, "0");
const withStamp = (date) =>
  [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") +
  "-" +
  [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");

const backupOf = (file) => {
  const to = file + ".bak-" + withStamp(new Date());
  copyFileSync(file, to);
  return to;
};

// ── 1. the patched build ────────────────────────────────────────────────────
const installedBuild = join(target, "dist", "index.js");
if (dryRun) {
  console.log("would install " + join(here, "..", "dist", "index.js") + " into " + installedBuild);
} else {
  const buildBackup = backupOf(installedBuild);
  copyFileSync(join(here, "..", "dist", "index.js"), installedBuild);

  // The package ships index.js as an executable script; keep that bit set on
  // POSIX. On Windows chmod is a no-op, which is exactly right.
  try {
    chmodSync(installedBuild, 0o755);
  } catch {}

  console.log("installed into " + target);
  console.log("build backup: " + buildBackup);
}

if (compressionOnly) {
  console.log("compression only: skipped the accelerator merge (--compression-only)");
  console.log("restart the bili proxy to activate: node scripts/restart.mjs");
  process.exit(0);
}

// ── 2. the accelerator package ──────────────────────────────────────────────
const acceleratorCandidates = [
  join(profile, "plugins", ACCELERATOR),
  join(profile, "plugins", "model-request-accelerator"),
];
const acceleratorPath = resolve(
  option("--accelerator") ??
    acceleratorCandidates.find((path) => existsSync(join(path, "package.json"))) ??
    acceleratorCandidates[0],
);
const acceleratorManifest = join(acceleratorPath, "package.json");

if (!existsSync(acceleratorManifest)) {
  const repo = option("--accelerator-repo") ?? process.env.ACCELERATOR_REPO ?? ACCELERATOR_REPO;
  if (dryRun) {
    console.log("would clone " + repo + " into " + acceleratorPath);
  } else {
    mkdirSync(dirname(acceleratorPath), { recursive: true });
    console.log("cloning " + repo + " into " + acceleratorPath);
    execFileSync("git", ["clone", "--depth", "1", repo, acceleratorPath], { stdio: "inherit" });
  }
}

if (existsSync(acceleratorManifest)) {
  const declared = JSON.parse(readFileSync(acceleratorManifest, "utf8")).name;
  if (declared !== ACCELERATOR) {
    fail(acceleratorManifest + " declares " + declared + ", expected " + ACCELERATOR);
  }
  console.log("accelerator: " + acceleratorPath);
}

// ── 3. the profile: dependency yes, bundle no ───────────────────────────────
// The row comes from billion-context's bundle layer, so the accelerator's own
// layer has to stay unpublished — two bundles inserting the same row is a
// duplicate entry, not a merge. The dependency stays: it is what puts the
// package on the module path the loader resolves the row's name from.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dependencies = (manifest.dependencies ??= {});
const bundleOwner = manifest.dsh?.profile;
if (!bundleOwner || !Array.isArray(bundleOwner.bundles)) {
  fail(manifestPath + " has no dsh.profile.bundles list");
}

const relativePath = relative(profile, acceleratorPath).split(sep).join("/");
const spec = "link:" + (relativePath.startsWith(".") ? relativePath : "./" + relativePath);

const manifestChanges = [];
if (dependencies[ACCELERATOR] !== spec) {
  dependencies[ACCELERATOR] = spec;
  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  );
  manifestChanges.push("dependency " + ACCELERATOR + " = " + spec);
}
if (bundleOwner.bundles.includes(ACCELERATOR)) {
  bundleOwner.bundles = bundleOwner.bundles.filter((name) => name !== ACCELERATOR);
  manifestChanges.push("removed from dsh.profile.bundles");
}

if (manifestChanges.length > 0 && !dryRun) {
  const manifestBackup = backupOf(manifestPath);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("profile: " + manifestChanges.join(", ") + " (backup " + manifestBackup + ")");
} else if (manifestChanges.length > 0) {
  console.log("would update profile: " + manifestChanges.join(", "));
} else {
  console.log("profile: already wired");
}

// pnpm's link: dependency resolves through this symlink; creating it here keeps
// the merge to one command instead of a pnpm install round trip.
const linkPath = join(profile, "node_modules", ACCELERATOR);
if (!existsSync(linkPath)) {
  if (dryRun) {
    console.log("would link " + linkPath + " -> " + acceleratorPath);
  } else {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(acceleratorPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    console.log("linked " + linkPath + " -> " + acceleratorPath);
  }
}

// ── 4. the bundle layer: one extra insert ───────────────────────────────────
const block = [
  "",
  MARKER,
  "# billion-context is the only bundle this profile lists for both features: the",
  "# row below is what mounts the accelerator, so uninstalling billion-context",
  "# takes the accelerator with it. The accelerator keeps its own bundle patch,",
  "# settings page and release cadence; none of its code is copied into this build.",
  "- insert:",
  "    - id: model-request-accelerator",
  "      name: " + ACCELERATOR,
  "",
].join("\n");

const current = readFileSync(bundleLayerPath, "utf8");
const head = (
  current.includes(MARKER) ? current.slice(0, current.indexOf(MARKER)) : current
).replace(/\s+$/, "");
const next = head + "\n" + block;

if (current === next) {
  console.log("bundle layer: accelerator row already present");
} else if (dryRun) {
  console.log("would append the accelerator row to " + bundleLayerPath);
} else {
  const layerBackup = backupOf(bundleLayerPath);
  writeFileSync(bundleLayerPath, next);
  console.log("bundle layer: accelerator row appended (backup " + layerBackup + ")");
}

console.log("");
console.log("one install unit: billion-context mounts both plugins.");
console.log("restart DSH to activate (HMR recomposes on its own when it is enabled).");
console.log("restart the bili proxy for the compression build: node scripts/restart.mjs");
