#!/usr/bin/env node
// Build ONE package, plugins/bili-context-patch, that carries everything:
// billion-context, its compaction gate and the request accelerator.
//
// Why one package instead of two rows: the Plugins settings list renders one card
// per installed package, and the host serves one client bundle per entry. Two
// dependency rows can never be one card. So this install writes a package that
//   - mounts billion-context, its compaction gate and the accelerator as child
//     plugins (host half), and
//   - concatenates both client bundles into one factory (browser half).
//
// The sources are COPIED into that package's vendor/ directory, and the profile
// depends on nothing else. That is what keeps the install to one card: a package
// the profile declares is a card, so billion-context and the accelerator cannot
// stay declared. Neither is modified in place — the copy is rebuilt from them on
// every run, and they may be removed from disk afterwards.
//
// Runs the same way on macOS, Linux and Windows: no shell, no lsof, no cp.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { relayChannelsFromProfile, rewriteUpstreamPatch } from "../lib/profile.js";
import { patchAcceleratorSources } from "./patch-accelerator.mjs";
import { patchBiliClientBundle } from "./patch-bili-client.mjs";
import { patchBiliAgentBundle } from "./patch-bili-agent.mjs";
import { assertAgentUpstreamUx } from "./check-upstream-ux.mjs";

const WRAPPER = "bili-context-patch";
const UPSTREAM = "billion-context";
const ACCELERATOR = "dsh-plugin-model-request-accelerator";
const ACCELERATOR_REPO = "https://github.com/No-ni/dsh-plugin-model-request-accelerator.git";
const MARKER = "# --- model-request-accelerator: merged by billion-context-patched ---";
// Channels that should ship with request-body compression already on. Matching is
// by host, not by provider name: rename a provider or add another one later and
// the same rule still applies, as long as it points at one of these relays.
// The wrapper's version lives in its own package.json (three parts, e.g. 0.1.0)
// and is prepared by scripts/release.mjs: the version this repo shows
// and the one the update check compares against are the same field.

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const takesValue = new Set(["--accelerator", "--accelerator-repo", "--bili", "--out", "--profile"]);
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
// Two jobs for one script. By default it builds the package inside a profile -
// the install an existing user upgrades in place. --build writes the same files
// into this checkout instead: that is the package a plain `dsh plugin add`
// installs from the repository, and nothing outside the checkout is touched.
const buildMode = argv.includes("--build");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const say = (message) => console.log(message);

// What gets written: the profile's manifest, its patch file, and the package
// directory. The profile is named explicitly, so an install into a second one
// updates that profile and not whichever happens to be the default. In --build
// mode the package directory is this checkout and the profile is only a place to
// find upstream sources, so it does not have to exist at all.
const profile = resolve(
  option("--profile") ?? process.env.DSH_PROFILE_DIR ?? join(homedir(), ".dsh", "profiles", "desktop"),
);
const manifestPath = join(profile, "package.json");
const patchPath = join(profile, "cordis.patch.yml");
const wrapperDir = buildMode ? resolve(option("--out") ?? join(here, "..")) : join(profile, "plugins", WRAPPER);
const vendorDir = join(wrapperDir, "vendor");
const vendorBili = join(vendorDir, UPSTREAM);
const vendorAccelerator = join(vendorDir, ACCELERATOR);
const outputBuild = buildMode && existsSync(join(wrapperDir, "package.json"))
  ? JSON.parse(readFileSync(join(wrapperDir, "package.json"), "utf8")).patchBuild
  : undefined;

if (!buildMode && !existsSync(manifestPath)) fail("no profile manifest at " + manifestPath);

// Validate authored configuration before copying any installed runtime. Read it
// again at the profile-write step, so the preflight is not a stale write plan.
const readProfilePlan = () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest?.dsh?.profile?.bundles)) fail(manifestPath + " has no dsh.profile.bundles list");
  const patchBefore = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
  const cordisMain = join(profile, "cordis.yml");
  const channels = relayChannelsFromProfile([
    existsSync(cordisMain) ? readFileSync(cordisMain, "utf8") : "",
    patchBefore,
  ]);
  return { manifest, patchBefore, rewritten: rewriteUpstreamPatch(patchBefore, undefined, { channels }) };
};
if (!buildMode) readProfilePlan();

// ── 0. where the sources come from ──────────────────────────────────────────
// Best first: an explicit path, this package's own vendored copy, then whatever
// the profile carries. The vendored copy wins because it is self-consistent - its
// manifest, layer, agent files and patched build all come from one upstream
// version - and because a re-run from a checkout must not quietly keep the older
// upstream an earlier install left in the profile. When this package came from
// the plugin list the vendored path IS the installed path, so nothing is copied.
const looksLikeBili = (path) =>
  existsSync(join(path, "package.json")) && existsSync(join(path, "dist", "index.js"));
const ownVendor = join(here, "..", "vendor", UPSTREAM);
const explicitBili = positional[0] ?? option("--bili") ?? process.env.BILI_PKG;
const target = resolve(
  explicitBili ??
    [ownVendor, join(profile, "node_modules", UPSTREAM), vendorBili].find((path) => looksLikeBili(path)) ??
    join(profile, "node_modules", UPSTREAM),
);
if (!looksLikeBili(target)) fail("no billion-context sources at " + target);
const sourceLayerPath = join(target, "dsh.bundle.patch.yml");
if (!existsSync(sourceLayerPath)) fail("no bundle layer at " + sourceLayerPath);

const backupOf = (file) => {
  const to = file + ".bak-bili-context-patch-" + new Date().toISOString().replace(/[-:.TZ]/g, "");
  copyFileSync(file, to);
  return to;
};

// This script rewrites the same two files on every run, so the safety copies pile
// up in a directory the user reads. Keep the newest few and clear the rest; only
// names this script mints (<file>.bak-bili-context-patch-<UTC stamp>) are touched, so backups
// made by hand or by other tools stay.
const BACKUP_STAMP = /^\d{17}$/;
const pruneBackups = (file, keep = 3) => {
  try {
    const dir = dirname(file);
    const prefix = file.slice(dir.length + 1) + ".bak-bili-context-patch-";
    const old = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && BACKUP_STAMP.test(name.slice(prefix.length)))
      .sort();
    const doomed = old.slice(0, Math.max(0, old.length - keep));
    for (const name of doomed) rmSync(join(dir, name), { force: true });
    return doomed.length;
  } catch {
    return 0;
  }
};

const writeWithBackup = (file, content) => {
  const backup = existsSync(file) ? backupOf(file) : null;
  writeFileSync(file, content);
  return backup;
};

// ── 1. the patched build: checked here, written after the merge ─────────────
// There is ONE copy of the patched build in the repo: the vendored one, because
// that is the file this install actually runs. A dist/ beside scripts/ is
// optional and only exists when a maintainer drops in a freshly patched build;
// when present it wins over everything else.
const installedBuild = join(vendorBili, "dist", "index.js");
const repoBuild = join(here, "..", "dist", "index.js");
const sourceBuild = join(target, "dist", "index.js");
// A stock billion-context has an unpatched build to offer, and copying that over
// the vendored one would silently ship a proxy without our changes. A build is
// ours only when it carries the plugin-lane guard that
// scripts/patch-bili-build.mjs writes; the build script also writes the
// __biliEncZlib encoder block, so either marker identifies a patched build.
const BUILD_MARKERS = ["__biliPluginLaneSnapshot", "__biliEncZlib"];
const isPatchedBuild = (file) => {
  try {
    const text = readFileSync(file, "latin1");
    return BUILD_MARKERS.some((marker) => text.includes(marker));
  } catch {
    return false;
  }
};
if (resolve(target) !== resolve(vendorBili) && !existsSync(repoBuild) && !isPatchedBuild(sourceBuild)) {
  fail("source build is not patched; run scripts/patch-bili-build.mjs on " + sourceBuild + " before installing it");
}
const pendingBuild = existsSync(repoBuild)
  ? repoBuild
  : resolve(target) !== resolve(vendorBili) && isPatchedBuild(sourceBuild)
    ? sourceBuild
    : null;
const candidateBuild = pendingBuild ?? (existsSync(installedBuild) ? installedBuild : null);
let stagedBuild = null;
let patchedBiliAgent;
if (!dryRun && candidateBuild) {
  const stage = mkdtempSync(join(tmpdir(), "bili-install-"));
  process.on("exit", () => {
    if (!resolve(stage).startsWith(resolve(tmpdir()) + sep)) throw new Error("refusing cleanup outside the installer temp directory");
    rmSync(stage, { recursive: true, force: true });
  });
  stagedBuild = join(stage, "index.js");
  copyFileSync(candidateBuild, stagedBuild);
  execFileSync(process.execPath, [join(here, "patch-bili-build.mjs"), stagedBuild], {
    stdio: ["ignore", "ignore", "inherit"], timeout: 30000,
    env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
  });
  patchedBiliAgent = patchBiliAgentBundle(readFileSync(join(target, "dist/agent/dsh-native.js"), "utf8"));
  const stagedAgent = join(stage, "dsh-native.mjs");
  writeFileSync(stagedAgent, patchedBiliAgent.text);
  execFileSync(process.execPath, ["--check", stagedAgent], { stdio: ["ignore", "ignore", "inherit"], timeout: 10000 });
  assertAgentUpstreamUx(stagedAgent);
}
const smokeTarget = stagedBuild;
// A build that fails its own smoke test never replaces a working one. The call
// that breaks in production is the user's next model request, and a backup on
// disk is no help to someone who does not know it is there. The test runs on the
// Node that will run the proxy - which is the point of it (scripts/smoke.mjs).
if (!dryRun && !argv.includes("--skip-smoke") && smokeTarget) {
  say("smoke-testing " + smokeTarget + " (" + process.version + ")");
  try {
    execFileSync(process.execPath, [join(here, "check-views.mjs"), smokeTarget], {
      stdio: "inherit", timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
    execFileSync(process.execPath, [join(here, "check-image-retention.mjs"), smokeTarget], {
      stdio: "inherit", timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
    execFileSync(process.execPath, [join(here, "check-image-card.mjs"), smokeTarget], {
      stdio: "inherit", timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
    execFileSync(process.execPath, [join(here, "check-upstream-ux.mjs"), smokeTarget], {
      stdio: "inherit", timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
    execFileSync(process.execPath, [join(here, "check-preflight.mjs"), smokeTarget], {
      stdio: "inherit", timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
    execFileSync(process.execPath, [join(here, "smoke.mjs"), smokeTarget], {
      stdio: "inherit",
      timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
    execFileSync(process.execPath, [join(here, "check-outbound-encoding.mjs"), smokeTarget], {
      stdio: "inherit", timeout: 30000,
      env: { ...process.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
    });
  } catch {
    fail("smoke test failed; " + installedBuild + " was left untouched");
  }
}
// The copy waits for the merge below: writing dist first would leave a new build
// beside an old wrapper if the merge aborts on a reshaped upstream bundle.
const installBuild = () => {
  if (!pendingBuild && !stagedBuild) {
    say("billion-context: keeping the vendored build at " + installedBuild);
    return;
  }
  if (dryRun) {
    say("would install " + pendingBuild + " into " + installedBuild);
    return;
  }
  mkdirSync(dirname(installedBuild), { recursive: true });
  copyFileSync(stagedBuild ?? pendingBuild, installedBuild);
  try {
    chmodSync(installedBuild, 0o755);
  } catch {}
  // The vendored tree is derived and rebuilt on every run, so a backup of it is
  // ballast (5.8 MB each). Earlier versions left some behind; clear them.
  try {
    const distDir = dirname(installedBuild);
    for (const name of readdirSync(distDir)) {
      if (name.startsWith("index.js.bak-")) rmSync(join(distDir, name), { force: true });
    }
  } catch {}
  say("installed into " + vendorBili);
};

// ── 2. the accelerator package ──────────────────────────────────────────────
const acceleratorCandidates = [
  join(here, "..", "vendor", ACCELERATOR),
  join(profile, "plugins", ACCELERATOR),
  join(profile, "plugins", "model-request-accelerator"),
  join(profile, "node_modules", ACCELERATOR),
  vendorAccelerator,
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

// Stage the local ledger compatibility patch before changing any vendor files.
// Explicit upstream inputs remain untouched; the derived copy always carries
// the lifecycle fix even when a maintainer selects the same clean 2.3.0 source.
let patchedAccelerator;
try {
  patchedAccelerator = patchAcceleratorSources(
    readFileSync(join(acceleratorPath, "lib/index.js"), "utf8"),
    readFileSync(join(acceleratorPath, "lib/ledger.js"), "utf8"),
  );
  if (!dryRun) {
    const stage = dirname(stagedBuild);
    for (const [file, source] of [["accelerator-index.mjs", patchedAccelerator.index], ["accelerator-ledger.mjs", patchedAccelerator.ledger]]) {
      const candidate = join(stage, file);
      writeFileSync(candidate, source);
      execFileSync(process.execPath, ["--check", candidate], { stdio: ["ignore", "ignore", "inherit"], timeout: 10000 });
    }
  }
} catch (error) {
  fail("accelerator candidate rejected: " + error.message);
}

// ── 2b. the vendored copy this install carries ──────────────────────────────
// Anything the profile declares becomes a card in the plugin list, so neither
// upstream package stays declared. Their files are copied in here instead, and
// the copy is derived on every run — never edited by hand.
const copyInto = (from, to, files) => {
  for (const file of files) {
    const source = join(from, file);
    if (!existsSync(source)) fail("missing " + source + " — incomplete " + from);
    const destination = join(to, file);
    if (resolve(source) === resolve(destination)) continue;
    if (dryRun) {
      say("would copy " + file + " -> " + to);
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
};

// billion-context: both host entries, the browser bundle, the layer the wrapper
// merges, its manifest (the plugin reads its own version and repository from it)
// and build-info.json (the proxy reports the build it was made from).
const BILI_FILES = [
  "package.json",
  "dsh.bundle.patch.yml",
  "dist/build-info.json",
  "dist/agent/dsh-native.js",
  "dist/agent/dsh-compaction-gate.js",
  "dist/agent/dsh-native-client.js",
];
if (resolve(target) !== resolve(vendorBili)) copyInto(target, vendorBili, BILI_FILES);
else say("billion-context: already vendored at " + vendorBili);
if (!dryRun && patchedBiliAgent) writeFileSync(join(vendorBili, "dist/agent/dsh-native.js"), patchedBiliAgent.text);

// The accelerator is a plain ES module package: its manifest plus lib/.
const acceleratorFiles = (from) => [
  "package.json",
  ...(existsSync(join(from, "lib"))
    ? readdirSync(join(from, "lib"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => "lib/" + name)
    : []),
];
const fileList = (from, prefix = "") => readdirSync(join(from, prefix), { withFileTypes: true }).flatMap((item) =>
  item.isDirectory() ? fileList(from, join(prefix, item.name)) : [join(prefix, item.name)],
);
const yamlFiles = fileList(join(here, "..", "vendor", "yaml"));
copyInto(join(here, "..", "vendor", "yaml"), join(vendorDir, "yaml"), yamlFiles);
const zodFiles = fileList(join(here, "..", "vendor", "zod"));
copyInto(join(here, "..", "vendor", "zod"), join(vendorDir, "zod"), zodFiles);
if (resolve(acceleratorPath) !== resolve(vendorAccelerator)) {
  copyInto(acceleratorPath, vendorAccelerator, acceleratorFiles(acceleratorPath));
} else {
  say("accelerator: already vendored at " + vendorAccelerator);
}
for (const [file, source] of [["lib/index.js", patchedAccelerator.index], ["lib/ledger.js", patchedAccelerator.ledger]]) {
  const destination = join(vendorAccelerator, file);
  if (dryRun) say("would patch accelerator " + file + " ledger lifecycle");
  else if (readFileSync(destination, "utf8") !== source) writeFileSync(destination, source);
}

// The wrapper's layer is rebuilt from bili's own: the vendored copy first (a
// re-run has no other source), the package's own file on a first run — a dry run
// writes nothing, so the copy does not exist yet.
const bundleLayerPath = join(vendorBili, "dsh.bundle.patch.yml");
const layerPath = existsSync(bundleLayerPath) ? bundleLayerPath : sourceLayerPath;

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
const templatePath = join(here, "..", "lib", "client.template.js");
const template = readFileSync(templatePath, "utf8");
// The upstream client bundle ships a status panel for the proxy's own upstream
// host and a poll behind it. It is removed here rather than in the vendor tree:
// the vendored file stays the untouched upstream artifact, and every install
// rebuilds the same bundle from it (scripts/patch-bili-client.mjs).
let biliClientSource;
try {
  const patched = patchBiliClientBundle(readFileSync(join(target, "dist", "agent", "dsh-native-client.js"), "utf8"));
  for (const step of patched.steps) say("bili client: " + step);
  biliClientSource = patched.text;
} catch (error) {
  fail("bili client bundle could not be patched: " + error.message);
}
const biliClientBody = extractFactory(biliClientSource, UPSTREAM);
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
// Both halves plus the inserted image section are one program from here on, so
// parse it as one: a seam that landed inside a string or a brace fails here,
// while the installed copy is still the previous one.
extractFactory(mergedClient, "merged client");

// Both halves extracted and parsed, so the build can go in now: an abort above
// leaves the installed dist exactly as it was.
installBuild();

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


// A package-manager install (Settings > Plugins) never runs this script, so the
// package built here has to carry the switches for the standalone entries with
// it. Installer mode removes those entries from dsh.profile.bundles instead, and
// a row that lands on nothing would only add a startup warning.
const disableRows = "# A package-manager install (Settings > Plugins) never runs this script, so\n" +
    "# the standalone packages stay in dsh.profile.bundles until the first start\n" +
    "# merges the profile. Cold-start entries are disabled before they mount.\n" +
    "# Already-running entries stay alive until the host half waits for their\n" +
    "# pending ledger opens and then disposes them; disabling at composition\n" +
    "# would bypass that wait during a hot install. Missing entries are skipped\n" +
    "# with a warning. The host handles either bundle order. The gate row\n" +
    "# only hits the standalone gate; the wrapper supplies the replacement service.\n" +
    "- id: bili-native\n" +
    "  disabled: !!js '!ctx[Symbol.for(\"cordis.entry\")]?.fiber?.uid'\n" +
    "- id: bili-compaction-gate\n" +
    "  disabled: !!js '!ctx[Symbol.for(\"cordis.entry\")]?.fiber?.uid'\n" +
    "- id: model-request-accelerator\n" +
    "  disabled: !!js '!ctx[Symbol.for(\"cordis.entry\")]?.fiber?.uid'\n";

const layerSource = readFileSync(layerPath, "utf8");
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
  disableRows +
  stripInserts(layerHead).replace(/\s+$/, "") +
  "\n";

const wrapperManifestPath = join(here, "..", "package.json");
const wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, "utf8"));
// Where this checkout lives, so the wrapper's own update action can pull it and
// regenerate the install without the user having to remember the path.
// A package installed by a package manager has no checkout beside it: the field
// stays out, and the update action reports that instead of pulling nothing.
if (!buildMode) {
  wrapperManifest.patchRepo = resolve(here, "..");
  wrapperManifest.meta = { ...(wrapperManifest.meta ?? {}), upstream: UPSTREAM + "@" + biliVersion };
}

// ── 5. write the wrapper package ────────────────────────────────────────────
// One indirection file instead of three bare specifiers: the host half imports
// ./upstream.js, and that file names the vendored trees by relative path. The
// specifiers a package manager would resolve never appear, so nothing has to be
// declared in the profile.
const upstreamModule =
  "// Generated by scripts/install.mjs - do not edit.\n" +
  "// The two upstream packages as copies under ../vendor/. Re-exported by name so\n" +
  "// lib/index.js can mount them without the profile declaring either one.\n" +
  'export * as bili from "../vendor/' + UPSTREAM + '/dist/agent/dsh-native.js";\n' +
  'export * as compactionGate from "../vendor/' + UPSTREAM + '/dist/agent/dsh-compaction-gate.js";\n' +
  'export * as accelerator from "../vendor/' + ACCELERATOR + '/lib/index.js";\n';

const wrapperFiles = [
  // In --build mode the manifest is the checkout's own file, maintained by hand.
  ...(buildMode && resolve(wrapperDir) === resolve(here, "..") ? [] : [[join(wrapperDir, "package.json"), JSON.stringify(wrapperManifest, null, 2) + "\n"]]),
  [join(wrapperDir, "lib", "index.js"), readFileSync(join(here, "..", "lib", "index.js"), "utf8")],
  [join(wrapperDir, "lib", "fork-lineage.js"), readFileSync(join(here, "..", "lib", "fork-lineage.js"), "utf8")],
  [join(wrapperDir, "lib", "merge.js"), readFileSync(join(here, "..", "lib", "merge.js"), "utf8")],
  ...["startup.js", "profile.js", "defaults.js", "version.js"].map((file) => [join(wrapperDir, "lib", file), readFileSync(join(here, "..", "lib", file), "utf8")]),
  [join(wrapperDir, "lib", "upstream.js"), upstreamModule],
  [join(wrapperDir, "lib", "client.js"), mergedClient],
  [join(wrapperDir, "dsh.bundle.patch.yml"), wrapperLayer],
];
for (const [file, content] of wrapperFiles) {
  if (dryRun) {
    say("would write " + file + " (" + Buffer.byteLength(content) + " bytes)");
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
if (!dryRun) {
  if (buildMode) {
    const digest = createHash("sha256").update(JSON.stringify({ ...wrapperManifest, patchBuild: undefined, patchRepo: undefined }) + "\0");
    const files = [
      ...wrapperFiles.map(([file]) => relative(wrapperDir, file)).filter((file) => file !== "package.json"),
      ...BILI_FILES.map((file) => join("vendor", UPSTREAM, file)),
      join("vendor", UPSTREAM, "dist/index.js"),
      ...acceleratorFiles(vendorAccelerator).map((file) => join("vendor", ACCELERATOR, file)),
      ...yamlFiles.map((file) => join("vendor", "yaml", file)),
      ...zodFiles.map((file) => join("vendor", "zod", file)),
    ].sort();
    for (const file of files) digest.update(file.split(sep).join("/") + "\0").update(readFileSync(join(wrapperDir, file))).update("\0");
    const id = digest.digest("hex");
    if (wrapperManifest.patchBuild?.id !== id) wrapperManifest.patchBuild = outputBuild?.id === id ? outputBuild : { id, createdAt: new Date().toISOString() };
    writeFileSync(join(wrapperDir, "package.json"), JSON.stringify(wrapperManifest, null, 2) + "\n");
  }
  say(
    buildMode
      ? "built in " + wrapperDir
      : "wrapper package: " + wrapperDir + " (sources vendored inside)",
  );
}

if (!buildMode) {
  // pnpm's link: dependency resolves through this symlink; creating it here keeps
  // the merge to one command instead of a pnpm install round trip.
  const linkPath = join(profile, "node_modules", WRAPPER);
  const linkExists = () => { try { lstatSync(linkPath); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  if (linkExists() && (!existsSync(linkPath) || !existsSync(wrapperDir) || realpathSync(linkPath) !== realpathSync(wrapperDir))) {
    if (lstatSync(linkPath).isSymbolicLink()) {
      if (!dryRun) unlinkSync(linkPath);
    } else {
      // A manager-installed real directory still wins ordinary Node resolution
      // after dependencies is changed to link:./plugins. Update its runtime too;
      // otherwise a successful reinstall keeps executing the previous host code.
      const previous = JSON.parse(readFileSync(join(linkPath, "package.json"), "utf8"));
      if (previous.name !== WRAPPER) fail("refusing to replace a different package at " + linkPath);
      if (!dryRun) {
        copyInto(wrapperDir, linkPath, [
          ...wrapperFiles.map(([file]) => relative(wrapperDir, file)),
          ...BILI_FILES.map((file) => "vendor/" + UPSTREAM + "/" + file),
          "vendor/" + UPSTREAM + "/dist/index.js",
          ...acceleratorFiles(vendorAccelerator).map((file) => "vendor/" + ACCELERATOR + "/" + file),
          ...yamlFiles.map((file) => join("vendor", "yaml", file)),
          ...zodFiles.map((file) => join("vendor", "zod", file)),
        ]);
      }
      say((dryRun ? "would update" : "updated") + " the existing package-manager runtime at " + linkPath);
    }
  }
  if (!linkExists()) {
    if (dryRun) {
      say("would link " + linkPath + " -> " + wrapperDir);
    } else {
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(wrapperDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      say("linked " + linkPath + " -> " + wrapperDir);
    }
  }

  // ── 6. the profile: one bundle row for both features ────────────────────────
  const { manifest, patchBefore, rewritten } = readProfilePlan();
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

  // Nothing else in the list is touched: other plugins the user installed keep their
  // order and their rows. Only the two upstream names are dropped, because both now
  // live inside this package.
  const changes = [];
  const bundles = [];
  const suppressed = new Set([UPSTREAM, ACCELERATOR]);
  for (const name of bundleOwner.bundles) {
    if (!bundles.includes(name) && name !== WRAPPER && !suppressed.has(name)) bundles.push(name);
  }
  // Both upstream names leave the list, and in a vendored install they leave the
  // profile too (below): a list row without a declared package is not a card, and
  // these two are mounted by the wrapper's host half instead of by the loader.
  bundles.push(WRAPPER);
  if (JSON.stringify(bundles) !== JSON.stringify(bundleOwner.bundles)) {
    bundleOwner.bundles = bundles;
    changes.push("bundles -> " + bundles.join(", "));
  }

  // One declared package, and therefore one card: the plugin list is the profile's
  // dependency map, so a leftover billion-context row is a leftover card, and an
  // accelerator row beside it is a second one. Both are removed — their files are
  // in vendor/ now. The rows are only removed, never rewritten into something else:
  // a user who wants the standalone plugin back installs it again, and the two
  // copies cannot both run (same services, same routes).
  const nextDependencies = { ...dependencies, [WRAPPER]: wrapperSpec };
  delete nextDependencies[UPSTREAM];
  delete nextDependencies[ACCELERATOR];
  manifest.dependencies = Object.fromEntries(
    Object.entries(nextDependencies).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencies)) {
    changes.push("dependencies: " + WRAPPER + " only (upstream rows removed)");
  }

  if (changes.length > 0 && !dryRun) {
    const manifestBackup = backupOf(manifestPath);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    pruneBackups(manifestPath);
    say("profile: " + changes.join("; ") + " (backup " + manifestBackup + ")");
  } else if (changes.length > 0) {
    say("would update profile: " + changes.join("; "));
  } else {
    say("profile: already wired");
  }

  // Both installation paths share YAML migration and missing-key rules. The
  // runtime repeats this safely at first activation, including late providers.
  if (rewritten.text !== patchBefore) {
    if (dryRun) {
      say("would migrate " + rewritten.migrated + " legacy settings row(s) and fill " + rewritten.defaulted + " missing compression setting(s)");
    } else {
      const patchBackup = existsSync(patchPath) ? backupOf(patchPath) : null;
      writeFileSync(patchPath, rewritten.text);
      pruneBackups(patchPath);
      say("profile patch: migrated " + rewritten.migrated + " settings row(s), filled " + rewritten.defaulted + " missing field(s) (backup " + patchBackup + ")");
    }
  } else {
    say("profile patch: already wired");
  }

  // Earlier versions of this script appended an insert row to billion-context's
  // own layer. That row is what step 6 removes; leaving the text behind would
  // resurrect the row on the next bundle reset.
  if (!dryRun && layerSource.includes(MARKER)) {
    writeWithBackup(layerPath, layerHead.replace(/\s+$/, "") + "\n");
    say("removed the old insert row from " + layerPath);
  }
}

say("");
say("");
if (buildMode) {
  say("built the installable package in " + wrapperDir + " (vendor/, lib/client.js, dsh.bundle.patch.yml).");
  say("Nothing outside this checkout was touched. Commit the result: a plain");
  say("'dsh plugin add' of this repository then installs a working plugin, no script to run.");
} else {
  say("done. Restart DSH. Settings > Plugins lists installed packages: " + WRAPPER + " is the only");
  say("card for this feature set - billion-context and the accelerator no longer appear, because");
  say("the profile no longer depends on them. Their files are copied into " + join(wrapperDir, "vendor") + ".");
  say("To go back to the standalone plugins, install them again (and remove this package first):");
  say("both forms register the same services and HTTP routes, so they must not run together.");
  say("Both settings pages (billion-context and 模型请求加速) stay where they are.");
}
