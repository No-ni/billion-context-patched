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
// The settings page looks its namespace up by the entry id it was keyed under.
// Fresh installs keyed the accelerator's own entry `model-request-accelerator`;
// this entry is `bili-context-patch`, so the page's constant has to follow or it
// finds no document and renders read-only. Rewriting the one literal in the
// generated bundle keeps the accelerator's repository untouched.
const NS_LITERAL = 'const NS = "model-request-accelerator";';
const NS_REWRITTEN = 'const NS = "' + WRAPPER + '";';
const occurrences = acceleratorClientBody.split(NS_LITERAL).length - 1;
if (occurrences !== 1) {
  fail(
    ACCELERATOR +
      ": expected exactly one '" +
      NS_LITERAL +
      "' in the client bundle, found " +
      occurrences +
      " — the settings page would look under the wrong namespace",
  );
}

const mergedClient = template
  .replace("/*__BILI_FACTORY__*/", () => biliClientBody)
  .replace("/*__ACCELERATOR_FACTORY__*/", () => acceleratorClientBody.replace(NS_LITERAL, NS_REWRITTEN));

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

// The two upstream packages stay in the bundle list on purpose. Their rows are
// switched off by an expression (step 8), not by removing them from this list,
// so switching the wrapper off in the plugin page brings both of them back
// instead of leaving the user with nothing. Keeping them listed also stops the
// plugin manager from re-adding them behind our back later.
const changes = [];
const wanted = [WRAPPER, UPSTREAM, ACCELERATOR];
const bundles = [];
for (const name of bundleOwner.bundles) {
  if (wanted.includes(name)) {
    if (!bundles.includes(name)) bundles.push(name);
    continue;
  }
  bundles.push(name);
}
for (const name of wanted) if (!bundles.includes(name)) bundles.push(name);
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
// The rewrite itself happens in step 8, so the file is read and written once.
const patchBefore = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : null;

// ── 8. keep the two upstream entries shut ───────────────────────────────────
// DSH's plugin manager reconciles bundles after every package operation:
//   for (const dependency of after.dependencies)
//     if (dependency.bundle && !disabled.has(dependency.name) && !bundles.includes(dependency.name))
//       bundles.push(dependency.name);
// Both upstream packages stay as dependencies — that is what puts them on the
// module path the wrapper imports from — and both declare a bundle patch, so a
// plain "add/remove another plugin" in the UI silently puts them back into
// dsh.profile.bundles. Their rows would then mount a second billion-context and
// a second accelerator: three cards again, and two plugins serving one service.
//
// The profile patch is the last layer applied, after every bundle layer, so a
// disabled row here wins no matter what the manager writes into the bundle
// list. Idempotent: rows are rewritten in place, never duplicated.
/** Rows the wrapper replaces; only stale pins of these are cleaned up here. */
const pinned = ["bili-native", "bili-compaction-gate", "model-request-accelerator"];

/** Split a patch file into id blocks and raw lines, so a rewrite can address whole rows. */
const splitPatch = (text) => {
  const blocks = [];
  let current = null;
  for (const line of text.replace(/\s+$/, "").split("\n")) {
    const match = /^- id: (\S+)\s*$/.exec(line);
    if (match !== null) {
      current = { id: match[1], header: line, body: [] };
      blocks.push(current);
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) {
      current.body.push(line);
      continue;
    }
    current = null;
    blocks.push({ raw: line });
  }
  return blocks;
};

const joinPatch = (blocks) =>
  blocks
    .map((block) => (block.raw !== undefined ? block.raw : [block.header, ...block.body].join("\n")))
    .join("\n") + "\n";

/** A row that carries nothing but `disabled:` — ours to rewrite, nobody else's. */
const onlyDisabled = (body) => body.every((line) => /^\s+disabled:/.test(line));

const rewritePatch = (text, wrapperId, pinnedIds) => {
  const notes = [];
  let blocks = splitPatch(text);

  // (a) Retarget the channel switches. Only the row that carries `config:` — a
  //     blind "first row with this id" would also rename the pin below, and that
  //     rename is what once left the wrapper itself switched off.
  blocks = blocks.map((block) => {
    if (block.id !== "model-request-accelerator") return block;
    if (!block.body.some((line) => /^\s+config:/.test(line))) return block;
    notes.push("channel switches -> " + wrapperId);
    return {
      id: wrapperId,
      header: "- id: " + wrapperId,
      body: block.body.map((line) =>
        line.replace(/^(\s+name: )dsh-plugin-model-request-accelerator\s*$/, "$1" + wrapperId),
      ),
    };
  });

  // (b) The wrapper's own row has to stay enabled: switching it off takes the
  //     compaction gate with it, and the agent presets then wait forever for a
  //     service nothing provides (#3662). A stray `disabled: true` here is always
  //     damage, never intent, so it is repaired rather than respected.
  let keptWrapperRow = false;
  blocks = blocks.filter((block) => {
    if (block.id !== wrapperId || !onlyDisabled(block.body)) return true;
    if (keptWrapperRow) {
      notes.push("dropped a duplicate " + wrapperId + " row");
      return false;
    }
    keptWrapperRow = true;
    if (!block.body.join(" ").includes("false")) notes.push("re-enabled the " + wrapperId + " row");
    block.body = ["  disabled: false"];
    return true;
  });

  // (c) The two upstream entries follow the wrapper's own switch. They stay in
  //     dsh.profile.bundles, and their rows are switched off by an expression
  //     rather than a constant, so one file answers both states:
  //       wrapper on  -> all three rows resolve to disabled, the wrapper entry
  //                      is the only thing mounted, and the page shows one card;
  //       wrapper off -> the expression is false and both packages mount again,
  //                      which is exactly the old two-plugin setup.
  //     The expression reads the sibling entry from the loader tree. A constant
  //     `true` here was wrong in the one case that matters: when the merge itself
  //     fails to load, the old plugins have to keep working.
  //     Verified with two real boots: the served client graph carries one package
  //     while the wrapper runs, and both upstream packages once it is off.
  const follow = "  disabled: !!js '!!(ctx.fiber.entry.subtree.store[" + JSON.stringify(wrapperId) + "]?.disabled === false)'";
  const seen = new Set();
  blocks = blocks.map((block) => {
    if (!pinnedIds.includes(block.id)) return block;
    if (!onlyDisabled(block.body)) {
      notes.push("left " + block.id + " alone: its row carries other keys");
      return block;
    }
    seen.add(block.id);
    if (block.body.join("|") === follow) return block;
    notes.push("linked " + block.id + " to " + wrapperId);
    return { id: block.id, header: block.header, body: [follow] };
  });
  for (const id of pinnedIds) {
    if (seen.has(id)) continue;
    notes.push("added a follow row for " + id);
    blocks.push({ id, header: "- id: " + id, body: [follow] });
  }

  return { text: joinPatch(blocks), notes };
};

if (patchBefore !== null) {
  const rewritten = rewritePatch(patchBefore, WRAPPER, pinned);
  if (rewritten.text !== patchBefore) {
    if (dryRun) {
      say("would rewrite " + patchPath + ": " + rewritten.notes.join("; "));
    } else {
      const patchBackup = backupOf(patchPath);
      writeFileSync(patchPath, rewritten.text);
      say("profile patch: " + rewritten.notes.join("; ") + " (backup " + patchBackup + ")");
    }
  } else {
    say("profile patch: already wired");
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
say("Switch that card off and billion-context plus the accelerator come back by themselves.");
say("Both settings pages (billion-context and 模型请求加速) stay where they are.");
