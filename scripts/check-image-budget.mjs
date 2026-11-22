#!/usr/bin/env node
// Check that image limits are persisted on the native DeepSeek routes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const pi = (provider = "test") => ({ provider, settingsNs: "llm-pi-ai", settingsPath: ["providers", provider] });
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
check("PI routes receive compact image projection defaults", () => {
  assert.deepEqual(imageBudgetOps({}, row("llm-pi-ai", { providers: { test: {} } }, { providers: { test: {} } }), pi()), [
    { op: "set", path: ["providers", "test", "requestImageMaxBytes"], value: 153600 },
    { op: "set", path: ["providers", "test", "requestImagePixelBudget"], value: 1440000 },
    { op: "set", path: ["providers", "test", "maxRequestImageBytes"], value: 2097152 },
  ]);
});
check("PI defaults replace a loose authored provider budget", () => {
  const authored = { requestImageMaxBytes: 180000, requestImagePixelBudget: 900000, maxRequestImageBytes: 4000000 };
  assert.equal(imageBudgetOps({}, row("llm-pi-ai", { providers: { test: authored } }, { providers: { test: authored } }), pi()).length, 3);
});
check("explicit plugin PI budgets override provider values", () => {
  const root = row("llm-pi-ai", { providers: { test: { requestImageMaxBytes: 180000 } } }, {
    providers: { test: { requestImageMaxBytes: 180000 } },
  });
  assert.deepEqual(imageBudgetOps({ requestImageMaxBytes: 153600, maxRequestImageBytes: 2097152 }, root, pi()), [
    { op: "set", path: ["providers", "test", "requestImageMaxBytes"], value: 153600 },
    { op: "set", path: ["providers", "test", "requestImagePixelBudget"], value: 1440000 },
    { op: "set", path: ["providers", "test", "maxRequestImageBytes"], value: 2097152 },
  ]);
});
check("invalid PI budgets fail closed", () => {
  assert.deepEqual(imageBudgetOps({ requestImageMaxBytes: 0 }, row("llm-pi-ai"), pi()), []);
  assert.deepEqual(imageBudgetOps({ maxRequestImageBytes: 2.5 }, row("llm-pi-ai"), pi()), []);
  assert.equal(imageBudgetOps({}, row("llm-pi-ai", { providers: { test: { requestImageMaxBytes: 0 } } }), pi()).length, 3);
});
check("an untouched catalog route is never given a profile", () => {
  // DSH reports a provider as configured as soon as its profile exists, so a
  // budget must only land on a profile the user stored themselves.
  assert.deepEqual(imageBudgetOps({}, row("llm-pi-ai", {}, { providers: { anthropic: {} } }), pi("anthropic")), []);
  assert.deepEqual(imageBudgetOps({}, row("llm-pi-ai"), pi("openai")), []);
  assert.deepEqual(imageBudgetOps({ maxRequestImageBytes: 2097152 }, row("llm-pi-ai"), pi("groq")), []);
});
check("a stored but malformed PI profile fails closed", () => {
  assert.deepEqual(imageBudgetOps({}, row("llm-pi-ai", { providers: { test: "inline" } }), pi()), []);
});

const home = mkdtempSync(join(tmpdir(), "bili-image-budget-"));
try {
  const configPath = join(home, "billion-context.json");
  writeFileSync(configPath, "{}");
  // Bookkeeping can outlive the profile it describes — the user deleted that
  // provider. The next pass must drop the record, not rewrite the dead path.
  const backupPath = configPath + ".image-budget-backup.json";
  writeFileSync(backupPath, JSON.stringify({ version: 1, entries: [
    { key: "llm-pi-ai|providers|ghost", ns: "llm-pi-ai", path: ["providers", "ghost"], fields: [
      { hadValue: false, applied: 2097152 },
    ] },
  ] }));
  // Every PI route shares one namespace, and each accepted write advances the
  // revision the next route was read at — the conflict the real settings
  // service raises, which must not cost the pass the profiles after it.
  const profiles = ["test", "ylinkimi", "gateway-a", "gateway-b", "gateway-c"];
  const declared = () => Object.fromEntries(profiles.map(name => [
    name, { api: "openai-completions", baseURL: "https://" + name + ".test/v1" },
  ]));
  const rows = [
    row("llm-deepseek-api-key"),
    row("llm-deepseek-account"),
    row("llm-pi-ai", { providers: declared() }, { providers: declared() }),
  ];
  const routes = [deepseekApiKey, deepseekAccount, ...profiles.map(name => pi(name))];
  let writes = 0;
  const settings = {
    // The real service hands out a fresh descriptor per call, so a snapshot kept
    // across a write goes stale instead of aliasing the incremented revision.
    describe: () => rows.map(descriptor => ({ ...descriptor })),
    mutate: async (ns, ops, revision) => {
      const target = rows.find(candidate => candidate.ns === ns);
      if (target.revision !== revision) {
        const error = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${revision}, now ${target.revision})`);
        error.code = "SETTINGS_CONFLICT";
        throw error;
      }
      for (const op of ops) {
        let value = target.value;
        let user = target.user;
        for (const segment of op.path.slice(0, -1)) {
          value = value[segment] ??= {};
          user = user[segment] ??= {};
        }
        const key = op.path.at(-1);
        if (op.op === "unset") {
          delete value[key];
          delete user[key];
        } else {
          value[key] = op.value;
          user[key] = op.value;
        }
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
  const profile = name => rows[2].user.providers[name];
  const budgeted = () => profiles.every(name => profile(name).requestImageMaxBytes === 153600 &&
    profile(name).requestImagePixelBudget === 1440000 && profile(name).maxRequestImageBytes === 2097152);
  await eventually(() => rows.slice(0, 2).every(target => target.user.maxImagesPerRequest === 20 && target.user.imageOffloadCountQuantum === 10) && budgeted());
  assert.equal(writes, 2 + profiles.length);
  assert.ok(!readFileSync(backupPath, "utf8").includes("ghost"), "a dead backup entry must be pruned");
  console.log("  OK a backup entry for a provider that no longer exists is pruned");
  checks++;
  for (const name of profiles) {
    assert.deepEqual(profile(name), {
      api: "openai-completions",
      baseURL: "https://" + name + ".test/v1",
      requestImageMaxBytes: 153600,
      requestImagePixelBudget: 1440000,
      maxRequestImageBytes: 2097152,
    });
  }

  writeFileSync(configPath, JSON.stringify({ maxRequestImages: 34, imageOffloadCountQuantum: 7 }));
  await eventually(() => rows.slice(0, 2).every(target => target.user.maxImagesPerRequest === 34 && target.user.imageOffloadCountQuantum === 7));
  assert.equal(writes, 2 + profiles.length + 2);
  await dispose();
  assert.deepEqual(rows.slice(0, 2).map(target => [target.user.maxImagesPerRequest, target.user.imageOffloadCountQuantum]), [[34, 7], [34, 7]]);
  for (const name of profiles) {
    assert.deepEqual(profile(name), { api: "openai-completions", baseURL: "https://" + name + ".test/v1" });
  }
  console.log("  OK every configured PI profile is budgeted, and persisted host values survive disposal");
  checks++;

  // Second pass: a removed profile loses its record on the next settings event,
  // and teardown must survive the shutdown order where the host has already
  // disposed the settings service.
  const home2 = mkdtempSync(join(tmpdir(), "bili-image-budget-teardown-"));
  try {
    const configPath2 = join(home2, "billion-context.json");
    writeFileSync(configPath2, "{}");
    const declared2 = () => ({
      keep: { api: "openai-completions", baseURL: "https://keep.test/v1" },
      gone: { api: "openai-completions", baseURL: "https://gone.test/v1" },
    });
    const rows2 = [row("llm-pi-ai", { providers: declared2() }, { providers: declared2() })];
    const routes2 = [pi("keep"), pi("gone")];
    const services2 = {
      settings: {
        describe: () => rows2.map(descriptor => ({ ...descriptor })),
        mutate: async (ns, ops, revision) => {
          const target = rows2.find(candidate => candidate.ns === ns);
          if (target.revision !== revision) {
            const error = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${revision}, now ${target.revision})`);
            error.code = "SETTINGS_CONFLICT";
            throw error;
          }
          for (const op of ops) {
            let value = target.value;
            let user = target.user;
            for (const segment of op.path.slice(0, -1)) {
              value = value[segment] ??= {};
              user = user[segment] ??= {};
            }
            const key = op.path.at(-1);
            if (op.op === "unset") {
              delete value[key];
              delete user[key];
            } else {
              value[key] = op.value;
              user[key] = op.value;
            }
          }
          target.revision++;
        },
      },
      llm: { listConfigurableProviders: () => routes2 },
    };
    const listeners2 = new Map();
    let dispose2;
    installImageBudgetDefaults({
      inject: (dependencies, callback) => callback({
        get: name => services2[name],
        effect: effect => { dispose2 = effect(); },
        on: (event, callback2) => listeners2.set(event, callback2),
      }),
    }, {
      ready: Promise.resolve(true),
      configPath: () => configPath2,
      readConfig: path => JSON.parse(readFileSync(path, "utf8")),
    });
    const backupPath2 = configPath2 + ".image-budget-backup.json";
    await eventually(() => ["keep", "gone"].every(name =>
      rows2[0].user.providers[name].requestImageMaxBytes === 153600));
    assert.ok(readFileSync(backupPath2, "utf8").includes("gone"));
    delete rows2[0].user.providers.gone;
    delete rows2[0].value.providers.gone;
    listeners2.get("settings/document-updated")();
    const pruned = () => {
      const text = readFileSync(backupPath2, "utf8");
      return !text.includes("gone") && text.includes("keep");
    };
    const end2 = Date.now() + 5000;
    while (!pruned()) {
      if (Date.now() > end2) throw new Error("timed out while pruning a removed provider profile");
      await pause(10);
    }
    console.log("  OK a removed provider profile drops its backup record on the next pass");
    checks++;

    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      delete services2.settings;
      await dispose2();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(warnings, [], "teardown must not report an error once the settings service is gone");
    assert.ok(existsSync(backupPath2), "teardown without a settings service must keep the backup file");
    console.log("  OK teardown does not throw when the host already disposed the settings service");
    checks++;
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("image budget: " + checks + " checks passed");
