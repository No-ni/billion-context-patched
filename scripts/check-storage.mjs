#!/usr/bin/env node
// Execute the shipped storage selection and WAL probe on isolated files.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { uniqueBlockSpan } from "./patch-bili-client.mjs";

const source = fs.readFileSync(process.argv[2] ?? new URL("../vendor/billion-context/dist/index.js", import.meta.url), "latin1");
const fn = name => uniqueBlockSpan(source, name, "function " + name + "(", { expression: true }).block;
const names = ["resolveStorageMode", "resolveJsonWriterChoice", "unifiedSelectionIsSqlite", "effectiveJsonWriterOff"];
const config = runInNewContext(names.map(fn).join("\n") + "\n({resolveStorageMode,effectiveJsonWriterOff});");
let cases = 0;
for (const [env, file, writer, mode, off] of [
  [{}, undefined, undefined, "full", true],
  [{}, "sqlite", undefined, "full", true],
  [{}, "full", undefined, "full", false],
  [{}, "shadow", undefined, "shadow", false],
  [{}, "legacy", undefined, "legacy", false],
  [{}, undefined, "on", "full", false],
  [{}, "full", "off", "full", true],
  [{ BILI_STORAGE_UNIFIED: "full" }, "sqlite", undefined, "full", false],
  [{ BILI_STORAGE_UNIFIED: "sqlite" }, "full", undefined, "full", true],
  [{ BILI_STORAGE_UNIFIED: "legacy" }, "sqlite", undefined, "legacy", false],
  [{ BILI_STORAGE_JSON_WRITER: "on" }, "sqlite", "off", "full", false],
  [{ BILI_STORAGE_JSON_WRITER: "off" }, "full", "on", "full", true],
]) {
  assert.equal(config.resolveStorageMode(env, file), mode);
  assert.equal(config.effectiveJsonWriterOff(env, writer, file), off);
  cases++;
}
const root = fs.mkdtempSync(join(tmpdir(), "bili-storage-check-"));
const require = createRequire(import.meta.url);
let db;
try {
  const wal = join(root, "wal.db"), rollback = join(root, "rollback.db");
  db = new DatabaseSync(wal);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value); INSERT INTO sample VALUES (1); BEGIN IMMEDIATE;");
  const walHead = fs.readFileSync(wal).subarray(0, 100);
  assert.deepEqual([...walHead.subarray(18, 20)], [2, 2]);
  const probe = (file, expected, failRead = false) => {
    const opened = new Set(); let reads = 0, closes = 0;
    const bounded = { ...fs,
      readFileSync() { assert.fail("WAL inspection must not read the whole file"); },
      openSync(...args) { const fd = fs.openSync(...args); opened.add(fd); return fd; },
      readSync(fd, bytes, offset, length, position) {
        reads++; assert(opened.has(fd)); assert.equal(bytes.length, 100);
        assert.equal(offset, 0); assert.equal(length, 100); assert.equal(position, 0);
        if (failRead) throw new Error("synthetic read failure");
        return fs.readSync(fd, bytes, offset, length, position);
      },
      closeSync(fd) { assert(opened.delete(fd)); closes++; fs.closeSync(fd); },
    };
    const actual = runInNewContext(fn("dbFileIsAlreadyWal") + "\ndbFileIsAlreadyWal(file);", {
      file, Buffer, require: name => name === "node:fs" ? bounded : require(name),
    });
    assert.equal(actual, expected, file);
    assert.equal(opened.size, 0, "file handles must close after success or failure");
    assert.equal(reads, closes); assert(reads <= 1); cases++;
  };
  probe(wal, true); // An active writer must not require a database lock.
  db.exec("ROLLBACK"); db.close(); db = undefined;
  db = new DatabaseSync(rollback); db.exec("CREATE TABLE sample(value)"); db.close(); db = undefined;
  probe(rollback, false);
  const sparse = join(root, "large.db");
  fs.writeFileSync(sparse, walHead); fs.truncateSync(sparse, 64 * 1024 * 1024);
  probe(sparse, true);
  const short = join(root, "short.db"); fs.writeFileSync(short, walHead.subarray(0, 99));
  probe(short, false); probe(wal, false, true); probe(join(root, "absent.db"), false);
  console.log(`storage: ${cases} cases passed (real WAL/rollback, bounded reads, error cleanup and config precedence)`);
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
