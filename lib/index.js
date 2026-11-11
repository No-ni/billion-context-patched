/**
 * Host half of the merged install unit.
 *
 * One Loader entry (this package) mounts three plugins as child fibers:
 * billion-context's native host plugin, its compaction gate, and the request
 * accelerator. All three come from the vendor/ tree beside this file, so the
 * profile depends on nothing else and shows exactly one card. The tree is
 * rebuilt by scripts/install.mjs; upgrading an upstream means running it again.
 *
 * Two things keep the standalone copies of those packages quiet, and both are
 * decided by this package rather than by hand edits to the user's files:
 *
 * 1. On a vendored install the two upstream packages are not installed at all:
 *    scripts/install.mjs drops their rows from the profile's dependencies and
 *    from dsh.profile.bundles, and their files live in vendor/ beside this file.
 *
 * 2. That holds for the ordinary install, not for every install. A package
 *    manager install (Settings > Plugins) resolves this package from the
 *    repository and never runs scripts/install.mjs, so the standalone packages
 *    stay in dsh.profile.bundles and would run beside this one and fight it for
 *    the same services and HTTP routes. The bundle layer therefore carries a
 *    `disabled:` row for each replaced entry, which the loader applies while it
 *    composes the tree — before anything mounts. The first start also drops
 *    those rows from dsh.profile.bundles, so the next start composes one card.
 *    Boot constructs entries concurrently. An already-importing original must
 *    finish and dispose BEFORE the wrapper mounts its children; newly created
 *    entries are guarded synchronously for the lifetime of this wrapper.
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
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The two upstream packages as copies, not as dependencies: this file is written
// into <profile>/plugins/bili-context-patch, and ./upstream.js re-exports the
// vendored trees beside it. Nothing the profile declares is a second card.
import { accelerator, bili, compactionGate } from "./upstream.js";
// The one thing billion-context cannot do for itself: name a forked session's
// parent, which is what its fork adoption keys on.
import { installForkLineage } from "./fork-lineage.js";
import { mountMergedPlugins } from "./startup.js";
import { installProfileMerge } from "./profile.js";
import { installCompressionDefaults } from "./defaults.js";
import { profileRootOf } from "./merge.js";
import { hasPublishedUpdate } from "./version.js";
export const name = "bili-context-patch";

/** Services any child declares are declared by the child; the wrapper needs none. */
export const inject = [];

/** The accelerator's schema, so this entry owns the settings namespace. */
export const Config = accelerator.Config;

/** The accelerator, minus its schema: config has to reach it unparsed. */
const acceleratorWithoutSchema = { ...accelerator, Config: undefined };

/** Entries the merged unit replaces: billion-context's two, and the accelerator. */
const UPSTREAM_IDS = ["bili-native", "bili-compaction-gate", "model-request-accelerator"];

/** This package as installed — the directory holding package.json and lib/. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Authenticated browser route reporting this package's version, and updating it. */
const VERSION_PATH = "/api/bili-context-patch/version";


/** The published version is the version field of this repo's package manifest. */
const PUBLISHED_MANIFEST = "https://raw.githubusercontent.com/No-ni/billion-context-patched/main/package.json";

const UPDATE_FETCH_TIMEOUT_MS = 5000;
const UPDATE_PULL_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 180000;

/** This install's manifest: its version, and where the checkout that built it lives. */
const readLocalManifest = async () => {
  try {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
    return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : {};
  } catch {
    return {};
  }
};

/** The version the repo publishes, or undefined when it cannot be read. */
const readPublishedManifest = async () => {
  try {
    const response = await fetch(PUBLISHED_MANIFEST, { signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const manifest = JSON.parse(await response.text());
    return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
};

/** Run a command, capturing both streams; never rejects. */
const run = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: (stdout ?? "") + (stderr ?? "") });
    });
  });

/** One update at a time: a second request joins the first instead of racing it. */
let runningUpdate = null;


/** Pull the checkout that built this install and regenerate the wrapper package. */
const updateFromRepo = async (repo, profileRoot) => {
  if (!profileRoot) return { ok: false, output: "could not locate this install's profile" };
  const pulled = await run("git", ["pull", "--ff-only"], { cwd: repo, timeout: UPDATE_PULL_TIMEOUT_MS });
  if (!pulled.ok) return { ok: false, output: pulled.output };
  // The installer is plain Node: run it with this process's own binary, which is
  // Electron here, in its Node role.
  // The installer is told which profile to write, so an install in a profile other
  // than the default one still updates itself instead of the default profile.
  const installed = await run(process.execPath, [join(repo, "scripts", "install.mjs"), "--profile", profileRoot], {
    cwd: repo,
    timeout: INSTALL_TIMEOUT_MS,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return { ok: installed.ok, output: (pulled.output + "\n" + installed.output).trim() };
};

export function apply(ctx, config) {
  // Forks have to carry their parent before anything else here matters: the
  // compression state a fork inherits — and the 1M-token re-prefill it avoids —
  // hangs off that one header field. Installed first, so a fork issued while the
  // children are still mounting already benefits.
  installForkLineage(ctx);

  const startup = mountMergedPlugins(ctx, [
    [bili], [compactionGate], [acceleratorWithoutSchema, config ?? {}],
  ], UPSTREAM_IDS);
  const profileReady = installProfileMerge(ctx, PACKAGE_ROOT, startup);
  installCompressionDefaults(ctx, {
    namespace: ctx.fiber?.entry?.options.id ?? name,
    ready: profileReady,
  });

  // The "version / check for updates" row in the settings page asks this route.
  // It reports THIS package and, on action=update, pulls the checkout that built
  // the install and runs its installer — the two steps the README asks for by
  // hand. Without it that row keeps reporting and pulling the accelerator.
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.fetch.register({
      path: VERSION_PATH,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        const action = new URL(request.url).searchParams.get("action") ?? "status";
        const manifest = await readLocalManifest();
        if (request.method === "GET") {
          const version = manifest.version ?? null;
          const published = await readPublishedManifest();
          const latest = published?.version ?? null;
          return Response.json({
            version,
            latest,
            updateAvailable: published !== undefined && hasPublishedUpdate(manifest, published),
          });
        }
        if (action !== "update") return Response.json({ error: "unknown action" }, { status: 400 });
        const repo = manifest.patchRepo;
        if (typeof repo !== "string" || repo === "") {
          // Installed by a package manager from the repository: there is no
          // checkout to pull, and the package manager owns the version.
          return Response.json(
            {
              ok: false,
              error:
                "this copy was installed from the repository by a package manager - " +
                "update it from Settings > Plugins instead",
            },
            { status: 409 },
          );
        }
        const from = manifest.version ?? null;
        const profileRoot = ctx.get("profileContext")?.dir ?? await profileRootOf(PACKAGE_ROOT);
        runningUpdate = runningUpdate ?? updateFromRepo(repo, profileRoot).finally(() => {
          runningUpdate = null;
        });
        const result = await runningUpdate;
        const to = (await readLocalManifest()).version ?? null;
        ctx.logger?.info?.(
          "bili-context-patch: update " +
            (result.ok ? "applied" : "failed") +
            " " +
            (from ?? "?") +
            " -> " +
            (to ?? "?"),
        );
        return Response.json({ ok: result.ok, from, to, output: result.output });
      },
    });
  });
}
