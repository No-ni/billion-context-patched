import { copyFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import bundledYaml from "../vendor/yaml/dist/index.js";
import { compressionDefaultOps, compressionPolicyDefaultOps } from "./defaults.js";
import { profileRootOf } from "./merge.js";

const WRAPPER = "bili-context-patch";
const UPSTREAM = ["billion-context", "dsh-plugin-model-request-accelerator"];
const IDS = ["bili-native", "bili-compaction-gate", "model-request-accelerator"];

/** Move legacy settings, preserving the wrapper's explicit keys, YAML tags and comments. */
export function rewriteUpstreamPatch(text, yaml = bundledYaml, { channels = [] } = {}) {
  const { isAlias, isMap, isSeq, parseDocument, visit } = yaml;
  const document = parseDocument(text, { merge: true, customTags: [{
    tag: "tag:yaml.org,2002:js", resolve: (value) => value,
  }] });
  if (document.errors.length) throw document.errors[0];
  if (document.contents === null) document.contents = document.createNode([]);
  if (!isSeq(document.contents)) throw new TypeError("profile patch must be a YAML sequence");
  const rows = document.contents.items;
  const ordinary = (row) => isMap(row) && !row.has("insert");
  const legacy = rows.filter((row) => ordinary(row) && row.get("id") === "model-request-accelerator" && row.has("config"));
  const stateFields = ["disabled", "inject", "intercept", "isolate"];
  const legacyState = rows.filter((row) => ordinary(row) && row.get("id") === "model-request-accelerator" &&
    !row.has("config") && row.items.some((pair) => stateFields.includes(String(pair.key.value))) &&
    row.items.every((pair) => ["id", ...stateFields].includes(String(pair.key.value))) &&
    row.get("disabled", true)?.tag !== "tag:yaml.org,2002:js");
  const migratable = rows.filter((row) => legacy.includes(row) || legacyState.includes(row));
  const follows = rows.filter((row) => ordinary(row) && IDS.includes(row.get("id")) &&
    row.items.every((pair) => ["id", "disabled"].includes(String(pair.key.value))) &&
    row.get("disabled", true)?.tag === "tag:yaml.org,2002:js" &&
    String(row.get("disabled") ?? "").includes(WRAPPER));
  if (migratable.length === 0 && follows.length === 0 && channels.length === 0) return { text, migrated: 0, defaulted: 0 };
  document.toJS({ maxAliasCount: 100 });

  const clone = (node, ancestors = new Set()) => {
    if (node === null || node === undefined) return node;
    if (typeof node.clone !== "function") return document.createNode(node);
    if (ancestors.has(node)) throw new TypeError("cannot migrate a cyclic YAML alias");
    const next = new Set(ancestors).add(node);
    if (isAlias(node)) {
      const source = node.resolve(document);
      if (source === undefined) throw new TypeError("cannot migrate an unresolved YAML alias");
      return clone(source, next);
    }
    const result = node.clone();
    delete result.anchor;
    if (isMap(result)) result.items = node.items.map((pair) => {
      const copied = pair.clone();
      copied.key = clone(pair.key, next);
      copied.value = clone(pair.value, next);
      return copied;
    });
    else if (isSeq(result)) result.items = node.items.map((item) => clone(item, next));
    return result;
  };
  const dereference = (node) => {
    const seen = new Set();
    while (isAlias(node)) {
      if (seen.has(node)) throw new TypeError("cannot migrate a cyclic YAML alias");
      seen.add(node);
      node = node.resolve(document);
    }
    return node;
  };
  // A YAML << merge is authored configuration too. Explicit keys win and the
  // first map in a merge sequence wins, matching the host's js-yaml semantics.
  const fields = (node, ancestors = new Set()) => {
    node = dereference(node);
    if (!isMap(node)) return new Map();
    if (ancestors.has(node)) throw new TypeError("cannot migrate a cyclic YAML merge");
    const next = new Set(ancestors).add(node);
    const values = new Map();
    const keyOf = (pair) => pair.key !== null && typeof pair.key === "object" && "value" in pair.key ? pair.key.value : pair.key;
    for (const pair of node.items) {
      const key = keyOf(pair);
      if (typeof key !== "symbol" || key.description !== "<<") continue;
      const source = dereference(pair.value);
      for (const item of isSeq(source) ? source.items : [source]) {
        for (const [key, value] of fields(item, next)) if (!values.has(key)) values.set(key, value);
      }
    }
    for (const pair of node.items) {
      const key = keyOf(pair);
      if (typeof key === "symbol") continue;
      values.set(key, pair.value);
    }
    return values;
  };
  const fill = (target, source) => {
    source = dereference(source);
    if (!isMap(target) || !isMap(source)) return false;
    let changed = false;
    const present = fields(target);
    for (const [key, value] of fields(source)) {
      if (!present.has(key)) {
        target.set(key, clone(value));
        changed = true;
      } else {
        const candidate = clone(present.get(key));
        if (fill(candidate, value)) {
          target.set(key, candidate);
          changed = true;
        }
      }
    }
    return changed;
  };
  const detachAliases = (roots) => {
    const anchors = new Set();
    for (const root of roots) if (root) visit(root, { Node(_key, node) { if (node.anchor) anchors.add(node); } });
    visit(document, { Alias(_key, node) { if (anchors.has(node.resolve(document))) return clone(node); } });
  };
  const comments = (root) => {
    const values = new Set();
    visit(root, { Node(_key, node) {
      if (node.commentBefore) values.add(node.commentBefore);
      if (node.comment) values.add(node.comment);
    } });
    return values;
  };
  const beforeComments = comments(document);

  if (migratable.length > 0) {
    const wrappers = rows.filter((row) => ordinary(row) && row.get("id") === WRAPPER);
    const target = wrappers.findLast((row) => row.has("config")) ?? wrappers.at(-1) ?? document.createNode({ id: WRAPPER, name: WRAPPER });
    if (wrappers.length === 0) document.add(target);
    const source = legacy.at(-1);
    if (source && !target.has("config")) target.set("config", clone(source.get("config", true)));
    else if (source) {
      const previous = target.get("config", true);
      const candidate = clone(previous);
      if (fill(candidate, source.get("config", true))) {
        detachAliases([previous]);
        target.set("config", candidate);
      }
    }
    for (const field of stateFields) {
      // A later authored condition still wins over an earlier boolean state.
      // Keep the user's original condition row, and carry its effective value
      // to the replacement without copying an obsolete wrapper-follow rule.
      const latest = rows.findLast((row) => ordinary(row) && row.get("id") === "model-request-accelerator" &&
        row.has(field) && !follows.includes(row));
      if (!wrappers.some((row) => row.has(field)) && latest) target.set(field, clone(latest.get(field, true)));
    }
  }
  const dropped = new Set([...migratable, ...follows]);
  // Aliases elsewhere may refer to any removed row's anchor, including an old
  // follow expression. Keep its value without leaving a dangling alias.
  detachAliases([...dropped]);
  document.contents.items = document.contents.items.filter((row) => !dropped.has(row));
  let defaulted = 0;
  if (channels.length) {
    const wrappers = document.contents.items.filter((row) => ordinary(row) && row.get("id") === WRAPPER);
    const target = wrappers.findLast((row) => row.has("config")) ?? wrappers.at(-1) ?? document.createNode({ id: WRAPPER, name: WRAPPER });
    const previous = target.get("config", true);
    const candidate = previous === undefined ? document.createNode({}) : clone(previous);
    const ops = compressionPolicyDefaultOps(candidate?.toJS(document), channels);
    for (const op of ops) {
      let providers = candidate.get("providers", true);
      if (!isMap(providers)) {
        providers = clone(fields(candidate).get("providers")) ?? document.createNode({});
        candidate.set("providers", providers);
      }
      const provider = op.path[1];
      let policy = providers.get(provider, true);
      if (!isMap(policy)) {
        policy = clone(fields(providers).get(provider)) ?? document.createNode({});
        providers.set(provider, policy);
      }
      policy.set(op.path[2], op.value);
    }
    defaulted = ops.length;
    if (defaulted) {
      detachAliases([previous]);
      target.set("config", candidate);
      if (wrappers.length === 0) document.add(target);
    }
  }
  if (migratable.length === 0 && follows.length === 0 && defaulted === 0) return { text, migrated: 0, defaulted: 0 };
  const retained = comments(document);
  const relocated = [...beforeComments].filter((comment) => !retained.has(comment));
  if (relocated.length) document.commentBefore = [document.commentBefore, ...relocated].filter(Boolean).join("\n");
  document.contents.flow = false;
  document.toJS({ maxAliasCount: 100 });
  return { text: String(document), migrated: migratable.length, defaulted };
}

/** Offline install discovery; runtime uses the authoritative live LLM directory. */
export function relayChannelsFromProfile(texts, yaml = bundledYaml) {
  const entries = new Map();
  const read = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      if (Array.isArray(row.insert)) read(row.insert);
      if (row.group) read(row.config);
      if (typeof row.id === "string" && Object.hasOwn(row, "config")) entries.set(row.id, row.config);
    }
  };
  for (const text of texts) {
    if (!text?.trim()) continue;
    const document = yaml.parseDocument(text, { merge: true, customTags: [{
      tag: "tag:yaml.org,2002:js", resolve: (value) => ({ __jsExpr: value }),
    }] });
    if (document.errors.length) throw document.errors[0];
    read(document.toJS({ maxAliasCount: 100 }));
  }
  const rows = [...entries].map(([ns, value]) => ({ ns, value }));
  const directory = rows.flatMap(({ ns, value }) => Object.keys(value?.providers ?? {}).map((provider) => ({
    provider, settingsNs: ns, settingsPath: ["providers", provider],
  })));
  return [...new Set(compressionDefaultOps({}, directory, rows).map((op) => op.path[1]))];
}

/** Own backups only; never prune backups created by a user or another tool. */
async function backup(root, basename) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const filename = basename + ".bak-bili-context-patch-" + stamp;
  await copyFile(join(root, basename), join(root, filename));
}
async function prune(root, basename) {
  const prefix = basename + ".bak-bili-context-patch-";
  const names = (await readdir(root)).filter((name) => name.startsWith(prefix) && /^\d{17}$/.test(name.slice(prefix.length))).sort();
  for (const name of names.slice(0, Math.max(0, names.length - 3))) await rm(join(root, name), { force: true });
}

/** Use the host's writer lock, including against concurrent plugin-manager installs. */
export async function mergeInstalledProfile({ profileRoot, packageRoot, yaml = bundledYaml, withFileLock, writeFileAtomic, isActive = () => true, signal }) {
  const root = profileRoot ?? await profileRootOf(packageRoot);
  if (root === null || root === undefined) return { changed: false, removed: 0, migrated: 0 };
  return withFileLock(join(root, "package.json"), async () => {
    if (!isActive()) return { changed: false, removed: 0, migrated: 0 };
    const path = join(root, "package.json");
    const before = await readFile(path, "utf8");
    const manifest = JSON.parse(before);
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes(WRAPPER) || !isActive()) return { changed: false, removed: 0, migrated: 0 };
    const kept = bundles.filter((name) => !UPSTREAM.includes(name));
    const removed = bundles.length - kept.length;
    const patchPath = join(root, "cordis.patch.yml");
    let patch;
    try { patch = await readFile(patchPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const nextPatch = patch === undefined ? { text: undefined, migrated: 0 } : rewriteUpstreamPatch(patch, yaml);
    const patchChanged = nextPatch.text !== patch;
    if (removed === 0 && !patchChanged) return { changed: false, removed: 0, migrated: 0 };
    if (patchChanged) await backup(root, "cordis.patch.yml");
    if (removed > 0) await backup(root, "package.json");
    if (!isActive()) return { changed: false, removed: 0, migrated: 0 };
    let wrotePatch = false;
    try {
      if (patchChanged) {
        await writeFileAtomic(patchPath, nextPatch.text, { mode: 0o600 });
        wrotePatch = true;
      }
      if (removed > 0) {
        manifest.dsh.profile.bundles = kept;
        await writeFileAtomic(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      }
    } catch (error) {
      if (wrotePatch) await writeFileAtomic(patchPath, patch, { mode: 0o600 });
      throw error;
    }
    if (patchChanged) await prune(root, "cordis.patch.yml").catch((error) => console.warn("bili-context-patch: could not prune patch backups: " + error.message));
    if (removed > 0) await prune(root, "package.json").catch((error) => console.warn("bili-context-patch: could not prune manifest backups: " + error.message));
    return { changed: true, removed, migrated: nextPatch.migrated };
  }, { waitMs: 10000, signal });
}

/** Run after mount, outside apply's lifecycle and the manager's enable lock. */
export function installProfileMerge(ctx, packageRoot, startup) {
  let resolve;
  const ready = new Promise((done) => { resolve = done; });
  ctx.effect(() => () => resolve(false));
  ctx.inject(["profileContext"], (scope) => {
    let closed = false;
    let running = false;
    let queued = false;
    let allowed = false;
    let timer;
    let retryMs = 1000;
    let previousError;
    let needsReconcile = false;
    const migrated = { removed: 0, rows: 0 };
    const abort = new AbortController();
    const active = () => !closed && startup.isActive() && scope.fiber?.uid !== null && scope.fiber?.state !== 5;
    scope.effect(() => () => {
      closed = true;
      clearTimeout(timer);
      abort.abort();
    });
    const flush = async () => {
      if (running || !allowed || !active()) return;
      running = true;
      try {
        while (queued && active()) {
          queued = false;
          await scope.get("loader")?.await?.();
          if (!active()) break;
          const io = await import("@deepseek-ai/dsh-atomic-write");
          if (!active()) break;
          const hmr = scope.get("hmr");
          const transaction = async () => {
            if (!active()) return;
            const profile = scope.get("profileContext");
            const result = await mergeInstalledProfile({
              profileRoot: profile.dir, packageRoot, ...io, isActive: active, signal: abort.signal,
            });
            if (!active()) return;
            needsReconcile ||= result.changed;
            migrated.removed += result.removed;
            migrated.rows += result.migrated;
            if (needsReconcile) {
              // HMR requires its exclusive transaction; config-editor and the
              // plugin manager take the same queue before the profile writer lock.
              if (hmr?.reconcileProfile) {
                const outcome = await hmr.reconcileProfile();
                if (outcome?.restartReason === "package-moved") throw new Error("profile migration saved; DSH requires a restart to apply package-moved");
              } else {
                const boot = await import("@deepseek-ai/dsh-app-boot");
                await boot.reconcileProfilePatches(scope.root, boot.readProfilePatches("dsh", profile), "dsh");
              }
              needsReconcile = false;
              if (active()) scope.emit("plugin-manager/changed", { reason: "bundle" });
              console.warn("bili-context-patch: retired " + migrated.removed + " standalone bundle(s), migrated " + migrated.rows + " settings row(s)");
              migrated.removed = migrated.rows = 0;
            }
          };
          if (hmr?.runExclusive) {
            // apply() may inherit the manager's AsyncLocalStorage transaction.
            // Leave that inherited marker to ENQUEUE fresh work after the enable
            // operation; reconcileProfile still runs inside runExclusive itself.
            const enqueue = () => hmr.runExclusive(transaction);
            await (hmr.executing?.exit ? hmr.executing.exit(enqueue) : enqueue());
          } else {
            await transaction();
          }
          if (active()) {
            previousError = undefined;
            retryMs = 1000;
            resolve(true);
          }
        }
      } catch (error) {
        if (!active()) return;
        if (previousError !== error.message) console.warn("bili-context-patch: could not merge the profile: " + error.message);
        previousError = error.message;
        timer = setTimeout(schedule, retryMs);
        retryMs = Math.min(retryMs * 2, 30000);
      } finally {
        running = false;
      }
    };
    const schedule = () => {
      if (!active()) return;
      clearTimeout(timer);
      queued = true;
      queueMicrotask(() => void flush());
    };
    scope.on("plugin-manager/changed", schedule);
    scope.on("app-boot/config-reload", schedule);
    void startup.ready.then((mounted) => {
      if (!mounted) return resolve(false);
      if (!active()) return;
      allowed = true;
      schedule();
    });
  });
  return ready;
}
