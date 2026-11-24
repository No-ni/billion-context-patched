#!/usr/bin/env node
// Reproduce the Cordis inject-only behavior that exposed the regression.
// Optional preset coverage must not block the policy service registration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const gateFile = join(root, "../vendor/billion-context/dist/agent/dsh-compaction-gate.js");
const source = readFileSync(gateFile, "utf8");
assert.match(source, /function presetRegistryOf\(ctx\)\{try\{/,
  "agentPresets lookup must remain guarded outside inject()",
);
assert.match(source, /function installRuntimePresetCoverage\(ctx\)/,
  "runtime preset coverage helper must remain present",
);

const gate = await import(pathToFileURL(gateFile));
const previousVerdict = globalThis.__BILI_DSH_COMPACTION_VERDICT__;
globalThis.__BILI_DSH_COMPACTION_VERDICT__ = "active";
try {
  const provided = [];
  const throwingContext = {
    on() {},
    get() { throw new Error("agentPresets is unavailable"); },
    reflect: { provide(name, value) { provided.push({ name, value }); } },
  };
  Object.defineProperty(throwingContext, "agentPresets", {
    configurable: true,
    get() { throw new Error('cannot get property "agentPresets" without inject'); },
  });
  assert.doesNotThrow(() => gate.apply(throwingContext),
    "an unavailable optional preset registry must not abort gate setup",
  );
  assert.equal(provided.find(row => row.name === "biliBasicCompactionPolicy")?.value?.owner,
    "billion-context",
    "compaction policy service must be registered when preset coverage is unavailable",
  );

  const registered = [];
  const registry = { register(definition) { registered.push(definition); } };
  const injectableContext = {
    on() {},
    agentPresets: registry,
    reflect: { provide() {} },
  };
  gate.apply(injectableContext);
  registry.register({ id: "preset-ptc", plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] });
  assert.equal(registered[0].plugins[0].disabled, true,
    "available preset registry must still receive the runtime compaction override",
  );
} finally {
  if (previousVerdict === undefined) delete globalThis.__BILI_DSH_COMPACTION_VERDICT__;
  else globalThis.__BILI_DSH_COMPACTION_VERDICT__ = previousVerdict;
}

console.log("compaction gate compatibility checks passed");
