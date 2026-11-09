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
// Channels that should ship with request-body compression already on. Matching is
// by host, not by provider name: rename a provider or add another one later and
// the same rule still applies, as long as it points at one of these relays.
const COMPRESS_HOSTS = new Set(["www.didudidu.asia", "154.219.111.56"]);
// The wrapper's version lives in its own package.json (three parts, e.g. 0.1.0)
// and is bumped by hand when a patch is published: the version this repo shows
// and the one the update check compares against are the same field.

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
const candidateBuild = join(here, "..", "dist", "index.js");
// A build that fails its own smoke test never replaces a working one. The call
// that breaks in production is the user's next model request, and a backup on
// disk is no help to someone who does not know it is there. The test runs on the
// Node that will run the proxy - which is the point of it (scripts/smoke.mjs).
if (!dryRun && !argv.includes("--skip-smoke")) {
  say("smoke-testing the candidate build (" + process.version + ")");
  try {
    execFileSync(process.execPath, [join(here, "smoke.mjs"), candidateBuild], {
      stdio: "inherit",
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
  } catch {
    fail("smoke test failed; " + installedBuild + " was left untouched");
  }
}
if (dryRun) {
  say("would install " + candidateBuild + " into " + installedBuild);
} else {
  const buildBackup = backupOf(installedBuild);
  copyFileSync(candidateBuild, installedBuild);
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

// The "version / check for updates" row at the bottom of that page is the
// accelerator's, so by default it asks the accelerator's repository and pulls
// the accelerator's checkout. Inside the merged unit that row should report and
// update THIS package instead: it points at the wrapper's own endpoint, which
// pulls the patch repo and then regenerates the install.
const VERSION_LITERAL = 'const VERSION_PATH = "/api/model-request-accelerator/version";';
const VERSION_REWRITTEN = 'const VERSION_PATH = "/api/' + WRAPPER + '/version";';
const HINT_LITERAL = "更新会在本插件目录执行 git pull --ff-only；更新后需要重启 dsh web 才会生效。";
const HINT_REWRITTEN = "更新会拉取补丁仓库并重新生成包装包；完成后需要重启 dsh web 才会生效。";

// A literal that upstream renames would silently leave the old behaviour in
// place, so the ones that decide where the row points must match exactly once.
const rewriteOnce = (text, literal, replacement, what, { soft = false } = {}) => {
  const hits = text.split(literal).length - 1;
  if (hits !== 1) {
    const problem = "expected exactly one " + what + " in the client bundle, found " + hits;
    if (soft) return { text, ok: false, problem };
    fail(ACCELERATOR + ": " + problem);
  }
  return { text: text.replace(literal, () => replacement), ok: true };
};

const nsRewrite = rewriteOnce(acceleratorClientBody, NS_LITERAL, NS_REWRITTEN, "settings namespace literal");
const versionRewrite = rewriteOnce(nsRewrite.text, VERSION_LITERAL, VERSION_REWRITTEN, "version route literal");
const hintRewrite = rewriteOnce(versionRewrite.text, HINT_LITERAL, HINT_REWRITTEN, "update hint text", { soft: true });
if (!hintRewrite.ok) {
  say("warning: " + hintRewrite.problem + " — the hint still describes the accelerator's own git pull");
}
const acceleratorRebuilt = hintRewrite.text;

const mergedClient = template
  .replace("/*__BILI_FACTORY__*/", () => biliClientBody)
  .replace("/*__ACCELERATOR_FACTORY__*/", () => acceleratorRebuilt);

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

// Two upstream packages may or may not be installed here. Rows are written only
// for the ones that are: a row naming a package nobody installed does nothing
// but print "patch: entry ... not found" on every start.
const earlyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const installedDep = (name) =>
  Object.prototype.hasOwnProperty.call(earlyManifest.dependencies ?? {}, name) &&
  existsSync(join(profile, "node_modules", name));

void installedDep;

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
// Where this checkout lives, so the wrapper's own update action can pull it and
// regenerate the install without the user having to remember the path.
wrapperManifest.patchRepo = resolve(here, "..");
wrapperManifest.meta = { ...(wrapperManifest.meta ?? {}), upstream: UPSTREAM + "@" + biliVersion };

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

// Nothing else in the list is touched. Upstream packages, if the user happens to
// have them, stay exactly where they are: step 4's layer is what keeps their
// entries off, and that layer stops applying the moment this package is switched
// off or removed — which is the whole point of keeping the switching in here.
const changes = [];
const bundles = [];
const suppressed = new Set([UPSTREAM, ACCELERATOR]);
for (const name of bundleOwner.bundles) {
  if (!bundles.includes(name) && name !== WRAPPER && !suppressed.has(name)) bundles.push(name);
}
// The upstream packages come out of the list: entries are what the plugin page
// switches and what actually runs, so leaving them in means two live cards that
// only look switched off. They stay INSTALLED (the wrapper imports them by name)
// and they stay marked disabled in dependencies, which is the state the profile
// reconciler preserves. Turning either card on puts it back in this list and it
// runs on its own - the wrapper is not needed for that, and it does not fight it.
bundles.push(WRAPPER);
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

// ── 8. the profile patch: switches, and one leftover to clear ───────────────
// Two jobs, both idempotent.
//
// The channel switches of the accelerator are addressed by id, and the id is now
// the wrapper's, so that row has to be retargeted or the provider toggles fall
// back to their defaults.
//
// The other job is cleanup. The previous version wrote one "follow" row per
// upstream entry into this file — user configuration that the user never asked
// for and that could not survive being switched off. Those rows are removed;
// the switching is now generated into the wrapper's own bundle layer instead.
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

/**
 * Provider names whose endpoint is one of the relays in COMPRESS_HOSTS.
 * Walks backwards from every `baseURL:` line to the key at two columns less —
 * the provider name in a `providers:` map.
 * @param texts - profile config files, in any order.
 * @returns the matching provider names, each once.
 */
const channelsToCompress = (texts) => {
  const names = new Set();
  for (const text of texts) {
    if (!text) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^(\s*)baseURL:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i]);
      if (!match) continue;
      let host = "";
      try {
        host = new URL(match[2]).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!COMPRESS_HOSTS.has(host)) continue;
      const indent = match[1].length;
      for (let j = i - 1; j >= 0; j -= 1) {
        const line = lines[j];
        if (!line.trim()) continue;
        const lead = line.length - line.trimStart().length;
        if (lead < indent - 2) break;
        if (lead !== indent - 2) continue;
        const key = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
        if (key) names.add(key[1]);
        break;
      }
    }
  }
  return [...names];
};

const rewritePatch = (text, wrapperId, channels = []) => {
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
    if (block.id !== wrapperId) return true;
    // Any row of ours carrying a top-level `disabled:` is the pin row, and the pin
    // row must never carry config: it would override the real one above it.
    if (!block.body.some((line) => /^ {2}disabled:/.test(line))) return true;
    if (keptWrapperRow) {
      notes.push("dropped a duplicate " + wrapperId + " row");
      return false;
    }
    keptWrapperRow = true;
    if (!block.body.join(" ").includes("false")) notes.push("re-enabled the " + wrapperId + " row");
    else if (block.body.length > 1) notes.push("stripped stray config from the " + wrapperId + " pin row");
    block.body = ["  disabled: false"];
    return true;
  });

  // (c) The previous version kept the two upstream packages in the bundle list
  //     and switched their rows off through a `!!js` expression that read the
  //     wrapper's sibling entry. That expression is order-sensitive: switching the
  //     wrapper back on in the plugin page appends it after them, they get built
  //     first, do not see it yet, and stay on — three copies at once. The rows are
  //     removed here; the switching now lives in the wrapper's own bundle layer
  //     (step 4), which is applied only while the wrapper is listed, and the host
  //     half adds a runtime check for the ordering case (package/lib/index.js).
  blocks = blocks.filter((block) => {
    if (!pinned.includes(block.id)) return true;
    if (block.body.some((line) => !/^\s+disabled:/.test(line))) return true;
    if (!block.body.join(" ").includes("!!js")) return true;
    notes.push("dropped the leftover follow row for " + block.id);
    return false;
  });

  // (d) Every channel that points at one of the relays gets request-body
  //     compression switched on, brotli-first. Written as plain config next to the
  //     other channel switches, so the panel shows the same thing the plugin
  //     actually does, and so the user can still turn a single channel off.
  if (channels.length > 0) {
    blocks = blocks.map((block) => {
      if (block.id !== wrapperId) return block;
      if (block.body.some((line) => /^ {2}disabled:/.test(line))) return block;
      const body = [...block.body];
      let touched = false;
      let configAt = body.findIndex((line) => /^\s{2}config:\s*$/.test(line));
      if (configAt === -1) {
        body.push("  config:");
        configAt = body.length - 1;
        touched = true;
      }
      let providersAt = body.findIndex((line, index) => index > configAt && /^\s{4}providers:\s*$/.test(line));
      if (providersAt === -1) {
        body.splice(configAt + 1, 0, "    providers:");
        providersAt = configAt + 1;
        touched = true;
      }
      /** End of the block opened on `start`: the first non-blank line indented no deeper than `indent`. */
      const sectionEnd = (start, indent) => {
        for (let i = start + 1; i < body.length; i += 1) {
          if (body[i].trim() && body[i].length - body[i].trimStart().length <= indent) return i;
        }
        return body.length;
      };
      for (const name of channels) {
        const escape = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        let nameAt = -1;
        let end = sectionEnd(providersAt, 4);
        for (let i = providersAt + 1; i < end; i += 1) {
          if (new RegExp("^ {6}" + escape + ":\\s*$").test(body[i])) {
            nameAt = i;
            break;
          }
        }
        if (nameAt === -1) {
          body.splice(end, 0, "      " + name + ":", "        enabled: true", "        encoding: auto");
          touched = true;
          notes.push("compression on for " + name);
          continue;
        }
        let local = false;
        let fieldEnd = sectionEnd(nameAt, 6);
        for (const [key, value] of [["enabled", "true"], ["encoding", "auto"]]) {
          let at = -1;
          for (let i = nameAt + 1; i < fieldEnd; i += 1) {
            if (new RegExp("^ {8}" + key + ":").test(body[i])) {
              at = i;
              break;
            }
          }
          if (at === -1) {
            body.splice(fieldEnd, 0, "        " + key + ": " + value);
            fieldEnd += 1;
            local = true;
          } else if (body[at].trim() !== key + ": " + value) {
            body[at] = "        " + key + ": " + value;
            local = true;
          }
        }
        if (local) {
          touched = true;
          notes.push("compression on for " + name);
        }
      }
      return touched ? { ...block, body } : block;
    });
  }

  return { text: joinPatch(blocks), notes };
};

// Providers are declared in either the profile's own config or its patch layer;
// scanning both means a relay channel is found wherever the user put it.
const cordisMain = join(profile, "cordis.yml");
const channels = channelsToCompress([
  patchBefore ?? "",
  existsSync(cordisMain) ? readFileSync(cordisMain, "utf8") : "",
]);
if (channels.length > 0) say("relay channels: " + channels.join(", ") + " -> compression on, brotli-first");

if (patchBefore !== null) {
  const rewritten = rewritePatch(patchBefore, WRAPPER, channels);
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
say("done. Restart DSH. Settings > Plugins lists installed packages; only " + WRAPPER + " runs.");
say("The two upstream cards now show as off. To go back to a standalone plugin, switch " + WRAPPER);
say("off and turn that card on - but never run both at once: the same services and HTTP routes.");
say("Both settings pages (billion-context and 模型请求加速) stay where they are.");
