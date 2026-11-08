/**
 * Host half of the merged install unit.
 *
 * One Loader entry (this package) mounts three plugins as child fibers:
 * billion-context's native host plugin, its compaction gate, and the request
 * accelerator. Nothing of either package is copied: the loader resolves them
 * from the profile's node_modules, so upgrading either one only means running
 * scripts/install.mjs again.
 *
 * Two things keep the standalone copies of those packages quiet, and both live
 * inside this package rather than in the user's configuration:
 *
 * 1. The bundle layer this package ships writes `disabled: true` rows for the two
 *    upstream entries (the gate included), so on a normal install they are never
 *    mounted. The rows travel with the layer: switch this package off, or remove
 *    it, and the layer stops being applied, so the other two start again by
 *    themselves. Nothing on disk stays switched off behind the user's back.
 *
 * 2. A row can only land on an entry that already exists, and an entry exists
 *    only when its package sits earlier in dsh.profile.bundles. That is the
 *    normal install order but not the only one — installing this package first
 *    and an upstream one afterwards would leave both running. So before mounting
 *    anything, apply() walks the built tree and switches off whatever upstream
 *    entry is still on. It has to happen first: the children claim the same
 *    services and HTTP routes, and a route left owned by an entry that is about
 *    to disappear takes the endpoint with it (verified — the version endpoint
 *    404s when the switch-off runs after the mounts).
 *
 * Two details carry the settings page over:
 *
 * 1. The settings service keys a namespace by the PROFILE ENTRY ID, and it only
 *    projects an entry that declares a Config schema. This module therefore
 *    re-exports the accelerator's schema, so the entry owns the namespace the
 *    page reads and writes.
 *
 * 2. The config this entry receives is not plain data: every `.volatile()` field
 *    arrives as a live accessor the settings service keeps up to date in place.
 *    The accelerator reads those accessors itself, so the child is mounted with
 *    `Config: undefined` — Cordis passes a config through untouched when the
 *    runtime declares no schema — instead of letting a second parse freeze the
 *    accessors into a snapshot. That is what keeps a provider toggle effective
 *    without a restart.
 */
import * as bili from "billion-context";
import * as compactionGate from "billion-context/dsh-compaction-gate";
import * as accelerator from "dsh-plugin-model-request-accelerator";

export const name = "bili-context-patch";

/** Services any child declares are declared by the child; the wrapper needs none. */
export const inject = [];

/** The accelerator's schema, so this entry owns the settings namespace. */
export const Config = accelerator.Config;

/** The accelerator, minus its schema: config has to reach it unparsed. */
const acceleratorWithoutSchema = { ...accelerator, Config: undefined };

/** Entries the merged unit replaces: billion-context's two, and the accelerator. */
const UPSTREAM_IDS = ["bili-native", "bili-compaction-gate", "model-request-accelerator"];

/** The loader's entry map, or null when it cannot be reached from here. */
const entryStore = (ctx) => {
  try {
    return ctx.get("loader")?.store?.include?.subtree?.store ?? null;
  } catch {
    return null;
  }
};

export function apply(ctx, config) {
  // Before mounting: a leftover entry still owns the services and routes these
  // children are about to register.
  const store = entryStore(ctx);
  if (store !== null) {
    for (const id of UPSTREAM_IDS) {
      const entry = store[id];
      if (entry === undefined || entry.disabled) continue;
      try {
        entry.update({ ...entry.options, disabled: true });
      } catch (error) {
        console.warn("bili-context-patch: " + id + " is still running: " + (error && error.message));
      }
    }
  }

  ctx.plugin(bili);
  ctx.plugin(compactionGate);
  ctx.plugin(acceleratorWithoutSchema, config ?? {});
}
