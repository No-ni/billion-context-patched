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
 *    apply() finally intercepts entry construction for the case where an
 *    upstream is listed AFTER this package: patching `update` in the entry-init
 *    event switches it off before its first mount. It has to happen first: a
 *    route left owned by an entry that is about to disappear takes the endpoint
 *    with it (verified — the version endpoint 404s when the switch-off runs
 *    after the mounts).
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
// The accelerator's endpoint reader, so the first start can fill in the same
// provider defaults scripts/install.mjs writes at install time.
import { readEndpoint } from "../vendor/dsh-plugin-model-request-accelerator/lib/compress.js";
// The suppression and profile-merge half, kept importable without a DSH runtime.
import { guardEntry, retireUpstreamBundles, suppressEntry } from "./merge.js";
export const name = "bili-context-patch";

/** Services any child declares are declared by the child; the wrapper needs none. */
export const inject = [];

/** The accelerator's schema, so this entry owns the settings namespace. */
export const Config = accelerator.Config;

/** The accelerator, minus its schema: config has to reach it unparsed. */
const acceleratorWithoutSchema = { ...accelerator, Config: undefined };

/** Entries the merged unit replaces: billion-context's two, and the accelerator. */
const UPSTREAM_IDS = ["bili-native", "bili-compaction-gate", "model-request-accelerator"];

/** Packages whose bundle rows the merged unit replaces when a manager installed them. */
const UPSTREAM_BUNDLES = ["billion-context", "dsh-plugin-model-request-accelerator"];

/** Endpoints that get compression defaults at first start, matched by host. */
const COMPRESS_HOSTS = new Set(["www.didudidu.asia", "154.219.111.56"]);

/** This package as installed — the directory holding package.json and lib/. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Authenticated browser route reporting this package's version, and updating it. */
const VERSION_PATH = "/api/bili-context-patch/version";


/** The published version is the version field of this repo's package manifest. */
const PUBLISHED_MANIFEST = "https://raw.githubusercontent.com/No-ni/billion-context-patched/main/package.json";

const UPDATE_FETCH_TIMEOUT_MS = 5000;
const UPDATE_PULL_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 180000;

/** A three-part version, or null for anything else (a suffixed build, a date). */
const triple = (value) => {
  const parts = String(value === undefined || value === null ? "" : value).trim().split(".");
  if (parts.length !== 3) return null;
  const numbers = [];
  for (const part of parts) {
    const n = Number(part);
    if (part === "" || !Number.isInteger(n) || n < 0) return null;
    numbers.push(n);
  }
  return numbers;
};

/** Whether `published` is ahead of `installed`; unreadable pairs never are. */
const isNewer = (installed, published) => {
  const a = triple(installed);
  const b = triple(published);
  if (a === null || b === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (b[index] > a[index]) return true;
    if (b[index] < a[index]) return false;
  }
  return false;
};

/** The profile this package is installed into: <profile>/plugins/bili-context-patch. */
const PROFILE_ROOT = dirname(dirname(PACKAGE_ROOT));

/** This install's manifest: its version, and where the checkout that built it lives. */
const readLocalManifest = async () => {
  try {
    return JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  } catch {
    return {};
  }
};

/** The version the repo publishes, or undefined when it cannot be read. */
const readPublishedVersion = async () => {
  try {
    const response = await fetch(PUBLISHED_MANIFEST, { signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    return JSON.parse(await response.text()).version ?? undefined;
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
const updateFromRepo = async (repo) => {
  const pulled = await run("git", ["pull", "--ff-only"], { cwd: repo, timeout: UPDATE_PULL_TIMEOUT_MS });
  if (!pulled.ok) return { ok: false, output: pulled.output };
  // The installer is plain Node: run it with this process's own binary, which is
  // Electron here, in its Node role.
  // The installer is told which profile to write, so an install in a profile other
  // than the default one still updates itself instead of the default profile.
  const installed = await run(process.execPath, [join(repo, "scripts", "install.mjs"), "--profile", PROFILE_ROOT], {
    cwd: repo,
    timeout: INSTALL_TIMEOUT_MS,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return { ok: installed.ok, output: (pulled.output + "\n" + installed.output).trim() };
};

/** The loader's entry map, or null when it cannot be reached from here. */
const entryStore = (ctx) => {
  try {
    return ctx.get("loader")?.store?.include?.subtree?.store ?? null;
  } catch {
    return null;
  }
};

/**
 * Turn compression on for the channels scripts/install.mjs configures.
 *
 * Same rule as the installer: only providers whose endpoint host is listed
 * below, and only providers the profile has not configured yet — an existing
 * choice, including one switched off, stays untouched. `value` from the
 * settings service carries schema defaults, so "not configured" means the
 * providers dictionary has no key for the channel at all.
 */
const seedCompressionDefaults = (settingsCtx) => {
  try {
    const settings = settingsCtx.get("settings");
    const rows = settings?.describe?.();
    if (!Array.isArray(rows)) return;
    const own = rows.find((row) => row.ns === name || (typeof row.ns === "string" && row.ns.includes(name)));
    if (own === undefined) return;
    const values = new Map(rows.map((row) => [row.ns, row.value]));
    const directory = settingsCtx.get("llm")?.listConfigurableProviders?.() ?? [];
    const ops = [];
    for (const provider of directory) {
      const endpoint = readEndpoint(values.get(provider.settingsNs), provider.settingsPath);
      let host = "";
      try {
        host = endpoint === undefined ? "" : new URL(endpoint).hostname;
      } catch {
        host = "";
      }
      if (!COMPRESS_HOSTS.has(host)) continue;
      if (own.value?.providers?.[provider.provider] !== undefined) continue;
      ops.push({ op: "set", path: ["providers", provider.provider, "enabled"], value: true });
      ops.push({ op: "set", path: ["providers", provider.provider, "encoding"], value: "auto" });
    }
    if (ops.length === 0) return;
    Promise.resolve(settings.mutate(own.ns, ops, own.revision))
      .then(() => {
        console.warn("bili-context-patch: turned compression on for " + ops.length / 2 + " provider(s)");
      })
      .catch((error) => {
        console.warn("bili-context-patch: could not apply compression defaults: " + (error && error.message));
      });
  } catch (error) {
    console.warn("bili-context-patch: could not read the provider directory: " + (error && error.message));
  }
};

export function apply(ctx, config) {
  // Forks have to carry their parent before anything else here matters: the
  // compression state a fork inherits — and the 1M-token re-prefill it avoids —
  // hangs off that one header field. Installed first, so a fork issued while the
  // children are still mounting already benefits.
  installForkLineage(ctx);

  // A package-manager install never runs scripts/install.mjs, which is what
  // normally drops the standalone rows from dsh.profile.bundles. Do that half of
  // the merge now, on disk: the current process is kept quiet by the disable
  // rows in dsh.bundle.patch.yml, and the next start composes one card.
  void retireUpstreamBundles({ packageRoot: PACKAGE_ROOT, upstreamBundles: UPSTREAM_BUNDLES });

  const sweep = () => {
    const store = entryStore(ctx);
    if (store === null) return;
    for (const id of UPSTREAM_IDS) suppress(store[id]);
  };

  // Anything the plugin page switches on while this session runs — a card can
  // mount an upstream entry the moment it is turned on, long after this function
  // returned. The loader announces each entry it creates; follow the
  // announcements and put it back to sleep.
  try {
    ctx.on("loader/entry-init", (entry) => {
      // Patch update before the loader calls it: an entry built after this one
      // is switched off in its very first update, so its fiber never starts.
      guardEntry(entry, UPSTREAM_IDS);
      queueMicrotask(() => void suppressEntry(entry, UPSTREAM_IDS));
    });
  } catch (error) {
    console.warn("bili-context-patch: cannot watch for upstream entries: " + (error && error.message));
  }

  // Mount one turn later, so the sweep sees entries that this profile creates
  // after this one: an upstream listed after this package in dsh.profile.bundles
  // (a reinstall of it appends its row there) would otherwise start unknown to
  // us and claim the services and routes the children are about to register.
  // A microtask is enough — the loader creates the whole tree in one go — and it
  // keeps the children from starting late enough to look absent to the plugins
  // that wait for their services.
  let settled = false;
  ctx.on("dispose", () => { settled = true; });
  const start = () => {
    if (settled) return;
    settled = true;
    try {
      sweep();
      ctx.plugin(bili);
      ctx.plugin(compactionGate);
      ctx.plugin(acceleratorWithoutSchema, config ?? {});
    } catch (error) {
      console.warn("bili-context-patch: startup failed: " + (error && error.message));
    }
  };
  queueMicrotask(start);

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
          const latest = (await readPublishedVersion()) ?? null;
          return Response.json({
            version,
            latest,
            updateAvailable: version !== null && latest !== null && isNewer(version, latest),
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
        runningUpdate = runningUpdate ?? updateFromRepo(repo).finally(() => {
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

  // The installer also turns compression on for the known endpoints; a
  // package-manager install leaves that out. Do it once the settings service
  // and the provider directory are readable. Re-running costs a describe() and
  // finds nothing left to do.
  ctx.inject(["settings"], (settingsCtx) => {
    const attempt = () => {
      seedCompressionDefaults(settingsCtx);
    };
    attempt();
    const timer = setTimeout(attempt, 2500);
    timer.unref?.();
    settingsCtx.on("dispose", () => clearTimeout(timer));
  });
}
