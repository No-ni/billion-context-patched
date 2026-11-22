import { readEndpoint } from "../vendor/dsh-plugin-model-request-accelerator/lib/compress.js";
import { existsSync, readFileSync, renameSync, unlinkSync, watchFile, unwatchFile, writeFileSync } from "node:fs";

const HOSTS = new Set(["www.didudidu.asia", "154.219.111.56"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Missing authored keys only; explicit false/gzip and expressions stay intact. */
export function compressionPolicyDefaultOps(raw, providers) {
  if (!record(raw) || Object.hasOwn(raw, "__jsExpr")) return [];
  const policies = raw.providers;
  if (policies !== undefined && (!record(policies) || Object.hasOwn(policies, "__jsExpr"))) return [];
  const ops = [];
  for (const provider of new Set(providers)) {
    const policy = Object.hasOwn(policies ?? {}, provider) ? policies[provider] : undefined;
    if (policy !== undefined && (!record(policy) || Object.hasOwn(policy, "__jsExpr"))) continue;
    for (const [key, value] of [["enabled", true], ["encoding", raw.encoding === "gzip" ? "gzip" : "auto"]]) {
      if (key === "encoding" && Object.hasOwn(raw, "encoding") && !["auto", "gzip"].includes(raw.encoding)) continue;
      if (!Object.hasOwn(policy ?? {}, key)) ops.push({ op: "set", path: ["providers", provider, key], value });
    }
  }
  return ops;
}

/** Schema defaults in descriptor.value are not user choices. */
export function compressionDefaultOps(raw, directory, rows) {
  const values = new Map(rows.map((row) => [row.ns, row.value]));
  const providers = [];
  for (const provider of directory) {
    if (typeof provider.provider !== "string") continue;
    const endpoint = readEndpoint(values.get(provider.settingsNs), provider.settingsPath);
    let host;
    try { host = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, ""); } catch { continue; }
    if (!HOSTS.has(host)) continue;
    providers.push(provider.provider);
  }
  return compressionPolicyDefaultOps(raw, providers);
}

/** Follow service readiness and directory/config changes; serialize writes and retry fresh revisions. */
export function installCompressionDefaults(ctx, { namespace, ready = Promise.resolve() }) {
  ctx.inject(["settings", "llm", "configEditor"], (scope) => {
    let closed = false;
    let running = false;
    let queued = false;
    let scheduled = false;
    let allowed = false;
    scope.effect(() => () => { closed = true; });
    const flush = async () => {
      scheduled = false;
      if (closed || running || !allowed) return;
      running = true;
      let conflicts = 0;
      try {
        while (queued && !closed) {
          queued = false;
          const settings = scope.get("settings");
          const rows = settings.describe();
          const own = rows.find((row) => row.ns === namespace);
          if (own === undefined) continue;
          const entry = scope.get("configEditor").entries().find((entry) => entry.options.id === namespace);
          const raw = entry === undefined ? own.user ?? {} : Object.hasOwn(entry.options, "config") ? entry.options.config : {};
          const directory = scope.get("llm").listConfigurableProviders();
          const ops = compressionDefaultOps(raw, directory, rows);
          if (ops.length === 0 || closed) continue;
          try {
            await settings.mutate(own.ns, ops, own.revision);
            conflicts = 0;
            console.warn("bili-context-patch: filled " + ops.length + " missing compression setting(s)");
          } catch (error) {
            if (error?.code === "SETTINGS_CONFLICT" && ++conflicts <= 3) {
              queued = true;
              continue;
            }
            console.warn("bili-context-patch: could not apply compression defaults: " + error.message);
            queued = false;
          }
        }
      } catch (error) {
        console.warn("bili-context-patch: could not read compression settings: " + error.message);
      } finally {
        running = false;
      }
    };
    const schedule = () => {
      if (closed) return;
      queued = true;
      if (scheduled || running || !allowed) return;
      scheduled = true;
      queueMicrotask(() => void flush());
    };
    scope.on("settings/document-updated", schedule);
    scope.on("llm/adapters-updated", schedule);
    scope.on("app-boot/config-reload", schedule);
    void ready.then((available) => {
      if (closed || available === false) return;
      allowed = true;
      schedule();
    });
  });
}

const CONFIG_MAX_IMAGES = "maxRequestImages";
const HOST_MAX_IMAGES = "maxImagesPerRequest";
const OFFLOAD_QUANTUM = "imageOffloadCountQuantum";
const IMAGE_BUDGET_PROVIDERS = new Set(["deepseek-official", "deepseek-account"]);
const PI_IMAGE_BUDGET_NAMESPACE = "llm-pi-ai";
const PI_IMAGE_MAX_BYTES = "requestImageMaxBytes";
const PI_IMAGE_PIXEL_BUDGET = "requestImagePixelBudget";
const PI_MAX_REQUEST_BYTES = "maxRequestImageBytes";
const PI_IMAGE_DEFAULTS = Object.freeze({
  [PI_IMAGE_MAX_BYTES]: 150 * 1024,
  [PI_IMAGE_PIXEL_BUDGET]: 1_440_000,
  [PI_MAX_REQUEST_BYTES]: 2 * 1024 * 1024,
});
const PI_IMAGE_KEYS = Object.keys(PI_IMAGE_DEFAULTS);
// A write can collide with any other writer of the same namespace; one route
// retries this many times from a fresh snapshot before the pass reports it.
const BUDGET_CONFLICT_RETRIES = 3;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const expression = value => record(value) && Object.hasOwn(value, "__jsExpr");

export function imageBudgetOps(config, row, route) {
  if (!record(config) || expression(config) || !record(row) || !record(route) || route.settingsNs !== row.ns ||
      !Array.isArray(route.settingsPath)) return [];
  if (route.settingsNs === PI_IMAGE_BUDGET_NAMESPACE) return piImageBudgetOps(config, row, route);
  if (!IMAGE_BUDGET_PROVIDERS.has(route.provider) || route.settingsPath.length !== 0) return [];
  const user = row.user ?? {};
  if (!record(user) || expression(user)) return [];
  const custom = Object.hasOwn(config, CONFIG_MAX_IMAGES) || Object.hasOwn(config, OFFLOAD_QUANTUM);
  if (expression(user[HOST_MAX_IMAGES]) || expression(user[OFFLOAD_QUANTUM])) return [];
  const authoredMax = Object.hasOwn(user, HOST_MAX_IMAGES) ? user[HOST_MAX_IMAGES] : undefined;
  const authoredQuantum = Object.hasOwn(user, OFFLOAD_QUANTUM) ? user[OFFLOAD_QUANTUM] : undefined;
  if ((authoredMax !== undefined && !positiveInt(authoredMax)) ||
      (authoredQuantum !== undefined && !positiveInt(authoredQuantum))) return [];
  const limit = custom
    ? config[CONFIG_MAX_IMAGES] ?? 20
    : authoredMax ?? Math.max(20, authoredQuantum ?? 1);
  const quantum = custom
    ? config[OFFLOAD_QUANTUM] ?? Math.min(10, limit)
    : authoredQuantum ?? Math.min(10, limit);
  if (!positiveInt(limit) || !positiveInt(quantum) || quantum > limit) return [];
  // Explicit plugin values win. Otherwise preserve any native setting the user
  // authored and fill only its missing counterpart with a compatible default.
  const current = record(row.value) ? row.value : {};
  const ops = [];
  for (const [key, value] of [[HOST_MAX_IMAGES, limit], [OFFLOAD_QUANTUM, quantum]]) {
    if (current[key] !== value) ops.push({ op: "set", path: [key], value });
  }
  return ops;
}

/** Fill the image projection limits on one llm-pi-ai provider profile. */
export function piImageBudgetOps(config, row, route) {
  if (route.settingsPath.length !== 2 || route.settingsPath[0] !== "providers" ||
      typeof route.settingsPath[1] !== "string" || !record(row.user) || expression(row.user)) return [];
  const explicit = {};
  for (const key of PI_IMAGE_KEYS) {
    if (Object.hasOwn(config, key)) {
      if (!positiveInt(config[key])) return [];
      explicit[key] = config[key];
    }
  }
  const providers = row.user.providers;
  if (providers !== undefined && (!record(providers) || expression(providers))) return [];
  const authored = providers?.[route.settingsPath[1]];
  // Only a profile the user stored is a provider profile to fill. DSH reports a
  // provider as configured once its profile exists, so filling every shipped
  // catalog route would present providers nobody configured as configured.
  if (authored === undefined) return [];
  if (!record(authored) || expression(authored)) return [];
  const values = record(row.value) && record(row.value.providers) ? row.value.providers : {};
  const current = values[route.settingsPath[1]];
  if (current !== undefined && (!record(current) || expression(current))) return [];
  const ops = [];
  for (const key of PI_IMAGE_KEYS) {
    const value = Object.hasOwn(explicit, key) ? explicit[key] : PI_IMAGE_DEFAULTS[key];
    if (!positiveInt(value)) return [];
    if (current?.[key] !== value) ops.push({ op: "set", path: [...route.settingsPath, key], value });
  }
  return ops;
}

const piImagePathKey = route => route.settingsNs + "\u0000" + route.settingsPath.join("\u0000");
const piImageProfile = (root, route) => route.settingsPath.reduce((value, key) => (
  record(value) && !Array.isArray(value) ? value[key] : undefined
), root);

function capturePiImageBudget(row, route, ops) {
  if (route.settingsNs !== PI_IMAGE_BUDGET_NAMESPACE || ops.length === 0) return undefined;
  const profile = piImageProfile(row.user, route);
  const fields = new Map();
  for (const op of ops) {
    const name = op.path.at(-1);
    if (fields.has(name)) continue;
    fields.set(name, {
      hadValue: Object.hasOwn(profile ?? {}, name),
      previous: profile?.[name],
      applied: op.value,
    });
  }
  return { ns: row.ns, path: route.settingsPath, fields };
}

function readPiImageBackups(path) {
  if (!path || !existsSync(path)) return new Map();
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value?.entries)) return new Map();
    return new Map(value.entries.map(entry => [entry.key, {
      ns: entry.ns, path: entry.path, fields: new Map(entry.fields.map(field => [field.name, field])),
    }]));
  } catch { return new Map(); }
}

// Bookkeeping only exists to undo this plugin's own writes. Once the user
// removes the profile there is nothing left to restore, and keeping the entry
// would resurrect a dead path in the backup file on every pass.
function prunePiImageBackups(applied, rows) {
  let changed = false;
  for (const [key, backup] of applied) {
    if (backup.ns !== PI_IMAGE_BUDGET_NAMESPACE) continue;
    if (!Array.isArray(backup.path) || backup.path.length !== 2 || backup.path[0] !== "providers") continue;
    const row = rows.find(candidate => candidate.ns === backup.ns);
    if (row === undefined) continue;
    const providers = record(row.user) ? row.user.providers : undefined;
    if (providers !== undefined && !record(providers)) continue;
    if (providers?.[backup.path[1]] === undefined) {
      applied.delete(key);
      changed = true;
    }
  }
  return changed;
}

function writePiImageBackups(path, backups) {
  if (!path) return;
  if (backups.size === 0) {
    try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return;
  }
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify({ version: 1, entries: [...backups].map(([key, entry]) => ({
    key, ns: entry.ns, path: entry.path, fields: [...entry.fields.values()],
  })) }) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

/** Persist the native DeepSeek budget, so disabling this wrapper doesn't undo it. */
export function installImageBudgetDefaults(ctx, { ready, configPath, readConfig }) {
  ctx.inject(["settings", "llm"], (scope) => {
    let closed = false, active = false, running = false, queued = false;
    let path, lastError;
    const applied = new Map();
    let backupPath;
    const schedule = () => {
      queued = true;
      if (!closed && active && !running) {
        running = true;
        queueMicrotask(flush);
      }
    };
    async function flush() {
      try {
        while (queued && !closed) {
          queued = false;
          const config = readConfig(path);
          const settings = scope.get("settings");
          const routes = scope.get("llm").listConfigurableProviders();
          // Every accepted write advances its namespace revision, so routes sharing
          // a namespace each need the snapshot read after the previous write.
          let rows = settings.describe();
          // A profile the user removed leaves a backup nothing can restore
          // into; drop it before this pass rewrites the file.
          if (prunePiImageBackups(applied, rows)) writePiImageBackups(backupPath, applied);
          for (const route of routes) {
            if (closed) break;
            let conflicts = 0;
            for (;;) {
              const row = rows.find(candidate => candidate.ns === route.settingsNs);
              if (!row) break;
              const ops = imageBudgetOps(config, row, route);
              if (ops.length === 0) break;
              const backup = capturePiImageBudget(row, route, ops);
              try {
                await settings.mutate(row.ns, ops, row.revision);
              } catch (error) {
                // Someone else owns this namespace right now: retry this route from
                // a snapshot taken after their write instead of dropping the pass.
                if (error?.code !== "SETTINGS_CONFLICT" || ++conflicts > BUDGET_CONFLICT_RETRIES) throw error;
                rows = settings.describe();
                continue;
              }
              if (backup) {
                const key = piImagePathKey(route);
                const previous = applied.get(key);
                if (previous) {
                  for (const [name, field] of backup.fields) {
                    if (!previous.fields.has(name)) previous.fields.set(name, field);
                    else previous.fields.get(name).applied = field.applied;
                  }
                } else {
                  applied.set(key, backup);
                }
                writePiImageBackups(backupPath, applied);
              }
              rows = settings.describe();
              break;
            }
          }
          lastError = undefined;
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        if (message !== lastError && !closed) console.warn("bili-context-patch: could not apply DeepSeek image budget: " + message);
        lastError = message;
        queued = false;
      } finally { running = false; }
    }
    async function restore() {
      if (applied.size === 0) return;
      // The host disposes the settings service before running this plugin's
      // teardown, so a shutdown can arrive with nothing left to write into.
      const settings = scope.get("settings");
      if (!settings) return;
      let failed = false;
      try {
        for (const [key, backup] of applied) {
          const row = settings.describe().find(candidate => candidate.ns === backup.ns);
          if (!row) { failed = true; continue; }
          const ops = [];
          const profile = piImageProfile(row.user, { settingsPath: backup.path });
          for (const [name, state] of backup.fields) {
            // Do not overwrite a value changed after this plugin wrote it.
            if (profile?.[name] !== state.applied) continue;
            ops.push(state.hadValue
              ? { op: "set", path: [...backup.path, name], value: state.previous }
              : { op: "unset", path: [...backup.path, name] });
          }
          if (ops.length === 0) continue;
          try {
            await settings.mutate(row.ns, ops, row.revision);
          } catch (error) {
            console.warn("bili-context-patch: could not restore PI image budget: " + error.message);
            failed = true;
          }
        }
      } catch (error) {
        failed = true;
        console.warn("bili-context-patch: could not restore PI image budget: " + (error?.message ?? error));
      }
      if (!failed) {
        applied.clear();
        writePiImageBackups(backupPath, applied);
      }
    }
    scope.effect(() => () => {
      closed = true;
      if (active) unwatchFile(path, schedule);
      return restore();
    });
    scope.on("settings/document-updated", schedule);
    scope.on("llm/adapters-updated", schedule);
    void ready.then(available => {
      if (closed || available === false) return;
      path = configPath();
      backupPath = path + ".image-budget-backup.json";
      for (const [key, value] of readPiImageBackups(backupPath)) applied.set(key, value);
      watchFile(path, { persistent: false, interval: 750 }, schedule);
      active = true;
      schedule();
    }).catch(error => {
      if (!closed) console.warn("bili-context-patch: could not watch image configuration: " + error.message);
    });
  });
}
