#!/usr/bin/env node
// Install this build over an existing billion-context installation and expose
// the result as ONE Loader entry named bili-context-patch.
//
// Why a wrapper package instead of a second bundle row: the Plugins settings
// list renders one card per Loader entry, and the host serves one client bundle
// per entry. Listing billion-context and the accelerator as two rows can never
// be one card. So this install writes a small package that
//   - mounts billion-context, its compaction gate and the accelerator as child
//     plugins (host half), and
//   - concatenates both client bundles into one factory (browser half).
// Neither upstream package is modified or copied: the loader resolves both from
// the profile's node_modules, so upgrading either means re-running this script.
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

const WRAPPER = "bili-context-patch";
const UPSTREAM = "billion-context";
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
    join(homedir(), ".dsh", "profiles", "desktop", "node_modules", UPSTREAM),
);
const profile = resolve(target, "..", "..");
const manifestPath = join(profile, "package.json");
const patchPath = join(profile, "cordis.patch.yml");
const bundleLayerPath = join(target, "dsh.bundle.patch.yml");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const say = (message) => console.log(message);

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
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(pad).join("") +
  "-" +
  [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join("");

const backupOf = (file) => {
  const to = file + ".bak-" + withStamp(new Date());
  copyFileSync(file, to);
  return to;
};

const writeWithBackup = (file, content) => {
  const backup = existsSync(file) ? backupOf(file) : null;
  writeFileSync(file, content);
  return backup;
};

// ── 1. the patched build ────────────────────────────────────────────────────
const installedBuild = join(target, "dist", "index.js");
if (dryRun) {
  say("would install " + join(here, "..", "dist", "index.js") + " into " + installedBuild);
} else {
  const buildBackup = backupOf(installedBuild);
  copyFileSync(join(here, "..", "dist", "index.js"), installedBuild);
  try {
    chmodSync(installedBuild, 0o755);
  } catch {}
  say("installed into " + target);
  say("build backup: " + buildBackup);
}

if (compressionOnly) {
  say("compression only: skipped the accelerator merge (--compression-only)");
  say("restart the bili proxy to activate: node scripts/restart.mjs");
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
    say("would clone " + repo + " into " + acceleratorPath);
  } else {
    mkdirSync(dirname(acceleratorPath), { recursive: true });
    say("cloning " + repo + " into " + acceleratorPath);
    execFileSync("git", ["clone", "--depth", "1", repo, acceleratorPath], { stdio: "inherit" });
  }
}
if (existsSync(acceleratorManifest)) {
  const declared = JSON.parse(readFileSync(acceleratorManifest, "utf8")).name;
  if (declared !== ACCELERATOR) {
    fail(acceleratorManifest + " declares " + declared + ", expected " + ACCELERATOR);
  }
  say("accelerator: " + acceleratorPath);
}

// ── 3. one merged client bundle from two factories ──────────────────────────
// Both halves follow the same contract: window.__ModuleLoader__.load({id,
// factory: (require) => { ... return module.exports; }}). Cutting the factory
// body out of each file and running it inside one loader call keeps both halves
// exactly as their authors wrote them, with the same require.
const extractFactory = (source, label) => {
  const marker = "factory: (require) => {";
  const at = source.indexOf(marker);
  if (at < 0) fail(label + ": client bundle has no factory");
  let body = source.slice(at + marker.length).trimEnd();
  const tail = body.lastIndexOf("});");
  if (tail < 0 || !/}\)?;\s*$/.test(body.slice(tail))) {
    fail(label + ": unexpected client bundle tail");
  }
  body = body.slice(0, tail).trimEnd();
  if (!body.endsWith("}")) fail(label + ": factory body is not closed");
  body = body.slice(0, -1).trim();
  try {
    new Function("require", body);
  } catch (error) {
    fail(label + ": factory body does not parse after extraction: " + error.message);
  }
  return body;
};

const biliVersion = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
const templatePath = join(here, "..", "package", "lib", "client.template.js");
const template = readFileSync(templatePath, "utf8");
const biliClientBody = extractFactory(
  readFileSync(join(target, "dist", "agent", "dsh-native-client.js"), "utf8"),
  UPSTREAM,
);
const acceleratorClientBody = extractFactory(
  readFileSync(join(acceleratorPath, "lib", "client.js"), "utf8"),
  ACCELERATOR,
);
const mergedClient = template
  .replace("/*__BILI_FACTORY__*/", () => biliClientBody)
  .replace("/*__ACCELERATOR_FACTORY__*/", () => acceleratorClientBody);

// ── 4. the wrapper's bundle layer ───────────────────────────────────────────
// billion-context's own layer supplies the compaction gate wiring that the host
// plane needs (compaction-basic off, presets waiting on the gate, retry policy).
// The wrapper keeps all of it and drops only the two insert rows: those plugins
// are mounted by the wrapper's host half, and a second row would be a second
// Loader entry — exactly the second card this change removes.
const stripInserts = (text) => {
  const kept = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (skipping) {
      if (line.startsWith(" ") || line.trim() === "") continue;
      skipping = false;
    }
    if (line.startsWith("- insert:")) {
      skipping = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
};

const layerSource = readFileSync(bundleLayerPath, "utf8");
const layerHead = layerSource.includes(MARKER)
  ? layerSource.slice(0, layerSource.indexOf(MARKER))
  : layerSource;
// The wrapper still needs ONE insert row: a bundle listed in the profile is only
// a layer provider, it does not become a Loader entry by itself. That row is the
// single entry: a patch block addressing the wrapper by id lands on it, and its
// client bundle is the merged one. billion-context and the gate get no row of
// their own — they are mounted by this entry's host half.
const wrapperLayer =
  "# bili-context-patch bundle layer - generated by scripts/install.mjs.\n" +
  "# One Loader entry for the whole install unit. The wrapper's host half mounts\n" +
  "# billion-context, its compaction gate and the accelerator; the two upstream\n" +
  "# insert rows are deliberately absent. The rest is billion-context's own\n" +
  "# wiring (compaction gate, compaction-basic, preset inject, retry policy).\n" +
  "- insert:\n" +
  "    - id: " + WRAPPER + "\n" +
  "      name: " + WRAPPER + "\n" +
  stripInserts(layerHead).replace(/\s+$/, "") +
  "\n";

const wrapperManifestPath = join(here, "..", "package", "package.json");
const wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, "utf8"));
wrapperManifest.version = biliVersion + "-patch.1";

// ── 5. write the wrapper package ────────────────────────────────────────────
const wrapperDir = join(profile, "plugins", WRAPPER);
const wrapperFiles = [
  [join(wrapperDir, "package.json"), JSON.stringify(wrapperManifest, null, 2) + "\n"],
  [join(wrapperDir, "lib", "index.js"), readFileSync(join(here, "..", "package", "lib", "index.js"), "utf8")],
  [join(wrapperDir, "lib", "client.js"), mergedClient],
  [join(wrapperDir, "dsh.bundle.patch.yml"), wrapperLayer],
];
for (const [file, content] of wrapperFiles) {
  if (dryRun) {
    say("would write " + file + " (" + content.length + " bytes)");
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
if (!dryRun) say("wrapper package: " + wrapperDir);

// pnpm's link: dependency resolves through this symlink; creating it here keeps
// the merge to one command instead of a pnpm install round trip.
const linkPath = join(profile, "node_modules", WRAPPER);
if (!existsSync(linkPath)) {
  if (dryRun) {
    say("would link " + linkPath + " -> " + wrapperDir);
  } else {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(wrapperDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    say("linked " + linkPath + " -> " + wrapperDir);
  }
}
const acceleratorLink = join(profile, "node_modules", ACCELERATOR);
if (!existsSync(acceleratorLink)) {
  if (dryRun) {
    say("would link " + acceleratorLink + " -> " + acceleratorPath);
  } else {
    mkdirSync(dirname(acceleratorLink), { recursive: true });
    symlinkSync(acceleratorPath, acceleratorLink, process.platform === "win32" ? "junction" : "dir");
    say("linked " + acceleratorLink + " -> " + acceleratorPath);
  }
}

// ── 6. the profile: one bundle row for both features ────────────────────────
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dependencies = (manifest.dependencies ??= {});
const bundleOwner = manifest.dsh?.profile;
if (!bundleOwner || !Array.isArray(bundleOwner.bundles)) {
  fail(manifestPath + " has no dsh.profile.bundles list");
}

const linkSpec = (path) => {
  const rel = relative(profile, path).split(sep).join("/");
  return "link:" + (rel.startsWith(".") ? rel : "./" + rel);
};
const wrapperSpec = linkSpec(wrapperDir);
const acceleratorSpec = linkSpec(acceleratorPath);

const changes = [];
const bundles = [];
for (const name of bundleOwner.bundles) {
  if (name === ACCELERATOR) continue;
  if (name === UPSTREAM) {
    if (!bundles.includes(WRAPPER)) bundles.push(WRAPPER);
    continue;
  }
  if (name !== WRAPPER) bundles.push(name);
}
if (!bundles.includes(WRAPPER)) bundles.push(WRAPPER);
if (JSON.stringify(bundles) !== JSON.stringify(bundleOwner.bundles)) {
  bundleOwner.bundles = bundles;
  changes.push("bundles -> " + bundles.join(", "));
}

const nextDependencies = { ...dependencies, [WRAPPER]: wrapperSpec, [ACCELERATOR]: acceleratorSpec };
manifest.dependencies = Object.fromEntries(
  Object.entries(nextDependencies).sort(([left], [right]) => left.localeCompare(right)),
);
if (JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencies)) {
  changes.push("dependencies: " + WRAPPER + " and " + ACCELERATOR + " linked");
}

if (changes.length > 0 && !dryRun) {
  const manifestBackup = backupOf(manifestPath);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  say("profile: " + changes.join("; ") + " (backup " + manifestBackup + ")");
} else if (changes.length > 0) {
  say("would update profile: " + changes.join("; "));
} else {
  say("profile: already wired");
}

// ── 7. the channel switches follow the entry ────────────────────────────────
// The profile patch targets the accelerator entry by id. The entry is gone, so
// the same config block has to address the wrapper instead, otherwise the
// provider toggles silently fall back to defaults.
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, "utf8");
  const nextPatch = patch
    .replace(/^(- id: )model-request-accelerator$/m, "$1" + WRAPPER)
    .replace(/^(\s+name: )dsh-plugin-model-request-accelerator$/m, "$1" + WRAPPER);
  if (nextPatch !== patch) {
    if (dryRun) {
      say("would retarget the channel switches in " + patchPath + " to " + WRAPPER);
    } else {
      const patchBackup = backupOf(patchPath);
      writeFileSync(patchPath, nextPatch);
      say("channel switches retargeted to " + WRAPPER + " (backup " + patchBackup + ")");
    }
  } else {
    say("channel switches: already on " + WRAPPER);
  }
}

// Earlier versions of this script appended an insert row to billion-context's
// own layer. That row is what step 6 removes; leaving the text behind would
// resurrect the row on the next bundle reset.
if (!dryRun && layerSource.includes(MARKER)) {
  writeWithBackup(bundleLayerPath, layerHead.replace(/\s+$/, "") + "\n");
  say("removed the old insert row from " + bundleLayerPath);
}

say("");
say("done. Restart DSH, then check Settings > Plugins: one card, " + WRAPPER + ".");
say("Both settings pages (billion-context and 模型请求加速) stay where they are.");
