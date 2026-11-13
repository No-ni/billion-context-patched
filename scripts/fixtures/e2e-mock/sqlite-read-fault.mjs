// Test-only transient fault, armed by a file in the isolated E2E home. Keep the
// real database, load/save paths and proxy renderer; miss ONE identity-row read
// from loadTranscriptBase without deleting content or mutating kernel state.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const marker = process.env.BILI_E2E_SQLITE_FAULT_FILE;
if (marker) {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest);
    if (typeof sql !== "string" || !/SELECT\s+seq\s*,\s*msg_id\s*,\s*ts\s+FROM\s+messages\s+WHERE\s+session_id\s*=\s*\?\s+AND\s+retired_at\s+IS\s+NULL\s+ORDER\s+BY\s+seq/i.test(sql)) return statement;
    const all = statement.all;
    statement.all = function (...params) {
      if (existsSync(marker)) {
        const fault = JSON.parse(readFileSync(marker, "utf8"));
        const stack = new Error().stack ?? "";
        if (fault.remaining > 0 && params[0] === fault.sessionId && stack.includes("loadTranscriptBase") && !stack.includes("__biliForkTranscriptSource")) {
          fault.remaining--; fault.fired = (fault.fired ?? 0) + 1; writeFileSync(marker, JSON.stringify(fault)); return [];
        }
      }
      return all.apply(this, params);
    };
    return statement;
  };
}
