/**
 * Host half of the merged install unit.
 *
 * One Loader entry (this package) mounts three plugins as child fibers:
 * billion-context's native host plugin, its compaction gate, and the request
 * accelerator. Nothing of either package is copied: the loader resolves them
 * from the profile's node_modules, so upgrading either one only means running
 * scripts/install.mjs again.
 *
 * Deliberately absent: any disabling of the standalone rows. Two attempts to
 * switch them off — a `disabled: true` row in the profile patch, then a runtime
 * `loader.update` after mounting — both turned out to be worse than useless:
 * the patch version left the old plugins down even when this package failed to
 * load, and the runtime version cannot remove a card anyway (the plugin list and
 * the client module graph are built from `dsh.profile.bundles`, not from live
 * entries). The rows are simply not listed, which is what "merged" means here,
 * and nothing on disk stays disabled — re-adding the originals from the plugin
 * page works immediately if this package ever breaks.
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

export function apply(ctx, config) {
  ctx.plugin(bili);
  ctx.plugin(compactionGate);
  ctx.plugin(acceleratorWithoutSchema, config ?? {});
}
