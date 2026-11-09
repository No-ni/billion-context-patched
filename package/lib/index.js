/**
 * Host half of the merged install unit.
 *
 * One Loader entry (this package) mounts three plugins as child fibers:
 * billion-context's native host plugin, its compaction gate, and the request
 * accelerator. All three come from the vendor/ tree beside this file, so the
 * profile depends on nothing else and shows exactly one card. The tree is
 * rebuilt by scripts/install.mjs; upgrading an upstream means running it again.
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
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The two upstream packages as copies, not as dependencies: this file is written
// into <profile>/plugins/bili-context-patch, and ./upstream.js re-exports the
// vendored trees beside it. Nothing the profile declares is a second card.
import { accelerator, bili, compactionGate } from "./upstream.js";

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
const PUBLISHED_MANIFEST =
  "https://raw.githubusercontent.com/No-ni/billion-context-patched/main/package/package.json";

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
          return Response.json(
            { error: "no patch checkout recorded; run scripts/install.mjs again" },
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
}
