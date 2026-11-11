/**
 * Name the parent of a forked session.
 *
 * DSH copies a fork's events into a new session without recording where they
 * came from: `sessionController.fork` calls
 * `agents.create({ ..., meta: { cwd, isSeeded: true, agentPreset } })`, and the
 * header that reaches disk carries no `parentSession`. The field is supported —
 * dsh-session validates it, session-query reads lineage from it — but nothing
 * fills it in.
 *
 * billion-context's fork adoption needs exactly that field. Its gate stops at
 * "the session header says isSeeded but carries no usable parentSession" and the
 * child re-compresses the whole inherited transcript from scratch: a 1M-token
 * prefill that runs into the 300s ceiling and dies with preflight_compress_failed.
 * With the parent named, the untouched upstream code adopts the parent's folds
 * instead of starting from zero.
 *
 * So the field is filled in here, on our side, without patching anyone:
 *
 * - `sessionController.fork` is wrapped to remember the parent across the call,
 *   in an AsyncLocalStorage store, so two forks in flight cannot swap parents.
 * - `agents.create` is wrapped to add that one field to the child's metadata
 *   while the store is set — and only for a seeded create, which is the fork's
 *   own; every other create passes through untouched.
 *
 * Both are the shared service instances: a wrapper installed here is the one
 * another plugin's `ctx.agents` resolves to, so the session controller's own
 * create call sees it (verified against a real fork). Disposing the scope puts
 * the originals back, so switching this package off also switches this off.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The service names the wrappers need; both exist before any fork can run. */
const DEPENDENCIES = ["agents", "sessionController"];
const ORIGINAL = Symbol.for("cordis.original");

/**
 * Install the fork-lineage shim.
 *
 * @param ctx - the host plugin context; the shim waits for both services.
 */
export function installForkLineage(ctx) {
  try {
    ctx.inject(DEPENDENCIES, (scope) => {
      const agentsService = scope.get("agents");
      const controllerService = scope.get("sessionController");
      // Cordis returns a fresh method proxy on every read. Patch the underlying
      // shared instances so identity checks and restoration survive those proxies.
      const agents = agentsService?.[ORIGINAL] ?? agentsService;
      const controller = controllerService?.[ORIGINAL] ?? controllerService;
      if (agents === undefined || agents === null || typeof agents.create !== "function") return;

      const forkParent = new AsyncLocalStorage();
      const originalCreate = agents.create;
      const originalFork =
        controller !== undefined && controller !== null && typeof controller.fork === "function"
          ? controller.fork
          : null;

      // A create that arrives while a fork is running, with the fork's own
      // seeded metadata, is that fork's child: name its parent.
      const create = function create(options) {
        const parent = forkParent.getStore();
        if (parent !== undefined && options !== null && typeof options === "object") {
          const meta = options.meta;
          if (
            meta !== null &&
            typeof meta === "object" &&
            meta.isSeeded === true &&
            meta.parentSession === undefined
          ) {
            options = { ...options, meta: { ...meta, parentSession: parent } };
          }
        }
        return originalCreate.call(this, options);
      };
      agents.create = create;

      let fork;
      if (originalFork !== null) {
        fork = function fork(...args) {
          const request = args[0];
          const parent = request === undefined || request === null ? undefined : request.sessionId;
          if (typeof parent !== "string" || parent === "") return originalFork.apply(this, args);
          return forkParent.run(parent, () => originalFork.apply(this, args));
        };
        controller.fork = fork;
      }

      scope.effect(() => () => {
        try {
          if (agents.create === create) agents.create = originalCreate;
        } catch (error) {
          console.warn("bili-context-patch: fork lineage could not restore agents.create: " + (error && error.message));
        }
        if (originalFork === null) return;
        try {
          if (controller.fork === fork) controller.fork = originalFork;
        } catch (error) {
          console.warn("bili-context-patch: fork lineage could not restore sessionController.fork: " + (error && error.message));
        }
      });
    });
  } catch (error) {
    console.warn("bili-context-patch: fork lineage unavailable: " + (error && error.message));
  }
}
