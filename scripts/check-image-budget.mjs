#!/usr/bin/env node
// Check that image limits are persisted on the native DeepSeek routes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageBudgetOps, installImageBudgetDefaults } from "../lib/defaults.js";

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log("  OK " + name);
};
const native = (provider, settingsNs) => ({ provider, settingsNs, settingsPath: [] });
const row = (ns, user = {}, value = { maxImagesPerRequest: 600, imageOffloadCountQuantum: 20 }) => ({ ns, user, value, revision: 1 });
const deepseekApiKey = native("deepseek-official", "llm-deepseek-api-key");
const deepseekAccount = native("deepseek-account", "llm-deepseek-account");

check("default budget writes 20 images and retires 10 on the API-key route", () => {
  assert.deepEqual(imageBudgetOps({}, row("llm-deepseek-api-key"), deepseekApiKey), [
    { op: "set", path: ["maxImagesPerRequest"], value: 20 },
    { op: "set", path: ["imageOffloadCountQuantum"], value: 10 },
  ]);
});
check("default budget also covers the account route", () => {
  assert.equal(imageBudgetOps({}, row("llm-deepseek-account"), deepseekAccount).length, 2);
});
check("an explicit plugin budget overrides native values", () => {
  assert.deepEqual(imageBudgetOps(
    { maxRequestImages: 32, imageOffloadCountQuantum: 8 },
    row("llm-deepseek-api-key", { maxImagesPerRequest: 600, imageOffloadCountQuantum: 20 }),
    deepseekApiKey,
  ), [
    { op: "set", path: ["maxImagesPerRequest"], value: 32 },
    { op: "set", path: ["imageOffloadCountQuantum"], value: 8 },
  ]);
});
check("a low maximum clamps an omitted retirement step", () => {
  assert.deepEqual(imageBudgetOps({ maxRequestImages: 5 }, row("llm-deepseek-api-key"), deepseekApiKey), [
    { op: "set", path: ["maxImagesPerRequest"], value: 5 },
    { op: "set", path: ["imageOffloadCountQuantum"], value: 5 },
  ]);
});
check("defaults preserve an existing user-authored native limit", () => {
  assert.deepEqual(imageBudgetOps({}, row("llm-deepseek-api-key", {
    maxImagesPerRequest: 100,
    imageOffloadCountQuantum: 25,
  }, { maxImagesPerRequest: 100, imageOffloadCountQuantum: 25 }), deepseekApiKey), []);
});
check("unchanged settings do not write again", () => {
  assert.deepEqual(imageBudgetOps(
    { maxRequestImages: 20, imageOffloadCountQuantum: 10 },
    row("llm-deepseek-api-key", {}, { maxImagesPerRequest: 20, imageOffloadCountQuantum: 10 }),
    deepseekApiKey,
  ), []);
});
check("defaults fill only a missing side of a native budget", () => {
  assert.deepEqual(imageBudgetOps({}, row("llm-deepseek-api-key", {
    maxImagesPerRequest: 5,
  }, { maxImagesPerRequest: 5, imageOffloadCountQuantum: 20 }), deepseekApiKey), [
    { op: "set", path: ["imageOffloadCountQuantum"], value: 5 },
  ]);
  assert.deepEqual(imageBudgetOps({}, row("llm-deepseek-account", {
    imageOffloadCountQuantum: 30,
  }, { maxImagesPerRequest: 600, imageOffloadCountQuantum: 30 }), deepseekAccount), [
    { op: "set", path: ["maxImagesPerRequest"], value: 30 },
  ]);
});
check("unsupported provider, namespace, and nested routes are ignored", () => {
  assert.deepEqual(imageBudgetOps({}, row("llm-pi-ai"), native("openai", "llm-pi-ai")), []);
  assert.deepEqual(imageBudgetOps({}, row("other"), deepseekApiKey), []);
  assert.deepEqual(imageBudgetOps({}, row("llm-deepseek-api-key"), {
    ...deepseekApiKey, settingsPath: ["providers", "deepseek-official"],
  }), []);
});
check("invalid values and expressions fail closed", () => {
  assert.deepEqual(imageBudgetOps({ maxRequestImages: 0 }, row("llm-deepseek-api-key"), deepseekApiKey), []);
  assert.deepEqual(imageBudgetOps({ maxRequestImages: 20, imageOffloadCountQuantum: 21 }, row("llm-deepseek-api-key"), deepseekApiKey), []);
  assert.deepEqual(imageBudgetOps({ __jsExpr: "config" }, row("llm-deepseek-api-key"), deepseekApiKey), []);
  assert.deepEqual(imageBudgetOps({}, row("llm-deepseek-api-key", { maxImagesPerRequest: { __jsExpr: "limit" } }), deepseekApiKey), []);
});

const home = mkdtempSync(join(tmpdir(), "bili-image-budget-"));
try {
  const configPath = join(home, "billion-context.json");
  writeFileSync(configPath, "{}");
  const rows = [
    row("llm-deepseek-api-key"),
    row("llm-deepseek-account"),
    row("llm-pi-ai"),
  ];
  const routes = [deepseekApiKey, deepseekAccount, native("openai", "llm-pi-ai")];
  let writes = 0;
  const settings = {
    describe: () => rows,
    mutate: async (ns, ops, revision) => {
      const target = rows.find(candidate => candidate.ns === ns);
      assert.equal(target.revision, revision);
      for (const op of ops) {
        const key = op.path[0];
        target.value[key] = op.value;
        target.user[key] = op.value;
      }
      target.revision++;
      writes++;
    },
  };
  const services = { settings, llm: { listConfigurableProviders: () => routes } };
  const listeners = new Map();
  let dispose;
  const scope = {
    get: name => services[name],
    effect: effect => { dispose = effect(); },
    on: (event, callback) => listeners.set(event, callback),
  };
  const ctx = { inject: (dependencies, callback) => {
    assert.deepEqual(dependencies, ["settings", "llm"]);
    callback(scope);
  } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const eventually = async predicate => {
    const end = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error("timed out while applying native image budget");
      await pause(10);
    }
  };

  installImageBudgetDefaults(ctx, {
    ready: Promise.resolve(true),
    configPath: () => configPath,
    readConfig: path => JSON.parse(readFileSync(path, "utf8")),
  });
  await eventually(() => rows.slice(0, 2).every(target => target.user.maxImagesPerRequest === 20 && target.user.imageOffloadCountQuantum === 10));
  assert.equal(writes, 2);
  assert.equal(rows[2].user.maxImagesPerRequest, undefined);

  writeFileSync(configPath, JSON.stringify({ maxRequestImages: 34, imageOffloadCountQuantum: 7 }));
  await eventually(() => rows.slice(0, 2).every(target => target.user.maxImagesPerRequest === 34 && target.user.imageOffloadCountQuantum === 7));
  assert.equal(writes, 4);
  dispose();
  assert.deepEqual(rows.slice(0, 2).map(target => [target.user.maxImagesPerRequest, target.user.imageOffloadCountQuantum]), [[34, 7], [34, 7]]);
  console.log("  OK persisted host values survive wrapper disposal and follow saved image settings");
  checks++;
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("image budget: " + checks + " checks passed");
