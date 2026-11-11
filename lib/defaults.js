import { readEndpoint } from "../vendor/dsh-plugin-model-request-accelerator/lib/compress.js";

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
