#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "../vendor/yaml/dist/index.js";
import { installForkLineage } from "../lib/fork-lineage.js";
import { guardEntry, profileRootOf } from "../lib/merge.js";
import { mountMergedPlugins } from "../lib/startup.js";
import { compressionDefaultOps, compressionPolicyDefaultOps } from "../lib/defaults.js";
import { relayChannelsFromProfile, rewriteUpstreamPatch } from "../lib/profile.js";
import { hasPublishedUpdate } from "../lib/version.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
// Vendor manifests are not dependency-install roots for npm/Git installs.
// Carry the ledger schema runtime for both manager and CLI installations.
assert.equal(JSON.parse(readFileSync(join(repo, "vendor/zod/package.json"), "utf8")).version, "4.4.3");
assert(readFileSync(join(repo, "vendor/dsh-plugin-model-request-accelerator/lib/ledger.js"), "utf8").includes('from "../../zod/index.js"'));
const parse = (text) => yaml.parse(text, { merge: true, customTags: [{
  tag: "tag:yaml.org,2002:js", resolve: (value) => ({ __jsExpr: value }),
}] });
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const clean = (path) => {
  assert(resolve(path).startsWith(resolve(tmpdir()) + sep));
  rmSync(path, { recursive: true, force: true });
};
function scope(services = {}) {
  const releases = [];
  const hooks = new Map();
  const ctx = {
    fiber: { uid: 1, state: 2 },
    get: (key) => services[key],
    effect(callback) { const release = callback(); releases.push(release); return release; },
    on(event, callback) { hooks.set(event, callback); },
    inject(_dependencies, callback) { callback(ctx); },
  };
  return { ctx, hooks, async dispose() {
    ctx.fiber.uid = null;
    ctx.fiber.state = 5;
    for (const release of releases.reverse()) await release?.();
  } };
}

// Forks retain authored lineage and concurrent calls do not share parents.
{
  const agents = { create(options) { return options; } };
  const controller = { async fork(request) {
    await Promise.resolve();
    return agents.create({ meta: { isSeeded: request.seeded !== false, ...request.meta } });
  } };
  const originals = [agents.create, controller.fork];
  const test = scope({ agents, sessionController: controller });
  installForkLineage(test.ctx);
  const children = await Promise.all(["one", "two"].map((sessionId) => controller.fork({ sessionId })));
  assert.deepEqual(children.map((child) => child.meta.parentSession), ["one", "two"]);
  assert.equal((await controller.fork({ sessionId: "three", meta: { parentSession: "authored" } })).meta.parentSession, "authored");
  assert.equal((await controller.fork({ sessionId: "four", seeded: false })).meta.parentSession, undefined);
  assert.equal(agents.create({ meta: { isSeeded: true } }).meta.parentSession, undefined);
  await test.dispose();
  assert.equal(agents.create, originals[0]);
  assert.equal(controller.fork, originals[1]);
  console.log("  OK forks: concurrent parents, authored values, ordinary creation, restoration");
}

// Each guard owns one rule; disposal releases it without undoing another owner.
{
  const entry = { options: { id: "model-request-accelerator" }, update(options) { Object.assign(this.options, options); } };
  const original = entry.update;
  const first = guardEntry(entry, [entry.options.id]);
  const second = guardEntry(entry, [entry.options.id]);
  first();
  entry.update({ disabled: false });
  assert.equal(entry.options.disabled, true);
  second();
  assert.equal(entry.update, original);
  entry.update({ disabled: false });
  assert.equal(entry.options.disabled, false);
  const test = scope({ loader: { entries: () => [] } });
  let mounts = 0;
  test.ctx.plugin = () => { mounts++; };
  const startup = mountMergedPlugins(test.ctx, [[{}]], ["bili-native"]);
  await test.dispose();
  assert.equal(await startup.ready, false);
  assert.equal(mounts, 0);
  console.log("  OK guard lifetimes and cancellation before deferred startup");
}

// Match exact hosts, including ports/case/trailing dot; explicit choices win.
{
  const endpoints = [
    ["renamed relay", "https://WWW.DIDUDIDU.ASIA.:8443/v1"],
    ["ip", "http://154.219.111.56:8080/v1"],
    ["unrelated", "https://didudidu.asia/v1"],
    ["lookalike", "https://www.didudidu.asia.example.org/v1"],
    ["bad", "not a URL"],
  ];
  const directory = endpoints.map(([provider]) => ({ provider, settingsNs: "llm-relay", settingsPath: ["providers", provider] }));
  const rows = [{ ns: "llm-relay", value: { providers: Object.fromEntries(endpoints.map(([id, baseURL]) => [id, { baseURL }])) } }];
  const raw = { providers: { "renamed relay": { minBytes: 321 }, ip: { enabled: false, encoding: "gzip" } } };
  const before = structuredClone(raw);
  assert.deepEqual(compressionDefaultOps(raw, directory, rows), [
    { op: "set", path: ["providers", "renamed relay", "enabled"], value: true },
    { op: "set", path: ["providers", "renamed relay", "encoding"], value: "auto" },
  ]);
  assert.deepEqual(raw, before);
  assert.deepEqual(compressionPolicyDefaultOps({ encoding: "gzip" }, ["relay"]).map((op) => op.value), [true, "gzip"]);
  assert.equal(compressionPolicyDefaultOps({ providers: { relay: null } }, ["relay"]).length, 0);
  assert.equal(compressionPolicyDefaultOps({ providers: { __jsExpr: "policies" } }, ["relay"]).length, 0);
  console.log("  OK host defaults: missing fields, renamed channels, global gzip, explicit values, expressions");
}

// A migration is one semantic merge, including aliases/<<; unrelated data and tags survive.
{
  const text = [
    "# keep the header",
    "- id: model-request-accelerator",
    "  disabled: true",
    "  config: {providers: {relay: {enabled: false, encoding: gzip, minBytes: 7777}}, timing: false}",
    "- id: bili-context-patch",
    "  disabled: false",
    "  config: {providers: {relay: {prewarm: true}}, http2: false}",
    "- id: unrelated",
    "  config: {keep: true}",
    "- id: bili-native",
    '  disabled: !!js ctx.loader.store["bili-context-patch"]',
    "- id: bili-compaction-gate",
    "  disabled: !!js ctx.featureFlag",
    "",
  ].join("\n");
  const changed = rewriteUpstreamPatch(text);
  const rows = parse(changed.text);
  assert.equal(rows.filter((row) => row.id === "model-request-accelerator").length, 0);
  assert.equal(rows.filter((row) => row.id === "bili-native").length, 0);
  assert.equal(rows.find((row) => row.id === "bili-context-patch").disabled, false);
  assert.deepEqual(rows.find((row) => row.id === "bili-context-patch").config, {
    providers: { relay: { prewarm: true, enabled: false, encoding: "gzip", minBytes: 7777 } }, http2: false, timing: false,
  });
  assert.equal(rows.find((row) => row.id === "bili-compaction-gate").disabled.__jsExpr, "ctx.featureFlag");
  assert(changed.text.includes("keep the header"));
  assert.equal(rewriteUpstreamPatch(changed.text).text, changed.text);

  const splitState = [
    "- id: model-request-accelerator",
    "  disabled: false",
    "  config: {timing: false}",
    "- id: model-request-accelerator",
    "  disabled: true",
    "  inject: [connection]",
    "- id: model-request-accelerator",
    "  disabled: !!js ctx.featureFlag",
    "- id: bili-context-patch",
    "  config: {http2: false}",
    "",
  ].join("\n");
  const split = rewriteUpstreamPatch(splitState);
  const splitRows = parse(split.text);
  const splitWrapper = splitRows.find((row) => row.id === "bili-context-patch");
  assert.equal(split.migrated, 2);
  assert.equal(splitWrapper.disabled.__jsExpr, "ctx.featureFlag");
  assert.deepEqual(splitWrapper.inject, ["connection"]);
  assert.deepEqual(splitWrapper.config, { http2: false, timing: false });
  assert.equal(splitRows.find((row) => row.id === "model-request-accelerator").disabled.__jsExpr, "ctx.featureFlag");
  assert.equal(rewriteUpstreamPatch(split.text).text, split.text);
  const followAlias = rewriteUpstreamPatch([
    "- &old {id: bili-native, disabled: !!js 'ctx.loader.store[\"bili-context-patch\"]'}",
    "- id: unrelated",
    "  config: *old",
    "",
  ].join("\n"));
  assert.equal(parse(followAlias.text)[0].config.id, "bili-native");

  const aliased = [
    "- id: shared",
    "  config: &shared {providers: {relay: {enabled: false, minBytes: 1200}}}",
    "- id: model-request-accelerator",
    "  config: {providers: {relay: {prewarm: true, minBytes: 1000}}}",
    "- id: bili-context-patch",
    "  config: *shared",
    "- id: unrelated",
    "  config: *shared",
    "",
  ].join("\n");
  const aliasRows = parse(rewriteUpstreamPatch(aliased).text);
  assert.deepEqual(aliasRows.find((row) => row.id === "unrelated").config.providers.relay, { enabled: false, minBytes: 1200 });
  assert.deepEqual(aliasRows.find((row) => row.id === "bili-context-patch").config.providers.relay, { enabled: false, minBytes: 1200, prewarm: true });
  const merged = [
    "- id: shared",
    "  config: &policy {enabled: false, minBytes: 777}",
    "- id: bili-context-patch",
    "  config: {providers: {<<: {relay: *policy}}}",
    "",
  ].join("\n");
  const result = rewriteUpstreamPatch(merged, undefined, { channels: ["relay"] });
  const mergedRows = parse(result.text);
  assert.deepEqual(mergedRows[1].config.providers.relay, { enabled: false, minBytes: 777, encoding: "auto" });
  assert.deepEqual(mergedRows[0].config, { enabled: false, minBytes: 777 });
  assert.equal(rewriteUpstreamPatch(result.text, undefined, { channels: ["relay"] }).text, result.text);
  assert.throws(() => rewriteUpstreamPatch("- id: model-request-accelerator\n  config: &cycle {self: *cycle}\n"), /cyclic/);
  const empty = rewriteUpstreamPatch("# a new profile\n", undefined, { channels: ["new channel"] });
  assert.deepEqual(parse(empty.text)[0].config.providers["new channel"], { enabled: true, encoding: "auto" });
  assert.deepEqual(relayChannelsFromProfile([
    "- id: llm-relay\n  config: {providers: {renamed: {baseURL: 'https://www.didudidu.asia/v1'}}}\n",
    "- id: llm-relay\n  config: {providers: {renamed: {baseURL: 'https://example.org/v1'}}}\n",
  ]), []);
  console.log("  OK YAML: legacy choices, aliases and merges, comments/tags, empty files, overlays, idempotence");
}

{
  const hash = (char, createdAt) => ({ id: char.repeat(64), createdAt });
  const installed = { version: "0.6.5", patchBuild: hash("a", "2026-11-11T10:00:00Z") };
  const later = { version: "0.6.5", patchBuild: hash("b", "2026-11-11T11:00:00Z") };
  assert.equal(hasPublishedUpdate(installed, later), true);
  assert.equal(hasPublishedUpdate(later, installed), false);
  assert.equal(hasPublishedUpdate(installed, installed), false);
  assert.equal(hasPublishedUpdate({ version: "0.6.5", patchBuild: null }, later), true);
  assert.equal(hasPublishedUpdate(installed, { version: "0.6.6" }), true);
  assert.equal(hasPublishedUpdate(installed, { version: "0.6.4" }), false);
  assert.equal(hasPublishedUpdate(installed, null), false);
  assert.equal(hasPublishedUpdate(installed, { version: "0.6.5", patchBuild: { id: "bad" } }), false);
  console.log("  OK update checks: same-version fixes, older remote, malformed metadata");
}

const fixture = temp("bili-check-install-");
try {
  const main = [
    "- id: llm-relay",
    "  config:",
    "    providers:",
    "      'renamed relay': {baseURL: 'https://WWW.DIDUDIDU.ASIA.:8443/v1'}",
    "      ip: {baseURL: 'http://154.219.111.56:8080/v1'}",
    "      unrelated: {baseURL: 'https://www.didudidu.asia.example.org/v1'}",
    "",
  ].join("\n");
  const makeProfile = (name, patch) => {
    const root = join(fixture, name);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      dependencies: { "user-plugin": "1.0.0", "billion-context": "0.1.213", "dsh-plugin-model-request-accelerator": "2.0.0", "bili-context-patch": "0.6.5" },
      dsh: { profile: { bundles: ["user-plugin", "billion-context", "dsh-plugin-model-request-accelerator", "bili-context-patch"] } },
    }));
    writeFileSync(join(root, "cordis.yml"), main);
    if (patch !== undefined) writeFileSync(join(root, "cordis.patch.yml"), patch);
    return root;
  };
  const install = (root, extra = []) => execFileSync(process.execPath, [join(repo, "scripts/install.mjs"), "--profile", root, ...extra],
    { timeout: 45000, stdio: "pipe", env: process.env });
  const root = makeProfile("existing", [
    "- id: model-request-accelerator",
    "  config: {providers: {'renamed relay': {minBytes: 777}}, timing: false}",
    "- id: bili-context-patch",
    "  disabled: true",
    "  config: {providers: {'renamed relay': {enabled: false, encoding: gzip}, ip: {prewarm: true}}, preserved: 'user choice'}",
    "",
  ].join("\n"));
  const stale = join(root, "node_modules", "bili-context-patch");
  mkdirSync(join(stale, "lib"), { recursive: true });
  writeFileSync(join(stale, "package.json"), '{"name":"bili-context-patch","version":"0.6.5","main":"lib/index.js"}');
  writeFileSync(join(stale, "lib/index.js"), "throw new Error('stale runtime');");
  mkdirSync(join(root, "plugins/dsh-plugin-model-request-accelerator"), { recursive: true });
  writeFileSync(join(root, "plugins/dsh-plugin-model-request-accelerator/package.json"), '{"name":"dsh-plugin-model-request-accelerator","version":"2.0.0"}');
  const patchBefore = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  install(root, ["--dry-run"]);
  assert.equal(readFileSync(join(root, "cordis.patch.yml"), "utf8"), patchBefore);
  assert(!existsSync(join(root, "plugins/bili-context-patch")));
  install(root);
  const rows = parse(readFileSync(join(root, "cordis.patch.yml"), "utf8"));
  const wrapper = rows.find((row) => row.id === "bili-context-patch");
  assert.equal(wrapper.disabled, true);
  assert.deepEqual(wrapper.config.providers["renamed relay"], { enabled: false, encoding: "gzip", minBytes: 777 });
  assert.deepEqual(wrapper.config.providers.ip, { prewarm: true, enabled: true, encoding: "auto" });
  assert.equal(wrapper.config.providers.unrelated, undefined);
  assert.equal(wrapper.config.preserved, "user choice");
  assert.equal(wrapper.config.timing, false);
  assert.equal(rows.filter((row) => row.id === "model-request-accelerator").length, 0);
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  assert.deepEqual(manifest.dsh.profile.bundles, ["user-plugin", "bili-context-patch"]);
  assert.equal(manifest.dependencies["user-plugin"], "1.0.0");
  assert.equal(manifest.dependencies["billion-context"], undefined);
  assert.equal(manifest.dependencies["dsh-plugin-model-request-accelerator"], undefined);
  assert.equal(readFileSync(join(stale, "lib/index.js"), "utf8"), readFileSync(join(repo, "lib/index.js"), "utf8"));
  assert(existsSync(join(stale, "lib/defaults.js")));
  assert(existsSync(join(stale, "vendor/yaml/LICENSE")));
  assert(existsSync(join(stale, "vendor/zod/index.js")));
  assert.equal(JSON.parse(readFileSync(join(stale, "vendor/dsh-plugin-model-request-accelerator/package.json"))).version, "2.3.0");
  assert.equal(createRequire(join(root, "package.json")).resolve("bili-context-patch"), join(stale, "lib/index.js"));
  const bytes = readFileSync(join(root, "cordis.patch.yml"));
  const dist = join(root, "plugins/bili-context-patch/vendor/billion-context/dist/index.js");
  const installed = readFileSync(dist);
  install(root);
  assert(bytes.equals(readFileSync(join(root, "cordis.patch.yml"))));
  assert(installed.equals(readFileSync(dist)));
  assert.equal(await profileRootOf(stale), root);
  console.log("  OK installer: vendor precedence, existing manager runtime, choices, legacy merge, dry-run/reinstall");

  const fresh = makeProfile("fresh");
  symlinkSync(join(fresh, "missing-previous-install"), join(fresh, "node_modules/bili-context-patch"), process.platform === "win32" ? "junction" : "dir");
  install(fresh);
  const defaults = parse(readFileSync(join(fresh, "cordis.patch.yml"), "utf8")).find((row) => row.id === "bili-context-patch").config.providers;
  assert.deepEqual(defaults["renamed relay"], { enabled: true, encoding: "auto" });
  assert.deepEqual(defaults.ip, { enabled: true, encoding: "auto" });
  assert.equal(defaults.unrelated, undefined);
  assert(existsSync(join(fresh, "node_modules/bili-context-patch/lib/index.js")));
  console.log("  OK installer creates missing patch/defaults for both relay hosts and repairs a dangling link");

  const output = join(fixture, "output");
  execFileSync(process.execPath, [join(repo, "scripts/install.mjs"), "--build", "--out", output],
    { timeout: 45000, stdio: "pipe" });
  const built = JSON.parse(readFileSync(join(output, "package.json")));
  assert.equal(built.version, "0.6.5");
  assert.match(built.patchBuild.id, /^[a-f0-9]{64}$/);
  for (const file of ["lib/index.js", "lib/upstream.js", "lib/defaults.js", "lib/client.js", "vendor/yaml/LICENSE", "vendor/zod/index.js", "dsh.bundle.patch.yml"]) assert(existsSync(join(output, file)));
  execFileSync(process.execPath, [join(repo, "scripts/install.mjs"), "--build", "--out", output],
    { timeout: 45000, stdio: "pipe" });
  assert.deepEqual(JSON.parse(readFileSync(join(output, "package.json"))).patchBuild, built.patchBuild);
  console.log("  OK --build --out: complete package, stable same-version build metadata");

  const invalid = makeProfile("invalid-patch");
  const invalidManifest = readFileSync(join(invalid, "package.json"));
  const invalidPatch = "- id: model-request-accelerator\n  config: [unterminated\n";
  writeFileSync(join(invalid, "cordis.patch.yml"), invalidPatch);
  assert.throws(() => install(invalid));
  assert(readFileSync(join(invalid, "package.json")).equals(invalidManifest));
  assert.equal(readFileSync(join(invalid, "cordis.patch.yml"), "utf8"), invalidPatch);
  assert.equal(existsSync(join(invalid, "plugins/bili-context-patch")), false);
  console.log("  OK malformed profile fails before changing its manifest, patch or installed runtime");

  const broken = join(fixture, "broken-source");
  mkdirSync(join(broken, "dist"), { recursive: true });
  writeFileSync(join(broken, "package.json"), '{"name":"billion-context","version":"0.0.0"}');
  writeFileSync(join(broken, "dsh.bundle.patch.yml"), "[]\n");
  writeFileSync(join(broken, "dist/index.js"), "var __biliEncZlib=0;");
  assert.throws(() => install(root, ["--bili", broken]));
  assert(installed.equals(readFileSync(dist)));
  console.log("  OK incompatible candidate fails before replacing installed dist");

  const badAccelerator = join(fixture, "bad-accelerator");
  mkdirSync(join(badAccelerator, "lib"), { recursive: true });
  writeFileSync(join(badAccelerator, "package.json"), '{"name":"dsh-plugin-model-request-accelerator","version":"2.3.0"}');
  writeFileSync(join(badAccelerator, "lib/index.js"), readFileSync(join(repo, "vendor/dsh-plugin-model-request-accelerator/lib/index.js")));
  writeFileSync(join(badAccelerator, "lib/ledger.js"), readFileSync(join(repo, "vendor/dsh-plugin-model-request-accelerator/lib/ledger.js"), "utf8").replace('"../../zod/index.js"', '"unexpected-ledger-schema"'));
  const acceleratorDist = join(root, "plugins/bili-context-patch/vendor/dsh-plugin-model-request-accelerator/lib/index.js");
  const acceleratorBefore = readFileSync(acceleratorDist);
  const profileBefore = readFileSync(join(root, "package.json"));
  assert.throws(() => install(root, ["--accelerator", badAccelerator]));
  assert(acceleratorBefore.equals(readFileSync(acceleratorDist)));
  assert(profileBefore.equals(readFileSync(join(root, "package.json"))));
  assert(installed.equals(readFileSync(dist)));
  console.log("  OK incompatible accelerator rejected before replacing the installed runtime or profile");
} finally { clean(fixture); }
console.log("wrapper checks passed");
