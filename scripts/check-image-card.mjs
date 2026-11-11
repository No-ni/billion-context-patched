#!/usr/bin/env node
// Offline check for the "image" card in bili's own config page.
//
// Why this exists: the card is injected into the 8.5 MB bundle by sentinels,
// not by a hand edit, and its controls edit the config draft before anything is
// saved. A wrong anchor or a broken toggle still yields a page that loads, so
// the failure would only show up as a card that silently does nothing. This
// check starts the build on a private HOME, asserts the markup and the call
// site, parses the inline page script, and then runs the extracted handlers
// against a fake DOM: defaults, stored values, toggle writes, dimension bounds,
// parse-error disable, save and reset.
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
  ["zh title", '"cfg.image":"图像"'],
  ["zh retention label", '"cfg.image_retention":"看过的图片不再重传"'],
  ["en title", '"cfg.image":"Image"'],
]) check(name, html.includes(needle), needle);
check("hydrate call site", html.includes("hydrateImageCard(cfg);"));
check("dirty watch", html.includes('"card-file", "card-image", "summary-settings"'));
check("broken-config disable list", html.includes('"save-image", "reset-image"'));

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

// defaults
{
  const card = mount({});
  check("defaults: longest side 1200", byId(card.box, "image-max-dim").value === "1200", byId(card.box, "image-max-dim").value);
  check("defaults: retention on", byId(card.box, "image-retention").checked === true);
  check("defaults: prompt on", byId(card.box, "image-prompt").checked === true);
}
// values already in the file
{
  const card = mount({ imageRetention: false, imageRetentionKeepLastUser: false, imageRetentionMaxDim: 640, imagePrompt: false });
  check("stored: retention off", byId(card.box, "image-retention").checked === false);
  check("stored: keep-last off", byId(card.box, "image-keep-last").checked === false);
  check("stored: prompt off", byId(card.box, "image-prompt").checked === false);
  check("stored: longest side 640", byId(card.box, "image-max-dim").value === "640");
}
// toggling edits the draft and keeps keys it does not own
{
  const card = mount({ imageRetention: false, debug: 1 });
  const box = byId(card.box, "image-retention");
  box.checked = true;
  box.listeners.change();
  check("toggle on: key removed", !("imageRetention" in card.parsed()), JSON.stringify(card.parsed()));
  check("toggle on: unknown key kept", card.parsed().debug === 1, JSON.stringify(card.parsed()));
  const again = byId(card.box, "image-retention");
  again.checked = false;
  again.listeners.change();
  check("toggle off: key false", card.parsed().imageRetention === false, JSON.stringify(card.parsed()));
}
// a too-small or non-integer longest side is refused in place
{
  const card = mount({ imageRetentionMaxDim: 640 });
  const dim = byId(card.box, "image-max-dim");
  dim.value = "100";
  dim.listeners.change();
  check("dim 100: draft untouched", card.parsed().imageRetentionMaxDim === 640, JSON.stringify(card.parsed()));
  check("dim 100: input restored", dim.value === "640", dim.value);
  let note = null;
  walk(card.box, (node) => {
    if (!note && node.style && String(node.style.cssText).includes("color:#cf222e")) note = node;
  });
  check("dim 100: refused in place", note !== null && note.textContent === "cfg.image_dim_invalid", note && note.textContent);
  dim.value = "900";
  dim.listeners.change();
  check("dim 900: written", card.parsed().imageRetentionMaxDim === 900, JSON.stringify(card.parsed()));
}
// a broken config file disables every control instead of guessing
check("parseError: enabled", byId(mount({}).box, "image-retention").disabled !== true);
check("parseError: disabled", byId(mount({}, { parseError: true }).box, "image-retention").disabled === true);

// save posts the raw draft; reset removes the four keys and re-renders
{
  const card = mount({ imageRetention: false, imageRetentionKeepLastUser: false, imageRetentionMaxDim: 640, imagePrompt: false, debug: 2 });
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
    "reset: four keys removed",
    ["imageRetention", "imageRetentionKeepLastUser", "imageRetentionMaxDim", "imagePrompt"].every((key) => !(key in draft)),
    JSON.stringify(draft),
  );
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
