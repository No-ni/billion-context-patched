#!/usr/bin/env node
// Check that image limits are persisted on the native DeepSeek routes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

    // A provider configured while the plugin is already running must be picked
    // up by the settings event, not only on the next startup.
    rows2[0].user.providers.late = { api: "openai-completions", baseURL: "https://late.test/v1" };
    rows2[0].value.providers.late = { api: "openai-completions", baseURL: "https://late.test/v1" };
    routes2.push(pi("late"));
    listeners2.get("settings/document-updated")();
    await eventually(() => rows2[0].user.providers.late.requestImageMaxBytes === 153600 &&
      rows2[0].user.providers.late.requestImagePixelBudget === 1440000 &&
      rows2[0].user.providers.late.maxRequestImageBytes === 2097152);
    const lateBackup = readFileSync(backupPath2, "utf8");
    assert.ok(lateBackup.includes("late"), "a newly configured provider must be recorded for restore");
    assert.ok(lateBackup.includes("\"name\":\"requestImageMaxBytes\""), "a backup record must name the field it captured");
    console.log("  OK a provider configured while running is budgeted on the next settings event");
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

  // A restart loads the backup file written by the previous process. Records
  // must carry the field names the next process needs, or the restore on
  // uninstall silently skips a field it cannot name.
  const home3 = mkdtempSync(join(tmpdir(), "bili-image-budget-restart-"));
  try {
    const configPath3 = join(home3, "billion-context.json");
    writeFileSync(configPath3, "{}");
    const declared3 = () => ({ fresh: { api: "openai-completions", baseURL: "https://fresh.test/v1" } });
    const rows3 = [row("llm-pi-ai", { providers: declared3() }, { providers: declared3() })];
    const services3 = {
      settings: {
        describe: () => rows3.map(descriptor => ({ ...descriptor })),
        mutate: async (ns, ops, revision) => {
          const target = rows3.find(candidate => candidate.ns === ns);
          if (target.revision !== revision) {
            const error = new Error("settings namespace \"" + ns + "\" changed since it was read (expected revision " + revision + ", now " + target.revision + ")");
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
            if (op.op === "unset") { delete value[key]; delete user[key]; }
            else { value[key] = op.value; user[key] = op.value; }
          }
          target.revision++;
        },
      },
      llm: { listConfigurableProviders: () => [pi("fresh")] },
    };
    const boot = () => {
      const listeners = new Map();
      let dispose;
      installImageBudgetDefaults({
        inject: (dependencies, callback) => callback({
          get: name => services3[name],
          effect: effect => { dispose = effect(); },
          on: (event, callback2) => listeners.set(event, callback2),
        }),
      }, {
        ready: Promise.resolve(true),
        configPath: () => configPath3,
        readConfig: path => JSON.parse(readFileSync(path, "utf8")),
      });
      return { listeners, dispose: () => dispose() };
    };
    const backupPath3 = configPath3 + ".image-budget-backup.json";
    const first = boot();
    await eventually(() => rows3[0].user.providers.fresh.requestImageMaxBytes === 153600);
    assert.ok(readFileSync(backupPath3, "utf8").includes("\"name\":\"requestImageMaxBytes\""), "the backup must name each field so a later process can restore it");
    // A file written by the previous release has no field names; a full set is
    // still restorable because the capture order is PI_IMAGE_KEYS order.
    const legacy = JSON.parse(readFileSync(backupPath3, "utf8"));
    for (const entry of legacy.entries) for (const field of entry.fields) delete field.name;
    writeFileSync(backupPath3, JSON.stringify(legacy));
    const second = boot();
    await pause(50);
    await second.dispose();
    assert.deepEqual(rows3[0].user.providers.fresh, { api: "openai-completions", baseURL: "https://fresh.test/v1" }, "a fresh process must restore the fields the previous process recorded");
    await first.dispose();
    assert.ok(!existsSync(backupPath3), "restoring every recorded field must remove the backup file");
    console.log("  OK a restart restores the fields recorded by the previous process");
    checks++;
  } finally {
    rmSync(home3, { recursive: true, force: true });
  }

  // A malformed config is not a reason to leave images unbudgeted forever: the
  // pass uses the built-in defaults and a later file repair is picked up by the
  // watcher without a restart.
  const home4 = mkdtempSync(join(tmpdir(), "bili-image-budget-config-"));
  try {
    const configPath4 = join(home4, "billion-context.json");
    writeFileSync(configPath4, "{ not json");
    const rows4 = [row("llm-deepseek-api-key")];
    const settings4 = {
      describe: () => rows4.map(descriptor => ({ ...descriptor })),
      mutate: async (ns, ops, revision) => {
        const target = rows4.find(candidate => candidate.ns === ns);
        if (target.revision !== revision) {
          const error = new Error("conflict");
          error.code = "SETTINGS_CONFLICT";
          throw error;
        }
        for (const op of ops) {
          target.value[op.path.at(-1)] = op.value;
          target.user[op.path.at(-1)] = op.value;
        }
        target.revision++;
      },
    };
    const listeners4 = new Map();
    let dispose4;
    const warnings4 = [];
    const warn4 = console.warn;
    console.warn = (...args) => { warnings4.push(args.join(" ")); };
    try {
      installImageBudgetDefaults({
        inject: (dependencies, callback) => callback({
          get: name => name === "settings" ? settings4 : { listConfigurableProviders: () => [deepseekApiKey] },
          effect: effect => { dispose4 = effect(); },
          on: (event, callback2) => listeners4.set(event, callback2),
        }),
      }, {
        ready: Promise.resolve(true),
        configPath: () => configPath4,
        readConfig: path => JSON.parse(readFileSync(path, "utf8")),
      });
      await eventually(() => rows4[0].user.maxImagesPerRequest === 20);
      assert.ok(warnings4.some(line => line.includes("could not read the image configuration")),
        "a malformed config must be reported once, not silently ignored");
      assert.equal(rows4[0].user.imageOffloadCountQuantum, 10, "the built-in budget must still apply to a malformed config");
      writeFileSync(configPath4, JSON.stringify({ maxRequestImages: 34, imageOffloadCountQuantum: 7 }));
      listeners4.get("settings/document-updated")();
      await eventually(() => rows4[0].user.maxImagesPerRequest === 34 && rows4[0].user.imageOffloadCountQuantum === 7);
    } finally {
      console.warn = warn4;
      if (dispose4) await dispose4();
    }
    console.log("  OK a malformed config falls back to defaults and recovers when the file is repaired");
    checks++;
  } finally {
    rmSync(home4, { recursive: true, force: true });
  }

  // One provider rejecting a budget must not starve every route after it.
  const home5 = mkdtempSync(join(tmpdir(), "bili-image-budget-route-"));
  try {
    const configPath5 = join(home5, "billion-context.json");
    writeFileSync(configPath5, "{}");
    const declared5 = () => ({ bad: { api: "openai-completions", baseURL: "https://bad.test/v1" },
      good: { api: "openai-completions", baseURL: "https://good.test/v1" } });
    const rows5 = [row("llm-pi-ai", { providers: declared5() }, { providers: declared5() })];
    const settings5 = {
      describe: () => rows5.map(descriptor => ({ ...descriptor })),
      mutate: async (ns, ops, revision) => {
        const target = rows5.find(candidate => candidate.ns === ns);
        if (target.revision !== revision) {
          const error = new Error("conflict");
          error.code = "SETTINGS_CONFLICT";
          throw error;
        }
        if (ops.some(op => op.path.includes("bad"))) {
          const error = new Error("provider profile is read only");
          error.code = "SETTINGS_READ_ONLY";
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
          if (op.op === "unset") { delete value[key]; delete user[key]; }
          else { value[key] = op.value; user[key] = op.value; }
        }
        target.revision++;
      },
    };
    const listeners5 = new Map();
    let dispose5;
    const warnings5 = [];
    const warn5 = console.warn;
    console.warn = (...args) => { warnings5.push(args.join(" ")); };
    try {
      installImageBudgetDefaults({
        inject: (dependencies, callback) => callback({
          get: name => name === "settings" ? settings5 : { listConfigurableProviders: () => [pi("bad"), pi("good")] },
          effect: effect => { dispose5 = effect(); },
          on: (event, callback2) => listeners5.set(event, callback2),
        }),
      }, {
        ready: Promise.resolve(true),
        configPath: () => configPath5,
        readConfig: path => JSON.parse(readFileSync(path, "utf8")),
      });
      await eventually(() => rows5[0].user.providers.good.requestImageMaxBytes === 153600);
      assert.equal(rows5[0].user.providers.bad.requestImageMaxBytes, undefined);
      assert.ok(warnings5.some(line => line.includes("providers.bad") && line.includes("read only")),
        "the rejected route must be reported without aborting the pass");
    } finally {
      console.warn = warn5;
      if (dispose5) await dispose5();
    }
    assert.equal(rows5[0].user.providers.good.requestImageMaxBytes, undefined, "teardown must still undo the route that succeeded");
    assert.equal(rows5[0].user.providers.bad.requestImageMaxBytes, undefined);
    console.log("  OK one rejected provider route does not starve later routes");
    checks++;
  } finally {
    rmSync(home5, { recursive: true, force: true });
  }

  // Disposing while a write is in flight must wait for it, record it, and undo
  // it; otherwise the late write leaves an unowned budget behind forever.
  const home6 = mkdtempSync(join(tmpdir(), "bili-image-budget-inflight-"));
  try {
    const configPath6 = join(home6, "billion-context.json");
    writeFileSync(configPath6, "{}");
    const declared6 = () => ({
      slow: { api: "openai-completions", baseURL: "https://slow.test/v1" },
      inflight: { api: "openai-completions", baseURL: "https://inflight.test/v1" },
    });
    const rows6 = [row("llm-pi-ai", { providers: declared6() }, { providers: declared6() })];
    let release;
    let started = false;
    const settings6 = {
      describe: () => rows6.map(descriptor => ({ ...descriptor })),
      mutate: async (ns, ops, revision) => {
        const target = rows6.find(candidate => candidate.ns === ns);
        if (target.revision !== revision) {
          const error = new Error("conflict");
          error.code = "SETTINGS_CONFLICT";
          throw error;
        }
        if (!started && ops.some(op => op.path.includes("inflight"))) {
          started = true;
          await new Promise(resolve => { release = resolve; });
        }
        for (const op of ops) {
          let value = target.value;
          let user = target.user;
          for (const segment of op.path.slice(0, -1)) {
            value = value[segment] ??= {};
            user = user[segment] ??= {};
          }
          const key = op.path.at(-1);
          if (op.op === "unset") { delete value[key]; delete user[key]; }
          else { value[key] = op.value; user[key] = op.value; }
        }
        target.revision++;
      },
    };
    let dispose6;
    installImageBudgetDefaults({
      inject: (dependencies, callback) => callback({
        get: name => name === "settings" ? settings6 : { listConfigurableProviders: () => [pi("slow"), pi("inflight")] },
        effect: effect => { dispose6 = effect(); },
        on: () => {},
      }),
    }, {
      ready: Promise.resolve(true),
      configPath: () => configPath6,
      readConfig: path => JSON.parse(readFileSync(path, "utf8")),
    });
    await eventually(() => started && rows6[0].user.providers.slow.requestImageMaxBytes === 153600);
    const done = dispose6();
    release();
    await done;
    const clean = name => rows6[0].user.providers[name].requestImageMaxBytes === undefined &&
      rows6[0].user.providers[name].requestImagePixelBudget === undefined &&
      rows6[0].user.providers[name].maxRequestImageBytes === undefined;
    assert.ok(clean("slow"), "the already written profile must be restored");
    assert.ok(clean("inflight"), "the in-flight profile must be recorded and restored, not leaked");
    assert.ok(!existsSync(configPath6 + ".image-budget-backup.json"), "restoring every field must remove the backup");
    console.log("  OK disposing during an in-flight write restores the late provider");
    checks++;
  } finally {
    rmSync(home6, { recursive: true, force: true });
  }
  // IMG-10a: a backup that cannot be parsed is never silently overwritten. One
  // warning is reported, the bytes are moved aside as .corrupt-<timestamp>, and
  // the pass continues without restore records.
  const home7 = mkdtempSync(join(tmpdir(), "bili-image-budget-corrupt-"));
  try {
    const configPath7 = join(home7, "billion-context.json");
    writeFileSync(configPath7, "{}");
    const declared7 = () => ({ corrupt: { api: "openai-completions", baseURL: "https://corrupt.test/v1" } });
    const rows7 = [row("llm-pi-ai", { providers: declared7() }, { providers: declared7() })];
    const services7 = {
      settings: {
        describe: () => rows7.map(descriptor => ({ ...descriptor })),
        mutate: async (ns, ops, revision) => {
          const target = rows7.find(candidate => candidate.ns === ns);
          assert.equal(target.revision, revision, "the corrupt-backup pass must write at the revision it read");
          for (const op of ops) {
            let value = target.value, user = target.user;
            for (const segment of op.path.slice(0, -1)) { value = value[segment] ??= {}; user = user[segment] ??= {}; }
            const key = op.path.at(-1);
            if (op.op === "unset") { delete value[key]; delete user[key]; }
            else { value[key] = op.value; user[key] = op.value; }
          }
          target.revision++;
        },
      },
      llm: { listConfigurableProviders: () => [pi("corrupt")] },
    };
    const backupPath7 = configPath7 + ".image-budget-backup.json";
    writeFileSync(backupPath7, "{not-json");
    const warnings = [], warn = console.warn;
    console.warn = message => warnings.push(String(message));
    let dispose7;
    try {
      installImageBudgetDefaults({
        inject: (dependencies, callback) => callback({ get: name => services7[name], effect: effect => { dispose7 = effect(); }, on: () => {} }),
      }, { ready: Promise.resolve(true), configPath: () => configPath7, readConfig: path => JSON.parse(readFileSync(path, "utf8")) });
      await eventually(() => warnings.some(message => message.includes("could not read " + backupPath7)));
      const asideName = () => readdirSync(home7).find(name => name.startsWith("billion-context.json.image-budget-backup.json.corrupt-"));
      await eventually(asideName, "the unreadable backup must be kept as .corrupt-<timestamp>");
      const aside = asideName();
      assert.equal(readFileSync(join(home7, aside), "utf8"), "{not-json", "the aside file must keep the original bytes");
      assert(warnings.some(message => message.includes("moved the unreadable image budget backup to")), "the move must be reported");
      await eventually(() => rows7[0].user.providers.corrupt.requestImageMaxBytes === 153600);
      console.log("  OK an unparsable image budget backup is kept aside and the pass continues");
      checks++;
    } finally { console.warn = warn; }
    await pause(20);
    if (typeof dispose7 === "function") dispose7();
  } finally {
    rmSync(home7, { recursive: true, force: true });
  }
  // IMG-10a: a backup that cannot be written must not stop the budget pass. A
  // read-only directory makes the atomic temp+rename fail; the fields still land
  // on the provider and the failure is reported once.
  const home8 = mkdtempSync(join(tmpdir(), "bili-image-budget-writefail-"));
  try {
    const configPath8 = join(home8, "billion-context.json");
    writeFileSync(configPath8, "{}");
    const declared8 = () => ({ readonly: { api: "openai-completions", baseURL: "https://readonly.test/v1" } });
    const rows8 = [row("llm-pi-ai", { providers: declared8() }, { providers: declared8() })];
    const services8 = {
      settings: {
        describe: () => rows8.map(descriptor => ({ ...descriptor })),
        mutate: async (ns, ops, revision) => {
          const target = rows8.find(candidate => candidate.ns === ns);
          assert.equal(target.revision, revision);
          for (const op of ops) {
            let value = target.value, user = target.user;
            for (const segment of op.path.slice(0, -1)) { value = value[segment] ??= {}; user = user[segment] ??= {}; }
            const key = op.path.at(-1);
            if (op.op === "unset") { delete value[key]; delete user[key]; }
            else { value[key] = op.value; user[key] = op.value; }
          }
          target.revision++;
        },
      },
      llm: { listConfigurableProviders: () => [pi("readonly")] },
    };
    const warnings = [], warn = console.warn;
    console.warn = message => warnings.push(String(message));
    const previousMode = statSync(home8).mode & 0o777;
    let dispose8;
    try {
      chmodSync(home8, 0o555);
      installImageBudgetDefaults({
        inject: (dependencies, callback) => callback({ get: name => services8[name], effect: effect => { dispose8 = effect(); }, on: () => {} }),
      }, { ready: Promise.resolve(true), configPath: () => configPath8, readConfig: path => JSON.parse(readFileSync(path, "utf8")) });
      await eventually(() => rows8[0].user.providers.readonly.requestImageMaxBytes === 153600);
      assert(warnings.some(message => message.includes("could not write the image budget backup at " + configPath8)), "a failed backup write must be reported");
      assert(!existsSync(configPath8 + ".image-budget-backup.json"), "a failed backup write must not leave a partial file");
      console.log("  OK a read-only profile still gets its budget and a failed backup write is reported");
      checks++;
    } finally {
      chmodSync(home8, previousMode);
      console.warn = warn;
    }
    await pause(20);
    if (typeof dispose8 === "function") dispose8();
  } finally {
    rmSync(home8, { recursive: true, force: true });
  }
  // IMG-10a: a failed delete ("no records left" against a read-only directory)
  // must not become an unhandled rejection — the pass simply keeps the file.
  const home9 = mkdtempSync(join(tmpdir(), "bili-image-budget-delfail-"));
  try {
    const configPath9 = join(home9, "billion-context.json");
    writeFileSync(configPath9, "{}");
    const backupPath9 = configPath9 + ".image-budget-backup.json";
    writeFileSync(backupPath9, JSON.stringify({ version: 1, entries: [
      { key: "llm-pi-ai|providers|ghost", ns: "llm-pi-ai", path: ["providers", "ghost"], fields: [{ name: "requestImageMaxBytes", hadValue: false, applied: 153600 }] },
    ] }));
    const rows9 = [row("llm-pi-ai", {}, {})];
    const services9 = {
      settings: { describe: () => rows9.map(descriptor => ({ ...descriptor })), mutate: async () => {} },
      llm: { listConfigurableProviders: () => [] },
    };
    const rejections = [], onRejection = reason => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const previousMode9 = statSync(home9).mode & 0o777;
    let dispose9;
    try {
      chmodSync(home9, 0o555);
      installImageBudgetDefaults({
        inject: (dependencies, callback) => callback({ get: name => services9[name], effect: effect => { dispose9 = effect(); }, on: () => {} }),
      }, { ready: Promise.resolve(true), configPath: () => configPath9, readConfig: path => JSON.parse(readFileSync(path, "utf8")) });
      await pause(150);
      assert.deepEqual(rejections, [], "a failed backup delete must not become an unhandled rejection");
      assert(existsSync(backupPath9), "a backup that cannot be deleted must stay in place");
      console.log("  OK a failed backup delete is swallowed, not an unhandled rejection");
      checks++;
    } finally {
      chmodSync(home9, previousMode9);
      process.removeListener("unhandledRejection", onRejection);
    }
    await pause(20);
    if (typeof dispose9 === "function") dispose9();
  } finally {
    rmSync(home9, { recursive: true, force: true });
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("image budget: " + checks + " checks passed");
