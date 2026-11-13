import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

export function seedLegacyState(state) {
  const at = Date.now();
  const files = new Map([
    ["plugin-conversations.json", { "e2e-legacy-alias": { sessionId: "e2e-parent", lastSeen: at } }],
    ["prefix-affinity.json", { version: 1, entries: [{ sessionId: "e2e-legacy-affinity", depth: 1, tailHash: "legacy-tail", itemHashes: ["legacy-item"], lastSeen: at }] }],
    ["session-order.json", { version: 1, entries: [{ id: "e2e-legacy-order", kinds: ["user"], frags: ["legacy-fragment"], tagHash: "legacy-tag", model: "mock-model", lastSeen: at }] }],
  ]);
  return [...files].map(([name, value]) => { const file = join(state, "billion-context", name), bytes = JSON.stringify(value); writeFileSync(file, bytes); return { name, file, bytes }; });
}

export function database(sessions, fn, readOnly = true) {
  const db = new DatabaseSync(join(sessions, "index.db"), { readOnly });
  try { return fn(db); } finally { db.close(); }
}

export function readKv(sessions) {
  return database(sessions, db => Object.fromEntries(db.prepare("SELECT namespace, key, value_json FROM kv_store").all().map(row => [row.namespace + "/" + row.key, JSON.parse(row.value_json)])));
}

export function assertLegacyUnchanged(assert, files) {
  for (const file of files) assert.equal(readFileSync(file.file, "utf8"), file.bytes, `a hydrated unified instance must not rewrite ${file.name}`);
}
