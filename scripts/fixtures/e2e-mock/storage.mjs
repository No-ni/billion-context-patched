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
  // A malformed unified row is a real, expected state (#7156: the proxy warns
  // once and keeps the JSON envelope as the recovery source, never rewriting
  // what it could not parse), so the reader reports it as undefined instead of
  // throwing inside a poll predicate.
  return database(sessions, db => {
    const out = {};
    for (const row of db.prepare("SELECT namespace, key, value_json FROM kv_store").all()) {
      try { out[row.namespace + "/" + row.key] = JSON.parse(row.value_json); }
      catch { out[row.namespace + "/" + row.key] = undefined; }
    }
    return out;
  });
}

export function assertLegacyUnchanged(assert, files) {
  for (const file of files) assert.equal(readFileSync(file.file, "utf8"), file.bytes, `a hydrated unified instance must not rewrite ${file.name}`);
}
