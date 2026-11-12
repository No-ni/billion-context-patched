#!/usr/bin/env node
// Real Cordis, Loader, Storage, DomainFacility, zod and the vendored accelerator.
// The storage medium, connection routes and model iterator are isolated doubles.
// The legacy fixture is the exact ledger lifecycle replaced from accelerator
// e8c30af1f2b5cffa6749d032f0f296e17d4e26d0, not a rewritten approximation.
// No profile files, proxy startup, network requests or user processes are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mountMergedPlugins } from "../lib/startup.js";
import { legacyLedgerBlock, patchAcceleratorSources } from "./patch-accelerator.mjs";
import yaml from "../vendor/yaml/dist/index.js";

const arg = process.argv.indexOf("--host-modules");
if (arg < 0 && !process.env.DSH_HOST_MODULES) throw new Error("use --host-modules <DSH node_modules directory>");
const modules = resolve(arg < 0 ? process.env.DSH_HOST_MODULES : process.argv[arg + 1]);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@deepseek-ai/")) {
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.splice(0, 2).join("/") : parts.shift();
    const root = join(modules, name);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const pick = (value) => typeof value === "string" ? value : value?.node ? pick(value.node) : value?.import ? pick(value.import) : value?.default ? pick(value.default) : undefined;
    const key = parts.length ? "./" + parts.join("/") : ".";
    const target = key === "./package.json" ? "package.json" : pick(typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.[key]) ?? manifest.main;
    if (!target) throw new Error("missing host module export: " + specifier);
    return { url: pathToFileURL(join(root, target)).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { Context, Service } = await import("@deepseek-ai/cordis");
const { Loader } = await import("@deepseek-ai/cordis-plugin-loader");
const { Storage } = await import("@deepseek-ai/dsh-storage");
const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
const accelerator = await import("../vendor/dsh-plugin-model-request-accelerator/lib/index.js");
const { openLedger } = await import("../vendor/dsh-plugin-model-request-accelerator/lib/ledger.js");
const ownedAccelerator = { ...accelerator, Config: undefined };
const domainName = "model_request_timings";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const eventually = async (predicate, label) => {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error("timed out: " + label);
    await pause(10);
  }
};
const contexts = [];
const gates = [];
const initialFetch = globalThis.fetch;
const disabledRow = yaml.parse(readFileSync(new URL("../dsh.bundle.patch.yml", import.meta.url), "utf8"), {
  customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => ({ __jsExpr: value }) }],
}).find((row) => row.id === "model-request-accelerator").disabled;
assert.equal(typeof disabledRow.__jsExpr, "string");

function medium(ctx, { gate, mount = true } = {}) {
  const storage = new Storage(ctx);
  const state = { opens: 0, closes: 0, writes: [], collisions: [], events: [], facility: undefined };
  const records = new Map();
  ctx.effect(() => storage.backend.register("audit", { kv: { async open(descriptor) {
    assert.equal(descriptor.name, domainName);
    state.opens++;
    state.events.push("open:" + state.opens);
    if (state.opens === 1 && gate) await gate.promise;
    return {
      async loadAll() { return { global: null, tables: new Map([["sessions", new Map(records)]]) }; },
      async putRecord(table, key, value) { assert.equal(table, "sessions"); records.set(key, value); state.writes.push(key); state.events.push("write:" + key); },
      async deleteRecord(table, key) { records.delete(key); },
      async close() { state.closes++; state.events.push("close:" + state.closes); },
    };
  } } }));
  state.mount = () => ctx.plugin({ name: "audit-domain", inject: ["storage"], apply(scope) {
    const facility = new DomainFacility(scope, { backend: "audit" });
    const open = facility.open.bind(facility);
    facility.open = (spec) => {
      if (facility.reserved.has(spec.name)) state.collisions.push(spec.name);
      return open(spec);
    };
    state.facility = facility;
    scope.effect(() => {
      const unmount = scope.storage.mount("domain", facility);
      return async () => { await facility.closeAll(); unmount(); };
    });
    scope.provide("storageDomain", facility);
  } });
  if (mount) state.domainFiber = state.mount();
  return state;
}
function context(options) {
  const ctx = new Context();
  contexts.push(ctx);
  return { ctx, state: medium(ctx, options) };
}
class Connection extends Service {
  routes = new Map();
  constructor(ctx) { super(ctx, "connection"); }
  get fetch() {
    const owner = this.ctx;
    return { register: (route) => owner.effect(() => {
      assert(!this.routes.has(route.path), "duplicate route " + route.path);
      this.routes.set(route.path, route);
      return () => this.routes.delete(route.path);
    }) };
  }
}
const legacy = {
  name: "model-request-accelerator",
  apply: new Function("openLedger", "return function apply(ctx) { let ledger; const pendingWrites = new Map(); const timing = {snapshot: () => []};\n" + legacyLedgerBlock + "\n}")(openLedger),
};

try {
  // Source patch is repeatable, and refuses altered upstream cleanup semantics.
  const source = readFileSync(new URL("../vendor/dsh-plugin-model-request-accelerator/lib/index.js", import.meta.url), "utf8");
  const ledgerSource = readFileSync(new URL("../vendor/dsh-plugin-model-request-accelerator/lib/ledger.js", import.meta.url), "utf8");
  assert.deepEqual(patchAcceleratorSources(source, ledgerSource), { index: source, ledger: ledgerSource });
  const clean = source.replace(/\t\/\/ bili-context-patch: scoped-ledger-start[\s\S]*?\t\/\/ bili-context-patch: scoped-ledger-end/, legacyLedgerBlock);
  assert.equal(patchAcceleratorSources(clean, ledgerSource).index, source);
  assert.throws(() => patchAcceleratorSources(clean.replace("// Writes still queued", "// changed cleanup contract"), ledgerSource), /incompatible/);

  // Disabling a newly-started owned accelerator must wait for its late handle.
  {
    const gate = deferred(); gates.push(gate);
    const { ctx, state } = context({ gate });
    const fiber = ctx.plugin(ownedAccelerator, {});
    await eventually(() => state.opens === 1, "owned ledger starts opening");
    let disposed = false;
    const stopping = fiber.dispose().then(() => { disposed = true; });
    await pause(30);
    assert.equal(disposed, false);
    gate.resolve();
    await stopping;
    assert.equal(state.closes, 1);
    assert.equal(state.facility.reserved.has(domainName), false);
    assert.equal(globalThis.fetch, initialFetch);
    await ctx.fiber.dispose();
    console.log("  OK actual accelerator: disable awaits pending open and closes the late handle");
  }

  // Retire the exact legacy lifecycle while its domain is still opening.
  {
    const gate = deferred(); gates.push(gate);
    const { ctx, state } = context({ gate });
    const loader = new Loader(ctx);
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
    loader.builtins.legacy = legacy;
    const original = { id: "model-request-accelerator", name: "cordis:legacy" };
    await loader.root.update([original]);
    await loader.await();
    await eventually(() => state.opens === 1, "legacy ledger starts opening");
    let startup;
    loader.builtins.wrapper = { apply(scope) { startup = mountMergedPlugins(scope, [[ownedAccelerator, {}]], [original.id]); } };
    // Include the shipped composition row, as a manager hot install does. An
    // unconditional true here disposes the original BEFORE wrapper apply runs.
    await loader.root.update([{ ...original, disabled: disabledRow }, { id: "bili-context-patch", name: "cordis:wrapper" }]);
    await loader.await();
    await pause(30);
    assert.equal(state.opens, 1);
    assert.equal(loader.store[original.id].disabled, false);
    gate.resolve();
    assert.equal(await startup.ready, true);
    await eventually(() => state.opens === 2, "merged ledger opens after legacy closes");
    assert.equal(state.closes, 1);
    assert(state.events.indexOf("close:1") < state.events.indexOf("open:2"));
    assert.deepEqual(state.collisions, []);
    await ctx.fiber.dispose();
    assert.equal(state.closes, 2);
    console.log("  OK shipped hot-install row: legacy open finishes and closes before the merged ledger");
  }

  // The same composition rule prevents any original mount at a cold start.
  {
    const { ctx, state } = context({});
    const loader = new Loader(ctx);
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
    loader.builtins.legacy = legacy;
    const original = { id: "model-request-accelerator", name: "cordis:legacy", disabled: disabledRow };
    let startup;
    loader.builtins.wrapper = { apply(scope) { startup = mountMergedPlugins(scope, [[ownedAccelerator, {}]], [original.id]); } };
    await loader.root.update([original, { id: "bili-context-patch", name: "cordis:wrapper" }]);
    await loader.await();
    assert.equal(await startup.ready, true);
    await eventually(() => state.facility?.get(domainName) !== undefined, "cold-start owned ledger");
    assert.equal(state.opens, 1);
    assert.equal(loader.store[original.id].fiber, undefined);
    assert.equal(loader.store[original.id].disabled, true);
    assert.deepEqual(state.collisions, []);
    await ctx.fiber.dispose();
    console.log("  OK shipped cold-start row: original never mounts");
  }

  // Cancelling the wrapper during that wait must release guards and never mount
  // a child later when the original's open finally completes.
  {
    const gate = deferred(); gates.push(gate);
    const { ctx, state } = context({ gate });
    const loader = new Loader(ctx);
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
    loader.builtins.legacy = legacy;
    const original = { id: "model-request-accelerator", name: "cordis:legacy" };
    await loader.root.update([original]);
    await loader.await();
    await eventually(() => state.opens === 1, "legacy cancellation setup");
    let startup;
    loader.builtins.wrapper = { apply(scope) { startup = mountMergedPlugins(scope, [[ownedAccelerator, {}]], [original.id]); } };
    await loader.root.update([original, { id: "bili-context-patch", name: "cordis:wrapper" }]);
    await loader.await();
    await loader.store["bili-context-patch"].fiber.dispose();
    assert.equal(await startup.ready, false);
    gate.resolve();
    await pause(30);
    assert.equal(state.opens, 1);
    assert.equal(loader.store[original.id].disabled, false);
    await ctx.fiber.dispose();
    assert.equal(state.closes, 1);
    console.log("  OK cancelling a legacy wait releases guards and cannot mount children later");
  }

  // The optional domain can arrive after the accelerator and reload separately.
  {
    const { ctx, state } = context({ mount: false });
    const connection = new Connection(ctx);
    const fiber = ctx.plugin(ownedAccelerator, {});
    await fiber;
    assert.equal(state.opens, 0);
    const domain = state.mount();
    await eventually(() => state.facility?.get(domainName) !== undefined, "late domain service");
    const inner = { async *[Symbol.asyncIterator]() { yield { type: "finish", reason: { kind: "stop" } }; } };
    const stream = ctx.waterfall("llm/stream", { provider: "audit", model: "audit", sessionId: "queued" }, () => inner);
    for await (const _chunk of stream) {}
    await domain.dispose();
    assert.deepEqual(state.writes, ["queued"]);
    assert(state.events.indexOf("write:queued") < state.events.indexOf("close:1"));
    state.mount();
    await eventually(() => state.opens === 2 && state.facility.get(domainName) !== undefined, "domain service returns");
    const handle = state.facility.get(domainName);
    const pending = ctx.waterfall("llm/stream", { provider: "audit", model: "audit", sessionId: "unreadable-queued" }, () => inner);
    for await (const _chunk of pending) {}
    handle.failure = new Error("injected unreadable domain");
    const route = connection.routes.get("/api/model-request-accelerator/timings");
    assert(route, "timing route registered");
    const response = await route.fetch(new Request("http://audit.invalid/api/model-request-accelerator/timings?sessionId=unreadable"));
    assert.equal(response.status, 200);
    // Let the debounce timer fire after the failed read cleared the live ledger.
    // It must not throw from ledger.write on an undefined handle.
    await pause(350);
    assert.deepEqual(state.writes, ["queued"]);
    await fiber.dispose();
    assert.equal(state.closes, 2);
    assert.equal(state.facility.reserved.has(domainName), false);
    assert.equal(connection.routes.size, 0);
    await ctx.fiber.dispose();
    console.log("  OK late/reloaded storage, queued writes flush before close, read failure still releases the owned handle");
  }

  // Failed table resolution owns a domain; a pre-existing foreign ledger does not.
  {
    const { ctx, state } = context({});
    await eventually(() => state.facility !== undefined, "domain mount");
    const open = state.facility.open.bind(state.facility);
    state.facility.open = async (spec) => {
      const domain = await open(spec);
      return new Proxy(domain, { get(target, key) { return key === "table" ? () => { throw new Error("injected missing table"); } : Reflect.get(target, key); } });
    };
    assert.equal(await openLedger(ctx.get("storage"), () => {}), undefined);
    assert.equal(state.closes, 1);
    assert.equal(state.facility.reserved.has(domainName), false);
    state.facility.open = open;
    const foreign = await openLedger(ctx.get("storage"), () => {});
    const loader = new Loader(ctx);
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
    loader.builtins.legacy = legacy;
    const original = { id: "model-request-accelerator", name: "cordis:legacy" };
    await loader.root.update([original]);
    await loader.await();
    let startup;
    loader.builtins.wrapper = { apply(scope) { startup = mountMergedPlugins(scope, [[ownedAccelerator, {}]], [original.id]); } };
    await loader.root.update([original, { id: "bili-context-patch", name: "cordis:wrapper" }]);
    await loader.await();
    assert.equal(await startup.ready, true);
    await pause(20);
    assert.equal(state.closes, 1, "wrapper must not close a foreign domain");
    await loader.store["bili-context-patch"].fiber.dispose();
    assert.equal(state.closes, 1);
    await foreign.close();
    await ctx.fiber.dispose();
    console.log("  OK partial open is closed; suppression never closes a foreign ledger");
  }
  assert.equal(globalThis.fetch, initialFetch);
  console.log("ledger runtime checks passed (isolated doubles listed at the top of this file)");
} finally {
  for (const gate of gates) gate.resolve();
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
  hooks.deregister();
}
