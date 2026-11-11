/**
 * Keeping the standalone copies of the merged packages quiet.
 *
 * A package manager install (Settings > Plugins) resolves this package from the
 * repository. It never runs scripts/install.mjs, so the replaced packages stay
 * in dsh.profile.bundles and the loader composes their entries beside the child
 * fibers this package mounts. Two layers stop them, because neither order of
 * `dsh.profile.bundles` is under this package's control:
 *
 * 1. The bundle layer carries a `disabled:` row per replaced entry. Rows land
 *    while the layers are composed, which covers an upstream listed BEFORE this
 *    package: its entry is built switched off.
 * 2. `loader/entry-init` fires from an Entry's constructor, before the loader
 *    awaits its first `update`. Replacing that method forces `disabled` into
 *    the first update, which covers an upstream listed AFTER this package.
 *
 * A disable that arrives once `import()` is already under way cannot stop the
 * mount: the duplicate route error is thrown during apply, before anything gets
 * a chance to dispose the fiber. Waiting the mount out only takes the routes
 * away afterwards, so it is a fallback, not the mechanism.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Entries whose first update has already been intercepted. */
const guarded = new WeakSet();

/**
 * Force `disabled` into the first update of a replaced entry.
 *
 * `entry.update(options, true)` runs right after the constructor announces the
 * entry, so a synchronous replacement is in place for that call. The fiber is
 * never created, and an entry that never starts cannot register a second copy
 * of the routes and services the wrapper's children own.
 */
export const guardEntry = (entry, upstreamIds) => {
  if (entry === null || typeof entry !== "object" || guarded.has(entry)) return;
  guarded.add(entry);
  const update = entry.update;
  entry.update = function (options, ...rest) {
    try {
      const id = options?.id ?? this.options?.id;
      if (typeof id === "string" && upstreamIds.includes(id)) {
        if (!this.disabled) console.warn("bili-context-patch: keeping the standalone " + id + " entry off");
        options = { ...options, disabled: true };
      }
    } catch {
      // A malformed options object is the loader's problem, not a boot failure.
    }
    return update.call(this, options, ...rest);
  };
};

/**
 * Switch one entry off when it is one of the packages this one replaces.
 *
 * `update` only touches the entries in memory: it disposes the fiber, and the
 * loader writes to disk from the tree changes it makes itself, so nothing here
 * reaches the user's profile files. Never throws — a failed switch-off is worth
 * a line in the log, not a broken startup.
 *
 * An entry whose first update already ran keeps its init in flight; disabling
 * it now cannot stop that mount, so wait it out and dispose the fiber, which at
 * least takes the duplicate routes away afterwards.
 */
export const suppressEntry = async (entry, upstreamIds) => {
  try {
    guardEntry(entry, upstreamIds);
    const id = entry?.options?.id;
    if (typeof id !== "string" || !upstreamIds.includes(id)) return;
    if (!entry.disabled) {
      console.warn("bili-context-patch: switching off the standalone " + id + " entry");
      await entry.update({ ...entry.options, disabled: true });
    }
    const pending = entry._initTask;
    if (pending) await pending.catch(() => {});
    if (entry.fiber) await entry.fiber.dispose();
  } catch (error) {
    console.warn("bili-context-patch: could not switch off an upstream entry: " + (error && error.message));
  }
};

/** The profile directory that owns this install, found by its package manifest. */
const profileRootOf = async (packageRoot) => {
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

/**
 * Drop the replaced packages from `dsh.profile.bundles` on disk.
 *
 * scripts/install.mjs does this as part of an install; a package manager
 * install resolves this package from the repository and never runs it, so the
 * standalone entries stay composed on every boot and only the disable rows keep
 * them from mounting. Doing the other half here makes the next start compose
 * exactly the one card this package promises. The packages stay installed, so
 * the plugin page still lists them — switched off.
 *
 * Idempotent: once the rows are gone the file reads back unchanged.
 *
 * @returns the number of rows removed.
 */
export const retireUpstreamBundles = async ({ packageRoot, upstreamBundles, warn = console.warn }) => {
  try {
    const root = await profileRootOf(packageRoot);
    if (root === null) return 0;
    const path = join(root, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return 0;
    const kept = bundles.filter((name) => !upstreamBundles.includes(name));
    if (kept.length === bundles.length) return 0;
    manifest.dsh.profile.bundles = kept;
    const temporary = path + ".bili-context-patch.tmp";
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await rename(temporary, path);
    warn(
      "bili-context-patch: removed " + (bundles.length - kept.length) +
      " standalone bundle row(s) from " + path + " (the packages stay installed and off)",
    );
    return bundles.length - kept.length;
  } catch (error) {
    warn("bili-context-patch: could not merge the profile bundles: " + (error && error.message));
    return 0;
  }
};
