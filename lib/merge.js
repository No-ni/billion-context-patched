/**
 * Keeping the standalone copies of the merged packages quiet.
 *
 * A package manager install (Settings > Plugins) resolves this package from the
 * repository. It never runs scripts/install.mjs, so the replaced packages stay
 * in dsh.profile.bundles and the loader composes their entries beside the child
 * fibers this package mounts. The bundle can disable originals composed earlier.
 * Initial boot constructs entries concurrently, so originals on either side may
 * already be importing by the time apply() installs the guard. startup.js awaits
 * their init and disposal BEFORE mounting children. The synchronous guard stops
 * entries added later and is released with its owning scope.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Entry guards are shared, but every wrapper owns and releases its own rule. */
const guarded = new WeakMap();

/**
 * Force `disabled` into the first update of a replaced entry.
 *
 * `entry.update(options, true)` runs right after the constructor announces the
 * entry, so a synchronous replacement is in place for that call. The fiber is
 * never created, and an entry that never starts cannot register a second copy
 * of the routes and services the wrapper's children own.
 */
export const guardEntry = (entry, upstreamIds, isActive = () => true) => {
  if (entry === null || typeof entry !== "object" || typeof entry.update !== "function") return () => {};
  let state = guarded.get(entry);
  if (state === undefined) {
    state = { original: entry.update, rules: new Set() };
    state.update = function (options, ...rest) {
      const id = options?.id ?? this.options?.id;
      if ([...state.rules].some((rule) => rule.isActive() && rule.ids.includes(id))) {
        options = { ...options, disabled: true };
      }
      return state.original.call(this, options, ...rest);
    };
    guarded.set(entry, state);
    entry.update = state.update;
  }
  const rule = { ids: upstreamIds, isActive };
  state.rules.add(rule);
  return () => {
    state.rules.delete(rule);
    if (state.rules.size !== 0) return;
    if (entry.update === state.update) entry.update = state.original;
    guarded.delete(entry);
  };
};

/**
 * Switch one entry off when it is one of the packages this one replaces.
 *
 * `update` only touches the entries in memory: it disposes the fiber, and the
 * loader writes to disk from the tree changes it makes itself, so nothing here
 * reaches the user's profile files. A startup barrier uses strict mode so it
 * cannot mount children while an original failed to stop.
 *
 * An entry whose first update already ran keeps its init in flight; disabling
 * it now cannot stop that mount, so wait it out and dispose the fiber, which
 * releases every route before the wrapper mounts its own children.
 */
export const suppressEntry = async (entry, upstreamIds, { strict = false, isActive = () => true } = {}) => {
  try {
    if (!isActive()) return false;
    const id = entry?.options?.id;
    if (typeof id !== "string" || !upstreamIds.includes(id)) return false;
    // Capture before update: an import may finish and clear _initTask while the
    // existing fiber's disposal is awaited. Disabling does not cancel _init().
    const pending = entry._initTask;
    if (!entry.disabled) {
      console.warn("bili-context-patch: switching off the standalone " + id + " entry");
      await entry.update({ ...entry.options, disabled: true });
    }
    if (pending) await pending.catch(() => {});
    if (!isActive() && !entry.disabled) return false;
    if (entry.fiber) await entry.fiber.dispose();
    return true;
  } catch (error) {
    console.warn("bili-context-patch: could not switch off an upstream entry: " + (error && error.message));
    if (strict) throw error;
    return false;
  }
};

/** The profile directory that owns this install, found by its package manifest. */
export const profileRootOf = async (packageRoot) => {
  let dir = packageRoot;
  for (let depth = 0; depth < 6; depth += 1) {
    dir = dirname(dir);
    try {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (manifest !== null && typeof manifest === "object" && manifest.dsh?.profile) return dir;
    } catch {
      // No manifest here (node_modules, plugins): keep walking up.
    }
  }
  return null;
};
