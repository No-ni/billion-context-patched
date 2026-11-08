/**
 * Host half of the merged install unit.
 *
 * One Loader entry (this package) mounts three plugins as child fibers:
 * billion-context's native host plugin, its compaction gate, and the request
 * accelerator. Nothing of either package is copied: the loader resolves them
 * from the profile's node_modules, so upgrading either one only means running
 * scripts/install.mjs again.
 *
 * The accelerator receives this entry's config, which is where the channel
 * switches live (the profile patch targets this id).
 */
import * as bili from "billion-context";
import * as compactionGate from "billion-context/dsh-compaction-gate";
import * as accelerator from "dsh-plugin-model-request-accelerator";

export const name = "bili-context-patch";

/** Services any child declares are declared by the child; the wrapper needs none. */
export const inject = [];

export function apply(ctx, config) {
  ctx.plugin(bili);
  ctx.plugin(compactionGate);
  ctx.plugin(accelerator, config ?? {});
}
