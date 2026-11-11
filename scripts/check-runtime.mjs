#!/usr/bin/env node
// Run against a directory containing the installed DSH host modules.
// Loader, Cordis, Schemastery, SettingsForms and atomic-write are real host code.
// Model plugins, the LLM directory, config-editor persistence and HMR are test
// doubles; no model call, proxy bootstrap or user profile is involved.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "../vendor/yaml/dist/index.js";

const arg = process.argv.indexOf("--host-modules");
const modules = resolve(arg < 0 ? process.env.DSH_HOST_MODULES ?? "" : process.argv[arg + 1]);
if (arg < 0 && !process.env.DSH_HOST_MODULES) throw new Error("use --host-modules <DSH node_modules directory>");
const repo = fileURLToPath(new URL("../", import.meta.url));
const repoURL = pathToFileURL(repo).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./ledger.js" && context.parentURL?.endsWith("/vendor/dsh-plugin-model-request-accelerator/lib/index.js")) {
    return { url: "data:text/javascript,export function openLedger(){throw new Error('ledger is outside this loader/schema test');}", shortCircuit: true };
  }
  if (specifier.startsWith("@deepseek-ai/")) {
    const [scope, name, ...rest] = specifier.split("/");
    const root = join(modules, scope, name);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const pick = (value) => typeof value === "string" ? value : value?.node ? pick(value.node) : value?.import ? pick(value.import) : value?.default ? pick(value.default) : undefined;
    const key = rest.length ? "./" + rest.join("/") : ".";
    const target = key === "./package.json" ? "package.json" : pick(typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.[key]) ?? manifest.main;
    if (!target) throw new Error("missing host module export: " + specifier);
    return { url: pathToFileURL(join(root, target)).href, shortCircuit: true };
  }
  if (context.parentURL?.startsWith(repoURL) && specifier === "./upstream.js") return {
    url: "data:text/javascript,export const bili=globalThis.__biliRuntimeChildren.bili;export const compactionGate=globalThis.__biliRuntimeChildren.gate;export const accelerator=globalThis.__biliRuntimeChildren.accelerator;",
    shortCircuit: true,
  };
  return next(specifier, context);
} });
const { Context, Service } = await import("@deepseek-ai/cordis");
const { Loader } = await import("@deepseek-ai/cordis-plugin-loader");
const { SettingsForms } = await import("@deepseek-ai/dsh-settings");
const z = (await import("@deepseek-ai/schemastery")).default;
const acceleratorConfig = (await import(new URL("../vendor/dsh-plugin-model-request-accelerator/lib/index.js", import.meta.url))).Config;
const { mergeInstalledProfile } = await import("../lib/profile.js");
const { profileRootOf } = await import("../lib/merge.js");
const io = await import("@deepseek-ai/dsh-atomic-write");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const eventually = async (predicate, label) => {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error("timed out: " + label);
    await pause(10);
  }
};
let scenario;
function resource(label, route) {
  return { name: label, apply(ctx, config) {
    if (scenario.routes.has(route)) { scenario.collisions.push(route); throw new Error("duplicate " + route); }
    if (label === "child-accelerator") scenario.acceleratorConfig = config;
    const owner = ctx.fiber.uid;
    ctx.effect(() => {
      scenario.routes.set(route, owner);
      scenario.events.push(label + ":mount");
      return async () => {
        await Promise.resolve();
        if (scenario.routes.get(route) === owner) scenario.routes.delete(route);
        scenario.events.push(label + ":dispose");
      };
    });
  } };
}
globalThis.__biliRuntimeChildren = {
  bili: resource("child-bili", "bili"), gate: resource("child-gate", "gate"),
  accelerator: { ...resource("child-accelerator", "accelerator"), Config: acceleratorConfig },
};
const wrapper = await import("../lib/index.js");
const taskRoot = mkdtempSync(join(tmpdir(), "bili-runtime-audit-"));
const contexts = [];
const profile = (name, bundles, patch) => {
  const dir = join(taskRoot, name);
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "billion-context": "old", "keep-me": "1.0.0" }, dsh: { profile: { bundles, keep: true } } }));
  writeFileSync(join(dir, "cordis.patch.yml"), patch);
  return { dir, home: join(dir, "home"), patchPath: join(dir, "cordis.patch.yml") };
};
async function context(data) {
  const ctx = new Context();
  contexts.push(ctx);
  const loader = new Loader(ctx);
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
  ctx.reflect.provide("profileContext", data);
  return { ctx, loader };
}
try {
  for (const order of ["wrapper-first", "wrapper-last"]) {
    scenario = { routes: new Map(), events: [], collisions: [] };
    const { ctx, loader } = await context(profile(order, ["bili-context-patch"], "[]\n"));
    loader.builtins.wrapper = order === "wrapper-last" ? pause(20).then(() => wrapper) : wrapper;
    const originals = ["bili-native", "bili-compaction-gate", "model-request-accelerator"].map((id, index) => {
      const plugin = resource("original-" + id, ["bili", "gate", "accelerator"][index]);
      loader.builtins[id] = order === "wrapper-first" ? pause(20).then(() => plugin) : plugin;
      return { id, name: "cordis:" + id };
    });
    const row = { id: "bili-context-patch", name: "cordis:wrapper" };
    await loader.root.update(order === "wrapper-first" ? [row, ...originals] : [...originals, row]);
    await loader.await();
    await eventually(() => scenario.routes.size === 3, "merged plugin mount");
    assert.deepEqual(scenario.collisions, []);
    assert(originals.every((row) => loader.store[row.id].disabled));
    const entry = loader.store["model-request-accelerator"];
    await entry.update({ disabled: false });
    assert.equal(entry.disabled, true);
    await loader.store["bili-context-patch"].fiber.dispose();
    assert.equal(scenario.routes.size, 0);
    await entry.update({ disabled: false });
    await loader.await();
    assert.equal(entry.disabled, false);
    assert.equal(scenario.routes.size, 1);
    await ctx.fiber.dispose();
    console.log("  OK actual Loader: " + order + ", no route collisions, originals usable after wrapper disposal");
  }

  // A migration/reconcile failure must finish retrying before defaults write.
  // Services appear after the old implementation's 2.5-second final attempt.
  {
    scenario = { routes: new Map(), events: [], collisions: [] };
    const data = profile("settings", ["billion-context", "dsh-plugin-model-request-accelerator", "bili-context-patch"], [
      "- id: model-request-accelerator",
      "  config: {providers: {off: {enabled: false, encoding: gzip}}, timing: false}",
      "- id: bili-context-patch",
      "  config: {providers: {partial: {minBytes: 321}}}",
      "",
    ].join("\n"));
    const { ctx, loader } = await context(data);
    class Agents extends Service {
      constructor(ctx) { super(ctx, "agents"); }
      create(options) { return options; }
    }
    class Controller extends Service {
      constructor(ctx) { super(ctx, "sessionController"); }
      async fork(request) {
        await Promise.resolve();
        return this.ctx.agents.create({ meta: { isSeeded: true, ...request.meta } });
      }
    }
    const agents = new Agents(ctx);
    const controller = new Controller(ctx);
    const originals = [agents.create, controller.fork];
    let reconcileCalls = 0;
    const executing = new AsyncLocalStorage();
    let operations = Promise.resolve();
    const hmr = { executing, runExclusive(operation) {
      if (executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"));
      const task = operations.then(() => executing.run(true, operation));
      operations = task.catch(() => {});
      return task;
    }, async reconcileProfile() {
      if (executing.getStore() !== true) throw new Error("HMR profile reconciliation must run inside runExclusive");
      if (++reconcileCalls === 1) throw new Error("injected HMR failure");
      const row = yaml.parse(readFileSync(data.patchPath, "utf8")).find((row) => row.id === "bili-context-patch");
      await loader.store[row.id].update({ config: row.config });
      ctx.emit("app-boot/config-reload");
      return { warnings: [], pending: [] };
    } };
    ctx.reflect.provide("hmr", hmr);
    const providerSchema = z.object({ providers: z.dict(z.object({ baseURL: z.string() })).default({}).volatile() });
    loader.builtins.wrapper = wrapper;
    loader.builtins.relay = { Config: providerSchema, apply() {} };
    loader.builtins.decoy = { Config: acceleratorConfig, apply() {} };
    await hmr.runExclusive(() => loader.root.update([
      { id: "prefix-bili-context-patch-other", name: "cordis:decoy", config: {} },
      { id: "bili-context-patch", name: "cordis:wrapper", config: { providers: { partial: { minBytes: 321 } } } },
      { id: "llm-relay", name: "cordis:relay", config: { providers: {
        partial: { baseURL: "https://www.didudidu.asia/v1" },
        off: { baseURL: "http://154.219.111.56/v1" },
        newip: { baseURL: "http://154.219.111.56:8080/v1" },
        other: { baseURL: "https://example.org/v1" },
      } } },
    ]));
    await loader.await();
    await eventually(() => reconcileCalls >= 2, "HMR retry of already-written migration");
    const forked = await Promise.all(["parent-one", "parent-two"].map((sessionId) => ctx.sessionController.fork({ sessionId })));
    assert.deepEqual(forked.map((row) => row.meta.parentSession), ["parent-one", "parent-two"]);
    assert.equal((await ctx.sessionController.fork({ sessionId: "parent-three", meta: { parentSession: "authored" } })).meta.parentSession, "authored");
    let edits = 0;
    let conflicts = 0;
    let injectConflict = true;
    const persist = async (entry, config) => {
      const rows = yaml.parse(readFileSync(data.patchPath, "utf8"));
      rows.find((row) => row.id === entry.options.id).config = config;
      await io.writeFileAtomic(data.patchPath, yaml.stringify(rows), { mode: 0o600 });
    };
    ctx.reflect.provide("configEditor", {
      entries: () => [...loader.entries()],
      configuration: () => [...loader.entries()].map((entry) => ({ entry, inherited: {}, override: entry.options.config ?? {} })),
      async edit(entry, change) {
        edits++;
        return io.withFileLock(join(data.dir, "package.json"), async () => {
          if (injectConflict && entry.options.id === "bili-context-patch") {
            injectConflict = false;
            const authored = structuredClone(entry.options.config);
            authored.providers.partial.encoding = "gzip";
            await persist(entry, authored);
            await entry.update({ config: authored });
            ctx.settings.describe();
          }
          try {
            const next = change(structuredClone(entry.options.config ?? {}), {});
            if (entry.fiber.state !== 2) throw new Error("configuration entry is no longer active");
            await persist(entry, next);
            await entry.update({ config: next });
          } catch (error) {
            if (error.code === "SETTINGS_CONFLICT") conflicts++;
            throw error;
          }
        });
      },
    });
    let directory = [];
    ctx.reflect.provide("llm", { listConfigurableProviders: () => structuredClone(directory) });
    await pause(2700);
    await ctx.plugin(SettingsForms);
    const before = ctx.settings.describe().find((row) => row.ns === "bili-context-patch");
    assert.equal(before.value.providers.partial.enabled, false);
    assert.equal(Object.hasOwn(loader.store["bili-context-patch"].options.config.providers.partial, "enabled"), false);
    directory = ["partial", "off", "newip", "other"].map((provider) => ({
      provider, settingsNs: "llm-relay", settingsPath: ["providers", provider],
    }));
    ctx.emit("llm/adapters-updated");
    const entry = loader.store["bili-context-patch"];
    await eventually(() => entry.options.config.providers.newip?.enabled === true, "late defaults");
    assert.equal(conflicts, 1);
    assert.deepEqual(entry.options.config.providers.partial, { minBytes: 321, encoding: "gzip", enabled: true });
    assert.deepEqual(entry.options.config.providers.off, { enabled: false, encoding: "gzip" });
    assert.deepEqual(entry.options.config.providers.newip, { enabled: true, encoding: "auto" });
    assert.equal(entry.options.config.providers.other, undefined);
    assert.deepEqual(loader.store["prefix-bili-context-patch-other"].options.config, {});
    assert.equal(scenario.acceleratorConfig, entry.fiber.effectiveConfig);
    assert.equal(scenario.acceleratorConfig.providers.get().partial.enabled, true);
    await ctx.settings.mutate("bili-context-patch", [{ op: "set", path: ["providers", "partial", "enabled"], value: false }]);
    assert.equal(scenario.acceleratorConfig.providers.get().partial.enabled, false);
    ctx.emit("llm/adapters-updated");
    await pause(25);
    assert.equal(entry.options.config.providers.partial.enabled, false);
    const persisted = yaml.parse(readFileSync(data.patchPath, "utf8")).find((row) => row.id === "bili-context-patch");
    assert.equal(persisted.config.providers.partial.enabled, false);
    assert.equal(persisted.config.providers.partial.encoding, "gzip");
    assert.equal(persisted.config.timing, false);
    assert.deepEqual(JSON.parse(readFileSync(join(data.dir, "package.json"))).dsh.profile.bundles, ["bili-context-patch"]);
    const beforeDispose = edits;
    await entry.fiber.dispose();
    assert.equal(agents.create, originals[0]);
    assert.equal(controller.fork, originals[1]);
    ctx.emit("llm/adapters-updated");
    await pause(25);
    assert.equal(edits, beforeDispose);
    assert.deepEqual(scenario.collisions, []);
    await ctx.fiber.dispose();
    console.log("  OK actual SettingsForms: late services, schema defaults, conflict retry, authored choices, live accessors, exact namespace, dispose");
    console.log("  OK actual Cordis service proxies: fork lineage and method restoration");
  }

  // Use the official lock/atomic writer, including a concurrent manifest writer.
  {
    const data = profile("atomic", ["billion-context", "keep-me", "dsh-plugin-model-request-accelerator", "bili-context-patch"],
      "- id: model-request-accelerator\n  config: {providers: {relay: {enabled: false, encoding: gzip}}}\n- id: bili-context-patch\n  config: {providers: {relay: {prewarm: true}}}\n");
    const path = join(data.dir, "package.json");
    writeFileSync(data.patchPath + ".bak-user", "user backup");
    for (const basename of ["package.json", "cordis.patch.yml"]) for (let i = 0; i < 4; i++) writeFileSync(join(data.dir, basename + ".bak-bili-context-patch-" + String(i).padStart(17, "0")), "old backup");
    let acquired;
    let release;
    const locked = new Promise((done) => { acquired = done; });
    const held = io.withFileLock(path, async () => {
      acquired();
      await new Promise((done) => { release = done; });
      const manifest = JSON.parse(readFileSync(path));
      manifest.dependencies.concurrent = "2.0.0";
      await io.writeFileAtomic(path, JSON.stringify(manifest), { mode: 0o600 });
    });
    await locked;
    const pending = mergeInstalledProfile({ profileRoot: data.dir, ...io });
    await pause(25);
    release();
    await held;
    const result = await pending;
    assert.equal(result.removed, 2);
    assert.equal(result.migrated, 1);
    const after = JSON.parse(readFileSync(path));
    assert.equal(after.dependencies.concurrent, "2.0.0");
    assert.equal(after.dependencies["billion-context"], "old");
    assert.deepEqual(after.dsh.profile.bundles, ["keep-me", "bili-context-patch"]);
    assert.equal(after.dsh.profile.keep, true);
    for (const basename of ["package.json", "cordis.patch.yml"]) assert.equal(readdirSync(data.dir).filter((name) => name.startsWith(basename + ".bak-bili-context-patch-")).length, 3);
    assert.equal(readFileSync(data.patchPath + ".bak-user", "utf8"), "user backup");
    const snapshot = [readFileSync(path), readFileSync(data.patchPath)];
    assert.equal((await mergeInstalledProfile({ profileRoot: data.dir, ...io })).changed, false);
    assert(snapshot[0].equals(readFileSync(path)));
    assert(snapshot[1].equals(readFileSync(data.patchPath)));

    const rollback = profile("rollback", ["billion-context", "bili-context-patch"], "- id: model-request-accelerator\n  config: {timing: false}\n");
    const originalPatch = readFileSync(rollback.patchPath);
    const originalManifest = readFileSync(join(rollback.dir, "package.json"));
    await assert.rejects(mergeInstalledProfile({ profileRoot: rollback.dir, ...io, writeFileAtomic: async (file, text, options) => {
      if (file.endsWith("package.json")) throw new Error("injected manifest write failure");
      return io.writeFileAtomic(file, text, options);
    } }), /injected manifest/);
    assert(originalPatch.equals(readFileSync(rollback.patchPath)));
    assert(originalManifest.equals(readFileSync(join(rollback.dir, "package.json"))));
    assert(!readdirSync(rollback.dir).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")));
    assert.equal((await mergeInstalledProfile({ profileRoot: rollback.dir, ...io, isActive: () => false })).changed, false);
    const nested = join(data.dir, "node_modules/.pnpm/bili-context-patch@0.6.5/node_modules/bili-context-patch");
    mkdirSync(nested, { recursive: true });
    assert.equal(await profileRootOf(nested), data.dir);
    console.log("  OK official atomic writer: lock contention, concurrent fields, rollback, own backup rotation, idempotence, pnpm profile path");
  }
} finally {
  for (const ctx of contexts) await ctx.fiber.dispose();
  hooks.deregister();
  delete globalThis.__biliRuntimeChildren;
  assert(resolve(taskRoot).startsWith(resolve(tmpdir()) + sep));
  rmSync(taskRoot, { recursive: true, force: true });
}
console.log("host runtime checks passed (test doubles listed at the top of this file)");
