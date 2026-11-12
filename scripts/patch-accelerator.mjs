#!/usr/bin/env node
// Local lifecycle compatibility patch over the selected accelerator baseline.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const block = readFileSync(new URL("../patches/accelerator-ledger.block.js", import.meta.url), "utf8").replaceAll("\r\n", "\n").trimEnd();
export const legacyLedgerBlock = readFileSync(new URL("../patches/accelerator-ledger.legacy.js", import.meta.url), "utf8").replaceAll("\r\n", "\n").trimEnd();
const once = (source, before, after, label) => {
  if (source.includes(after)) {
    if (source.split(after).length !== 2 || source.replace(after, "").includes(before)) throw new Error("ambiguous patched accelerator " + label);
    return source;
  }
  if (source.split(before).length !== 2) throw new Error("incompatible accelerator " + label);
  return source.replace(before, after);
};

/** Produce checked source candidates; do not change the selected input package. */
export function patchAcceleratorSources(indexSource, ledgerSource) {
  const indexCRLF = indexSource.includes("\r\n");
  const ledgerCRLF = ledgerSource.includes("\r\n");
  let index = indexSource.replaceAll("\r\n", "\n");
  let ledger = ledgerSource.replaceAll("\r\n", "\n");
  const start = "\t// bili-context-patch: scoped-ledger-start";
  const end = "\t// bili-context-patch: scoped-ledger-end";
  if (index.includes(start)) {
    if (index.split(start).length !== 2 || index.split(end).length !== 2) throw new Error("ambiguous accelerator ledger block");
    const from = index.indexOf(start);
    const to = index.indexOf(end) + end.length;
    if (to < from) throw new Error("invalid accelerator ledger markers");
    index = index.slice(0, from) + block + index.slice(to);
  } else {
    const legacyStart = '\tctx.inject(["storage"], (storageCtx) => {';
    const legacyEnd = '\n\tctx.on("llm/adapters-updated",';
    if (index.split(legacyStart).length !== 2 || index.split(legacyEnd).length !== 2) throw new Error("incompatible accelerator ledger lifecycle");
    const from = index.indexOf(legacyStart);
    const to = index.indexOf(legacyEnd, from);
    const legacy = index.slice(from, to);
    if (legacy.trimEnd() !== legacyLedgerBlock) throw new Error("incompatible accelerator ledger cleanup");
    index = index.slice(0, from) + block + "\n" + index.slice(to);
  }
  index = once(index,
    '\t\t\tPromise.resolve(ledger.write(sessionId, timing.snapshot(sessionId))).catch((error) => {',
    '\t\t\tconst target = ledger;\n\t\t\tif (target === undefined) return;\n\t\t\tPromise.resolve().then(() => target.write(sessionId, timing.snapshot(sessionId))).catch((error) => {',
    "debounced ledger write");
  ledger = once(ledger,
    'import { z } from "zod";',
    'import { z } from "../../zod/index.js";',
    "self-contained ledger schema dependency");
  ledger = once(ledger,
    '\t\tsessions = domain.table("sessions");\n\t} catch (error) {',
    '\t\tsessions = domain.table("sessions");\n\t} catch (error) {\n\t\t// A table-resolution failure still leaves an owned domain to release.\n\t\tif (domain !== undefined) await domain.close().catch(() => {});',
    "partially opened ledger");
  return {
    index: indexCRLF ? index.replaceAll("\n", "\r\n") : index,
    ledger: ledgerCRLF ? ledger.replaceAll("\n", "\r\n") : ledger,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../vendor/dsh-plugin-model-request-accelerator", import.meta.url)));
  const paths = [join(root, "lib/index.js"), join(root, "lib/ledger.js")];
  const original = paths.map((path) => readFileSync(path, "utf8"));
  const candidate = patchAcceleratorSources(...original);
  for (const [index, text] of [candidate.index, candidate.ledger].entries()) if (text !== original[index]) writeFileSync(paths[index], text);
  console.log("accelerator ledger lifecycle patched (idempotent)");
}
