import { readEndpoint } from "../vendor/dsh-plugin-model-request-accelerator/lib/compress.js";
import { watchFile, unwatchFile } from "node:fs";

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
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const expression = value => record(value) && Object.hasOwn(value, "__jsExpr");

export function imageBudgetOps(config, row, route) {
  if (!record(config) || expression(config) || !record(row) || !record(route) ||
      !IMAGE_BUDGET_PROVIDERS.has(route.provider) || route.settingsNs !== row.ns ||
      !Array.isArray(route.settingsPath) || route.settingsPath.length !== 0) return [];
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

/** Persist the native DeepSeek budget, so disabling this wrapper doesn't undo it. */
export function installImageBudgetDefaults(ctx, { ready, configPath, readConfig }) {
  ctx.inject(["settings", "llm"], (scope) => {
    let closed = false, active = false, running = false, queued = false;
    let path, lastError;
    const schedule = () => {
      queued = true;
      if (!closed && active && !running) {
        running = true;
        queueMicrotask(flush);
      }
    };
    async function flush() {
      let conflicts = 0;
      try {
        while (queued && !closed) {
          queued = false;
          const config = readConfig(path);
          const settings = scope.get("settings");
          const routes = scope.get("llm").listConfigurableProviders();
          const rows = settings.describe();
          for (const route of routes) {
            const row = rows.find(candidate => candidate.ns === route.settingsNs);
            if (!row) continue;
            const ops = imageBudgetOps(config, row, route);
            if (ops.length === 0 || closed) continue;
            try {
              await settings.mutate(row.ns, ops, row.revision);
            } catch (error) {
              if (error?.code !== "SETTINGS_CONFLICT" || ++conflicts > 3) throw error;
              queued = true;
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
    scope.effect(() => () => {
      closed = true;
      if (active) unwatchFile(path, schedule);
    });
    scope.on("settings/document-updated", schedule);
    scope.on("llm/adapters-updated", schedule);
    void ready.then(available => {
      if (closed || available === false) return;
      path = configPath();
      watchFile(path, { persistent: false, interval: 750 }, schedule);
      active = true;
      schedule();
    }).catch(error => {
      if (!closed) console.warn("bili-context-patch: could not watch image configuration: " + error.message);
    });
  });
}
