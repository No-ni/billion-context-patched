#!/usr/bin/env node
// Offline check for the "image budget" card in bili's own config page.
//
// Why this exists: the card is injected into the bundle by sentinels, not by a
// hand edit, and its controls edit the config draft before anything is saved.
// A wrong anchor still yields a page that loads, so the failure would only show
// up as a card that silently does nothing. This check starts the build on a
// private HOME, asserts the markup and the call site, parses the inline page
// script, and then runs the extracted handlers against a fake DOM: defaults,
// stored values, budget bounds, parse-error disable, save and reset.
//
// B12-B15 (retention, shrink, image convention) were removed in 0.7.5. The card
// now only carries the five DSH-native budget numbers; this check asserts the
// removed controls stay absent.
//
// Usage: node scripts/check-image-card.mjs [path/to/dist/index.js]
// Offline: no model calls, no network beyond the local server it starts.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(process.argv[2] ?? join(here, "..", "vendor", "billion-context", "dist", "index.js"));
let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log((pass ? "PASS " : "FAIL ") + name + (pass || !detail ? "" : " -> " + detail));
};
const fail = (message) => {
  console.error("image-card: FAILED - " + message);
  process.exit(1);
};

const freePort = () =>
  new Promise((done, died) => {
    const probe = createServer();
    probe.on("error", died);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const home = mkdtempSync(join(tmpdir(), "bili-image-card-"));
const port = await freePort();
const child = spawn(process.execPath, [distPath, "start", "--host", "127.0.0.1", "--port", String(port)], {
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

const stop = () => {
  try { child.kill("SIGTERM"); } catch {}
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
};
process.on("exit", stop);

async function page() {
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(base + "/__bili/");
      if (res.ok) return await res.text();
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  fail("the build never answered on " + base + "; output:\n" + output);
}

const html = await page();

// 1. the markup, the dictionaries and the call site
for (const [name, needle] of [
  ["card present", 'id="card-image"'],
  ["field host", 'id="image-fields"'],
  ["dirty note", 'class="cfg-dirty-note'],
  ["save button", 'id="save-image"'],
  ["reset button", 'id="reset-image"'],
  ["title wired to i18n", 'data-i18n="cfg.image"'],
  ["zh title", '"cfg.image":"\u56fe\u50cf\u9884\u7b97"'],
  ["zh budget label", '"cfg.image_max_request"'],
  ["zh retirement label", '"cfg.image_offload_quantum"'],
  ["en title", '"cfg.image":"Image budget"'],
]) check(name, html.includes(needle), needle);
check("hydrate call site", html.includes("hydrateImageCard(cfg);"));
check("dirty watch", html.includes('"card-file", "card-image", "summary-settings"'));
check("broken-config disable list", html.includes('"save-image", "reset-image"'));
check("retention toggle removed", !html.includes('id="image-retention"'));
check("dimension input removed", !html.includes('id="image-max-dim"'));
check("prompt toggle removed", !html.includes('id="image-prompt"'));

// 2. the inline page script must be a single parseable program
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check("inline page script found", scripts.length > 0, String(scripts.length));
scripts.forEach((source, index) => {
  try {
    new Function(source);
    check("inline script " + index + " parses", true);
  } catch (error) {
    check("inline script " + index + " parses", false, error.message);
  }
});
const script = scripts[0] ?? "";

// 3. extract the injected function and the listener block, then run them
function braceExtract(source, header) {
  const at = source.indexOf(header);
  if (at < 0) throw new Error("missing " + header);
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error("unbalanced " + header);
}
const between = (source, open, close) => {
  const from = source.indexOf(open);
  const to = source.indexOf(close);
  if (from < 0 || to < from) throw new Error("missing " + open);
  return source.slice(from, to);
};

let hydrateSource = "";
let listenerSource = "";
try {
  hydrateSource = braceExtract(script, "function hydrateImageCard(cfg) {");
} catch (error) {
  fail(error.message);
}
try {
  listenerSource = between(script, "// <bili-image-card:listeners begin>", "// <bili-image-card:listeners end>");
} catch (error) {
  fail(error.message);
}

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.style = { cssText: "" };
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.className = "";
    this.textContent = "";
    this.id = "";
    this.checked = false;
    this.value = "";
    this.disabled = false;
  }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const makeDoc = () => ({ createElement: (tag) => new Element(tag), createTextNode: (text) => ({ textContent: text }) });
const walk = (node, visit) => {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
};
const byId = (root, id) => {
  let found = null;
  walk(root, (node) => { if (!found && node.id === id) found = node; });
  return found;
};
const t = (key) => key;
const noop = () => {};

function mount(draft, options = {}) {
  const document = makeDoc();
  const box = new Element("div");
  const editor = new Element("textarea");
  editor.value = JSON.stringify(draft, null, 2);
  const ids = { "image-fields": box, "cfg-file-edit": editor };
  const $ = (id) => ids[id] || null;
  const hydrate = new Function(
    "$", "document", "t", "parseConfigDraft", "refreshDirtyFlag",
    hydrateSource + "; return hydrateImageCard;",
  )($, document, t, (raw) => JSON.parse(raw), noop);
  hydrate({ parseError: Boolean(options.parseError) });
  return { hydrate, box, editor, $, document, parsed: () => JSON.parse(editor.value) };
}

// defaults: five native budget numbers, and nothing else
{
  const card = mount({});
  check("defaults: per-image request target 150 KiB", byId(card.box, "image-request-kb").value === "150");
  check("defaults: total image cap 2048 KiB", byId(card.box, "image-total-kb").value === "2048");
  check("defaults: pixel budget 1440000", byId(card.box, "image-pixel-budget").value === "1440000");
  check("defaults: at most 20 request images", byId(card.box, "image-max-request").value === "20");
  check("defaults: retire 10 images per step", byId(card.box, "image-offload-quantum").value === "10");
  check("defaults: budget input describes its hint", byId(card.box, "image-max-request").attributes["aria-describedby"] === "image-max-request-hint");
  check("defaults: retention toggle absent", byId(card.box, "image-retention") === null);
  check("defaults: prompt toggle absent", byId(card.box, "image-prompt") === null);
  check("defaults: host offload restore is on", byId(card.box, "image-restore-host").checked === true);
}
// the host-offload restore switch defaults on and records only the off choice
{
  const card = mount({});
  const toggle = byId(card.box, "image-restore-host");
  check("restore: default writes no key", card.parsed().imageRestoreHostOffload === undefined, card.editor.value);
  toggle.checked = false;
  toggle.listeners.change();
  check("restore: off is stored", card.parsed().imageRestoreHostOffload === false);
  toggle.checked = true;
  toggle.listeners.change();
  check("restore: on drops the key", card.parsed().imageRestoreHostOffload === undefined);
  const stored = mount({ imageRestoreHostOffload: false });
  check("restore: stored off stays off", byId(stored.box, "image-restore-host").checked === false);
}
// budget relationships: request <= total, retirement step <= image cap
{
  const card = mount({});
  const request = byId(card.box, "image-request-kb");
  const total = byId(card.box, "image-total-kb");
  const max = byId(card.box, "image-max-request");
  const batch = byId(card.box, "image-offload-quantum");
  request.value = "4096";
  request.listeners.change();
  check("request above total: rejected", card.parsed().requestImageMaxBytes === undefined && request.value === "150", request.value);
  total.value = "100";
  total.listeners.change();
  check("total below request: rejected", card.parsed().maxRequestImageBytes === undefined && total.value === "2048", total.value);
  max.value = "32";
  max.listeners.change();
  check("budget max 32: saved", card.parsed().maxRequestImages === 32 && card.parsed().imageOffloadCountQuantum === 10, JSON.stringify(card.parsed()));
  check("budget max 32: retirement max follows", batch.max === "32");
  batch.value = "8";
  batch.listeners.change();
  check("budget batch 8: saved", card.parsed().maxRequestImages === 32 && card.parsed().imageOffloadCountQuantum === 8);
  max.value = "5";
  max.listeners.change();
  check("budget max below batch: rejected", card.parsed().maxRequestImages === 32 && max.value === "32");
  batch.value = "33";
  batch.listeners.change();
  check("budget batch above max: rejected", card.parsed().imageOffloadCountQuantum === 8 && batch.value === "8");
}
// values already in the file
{
  const card = mount({
    requestImageMaxBytes: 102400, maxRequestImageBytes: 4 * 1024 * 1024,
    requestImagePixelBudget: 1000000, maxRequestImages: 30, imageOffloadCountQuantum: 5,
  });
  check("stored: per-image 100 KiB", byId(card.box, "image-request-kb").value === "100");
  check("stored: total 4096 KiB", byId(card.box, "image-total-kb").value === "4096");
  check("stored: pixel budget", byId(card.box, "image-pixel-budget").value === "1000000");
  check("stored: max 30", byId(card.box, "image-max-request").value === "30");
  check("stored: batch 5", byId(card.box, "image-offload-quantum").value === "5");
}
// a non-integer or zero is refused in place
{
  const card = mount({ requestImagePixelBudget: 1000000 });
  const pixels = byId(card.box, "image-pixel-budget");
  pixels.value = "0";
  pixels.listeners.change();
  check("pixel 0: draft untouched", card.parsed().requestImagePixelBudget === 1000000);
  check("pixel 0: input restored", pixels.value === "1000000");
  let note = null;
  walk(card.box, (node) => {
    if (!note && node.style && String(node.style.cssText).includes("color:#cf222e")) note = node;
  });
  check("pixel 0: refused in place", note !== null && note.textContent === "cfg.image_budget_invalid", note && note.textContent);
  pixels.value = "1200000";
  pixels.listeners.change();
  check("pixel 1200000: written", card.parsed().requestImagePixelBudget === 1200000);
}
// a broken config file disables every control instead of guessing
check("parseError: enabled", byId(mount({}).box, "image-request-kb").disabled !== true);
check("parseError: disabled", byId(mount({}, { parseError: true }).box, "image-request-kb").disabled === true);

// save posts the raw draft; reset writes the five defaults and drops retired keys
{
  const card = mount({
    imageRetention: false, imageRetentionKeepLastUser: false, imageRetentionMaxDim: 640,
    imagePrompt: false, imageRescaleMaxDim: 900,
    maxRequestImages: 32, imageOffloadCountQuantum: 8, imageRestoreHostOffload: false, debug: 2,
  });
  const save = new Element("button");
  const reset = new Element("button");
  save.id = "save-image";
  reset.id = "reset-image";
  const ids = {
    "image-fields": card.box,
    "cfg-file-edit": card.editor,
    "save-image": save,
    "reset-image": reset,
  };
  const posted = [];
  const toasts = [];
  let renders = 0;
  new Function(
    "$", "t", "toast", "putCfg", "refreshDirtyFlag", "hydrateImageCard", "parseConfigDraft", "document",
    listenerSource + "; return 1;",
  )(
    (id) => ids[id] || null,
    t,
    (message) => toasts.push(message),
    async (button, payload) => { posted.push(payload); },
    noop,
    () => { renders++; },
    (raw) => JSON.parse(raw),
    makeDoc(),
  );
  await save.listeners.click();
  check("save: the raw draft is posted", posted.length === 1 && posted[0].file === card.editor.value, JSON.stringify(posted));
  await reset.listeners.click();
  const draft = JSON.parse(card.editor.value);
  check(
    "reset: retired image keys removed",
    ["imageRetention", "imageRetentionKeepLastUser", "imageRetentionMaxDim", "imagePrompt", "imageRescaleMaxDim", "imageRestoreHostOffload"].every((key) => !(key in draft)),
    JSON.stringify(draft),
  );
  check("reset: image budget returns to defaults", draft.maxRequestImages === 20 && draft.imageOffloadCountQuantum === 10 &&
    draft.requestImageMaxBytes === 153600 && draft.requestImagePixelBudget === 1440000 && draft.maxRequestImageBytes === 2097152, JSON.stringify(draft));
  check("reset: unknown key kept", draft.debug === 2, JSON.stringify(draft));
  check("reset: card re-rendered", renders === 1, String(renders));
  check("reset: toast shown", toasts[0] === "cfg.image_restored", JSON.stringify(toasts));
}

process.off("exit", stop);
child.kill("SIGTERM");
await new Promise((done) => {
  if (child.exitCode !== null) return done();
  child.once("exit", done);
  setTimeout(done, 5000).unref();
});
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(failures === 0 ? "image-card: RESULT OK" : "image-card: RESULT FAILED (" + failures + ")");
process.exitCode = failures === 0 ? 0 : 1;
