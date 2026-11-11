#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { installForkLineage } from "../lib/fork-lineage.js";
import { guardEntry, retireUpstreamBundles, suppressEntry } from "../lib/merge.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
let dispose;
const agents = {create(options) { return options; }};
const controller = {async fork(request) {
  await Promise.resolve();
  return agents.create({meta:{isSeeded:true}, request});
}};
const original = [agents.create, controller.fork];
installForkLineage({inject(_, callback) {
  callback({get:key=>({agents,sessionController:controller})[key], on:(_, fn)=>{dispose=fn;}});
}});
const children = await Promise.all([controller.fork({sessionId:"one"}),controller.fork({sessionId:"two"})]);
assert.deepEqual(children.map(c=>c.meta.parentSession),["one","two"]);
assert.equal(agents.create({meta:{isSeeded:true}}).meta.parentSession,undefined);
dispose();
assert.equal(agents.create,original[0]);
assert.equal(controller.fork,original[1]);
console.log("  OK concurrent forks retain distinct parents and dispose restores services");

// The two interception points that keep a standalone entry from mounting beside
// the child fibers: the first update is forced off, and an entry that already
// started is disposed after its init settles.
{
  const upstream = ["model-request-accelerator"];
  const entry = {
    options: { id: "model-request-accelerator" },
    disabled: false,
    async update(options) { this.options = options; this.disabled = options.disabled === true; },
  };
  guardEntry(entry, upstream);
  await entry.update({ id: "model-request-accelerator", name: "accelerator" }, true, true);
  assert.equal(entry.options.disabled, true);
  assert.equal(entry.disabled, true);

  const wrapper = { options: { id: "bili-context-patch" }, disabled: false, async update(options) { this.options = options; } };
  guardEntry(wrapper, upstream);
  await wrapper.update({ id: "bili-context-patch" }, true, true);
  assert.notEqual(wrapper.options.disabled, true);

  let disposed = 0;
  const started = {
    options: { id: "bili-native" },
    disabled: false,
    _initTask: Promise.resolve(),
    fiber: { async dispose() { disposed += 1; } },
    async update(options) { this.options = options; this.disabled = options.disabled === true; },
  };
  await suppressEntry(started, ["bili-native"]);
  assert.equal(disposed, 1);
  console.log("  OK replaced entries are switched off before mount, or disposed after it");
}

// The first start of a package-manager install drops the standalone rows from
// the profile manifest; nothing else in the file may change.
{
  const root = mkdtempSync(join(tmpdir(), "bili-check-merge-"));
  try {
    const install = join(root, "node_modules", "bili-context-patch");
    mkdirSync(install, { recursive: true });
    const manifest = {
      dependencies: { "billion-context": "0.1.213", "bili-context-patch": "0.6.5" },
      dsh: { profile: { bundles: ["billion-context", "keep-me", "bili-context-patch"] } },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    const options = {
      packageRoot: install,
      upstreamBundles: ["billion-context", "dsh-plugin-model-request-accelerator"],
      warn: () => {},
    };
    assert.equal(await retireUpstreamBundles(options), 1);
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(after.dsh.profile.bundles, ["keep-me", "bili-context-patch"]);
    assert.deepEqual(after.dependencies, manifest.dependencies);
    assert.equal(await retireUpstreamBundles(options), 0);
    console.log("  OK first start drops the standalone bundle rows and leaves the rest alone");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const hostSource=readFileSync(join(repo,"lib/index.js"),"utf8");
const queued=[];
const handlers=new Map();
let mounts=0;
const apply=runInNewContext(hostSource.slice(hostSource.indexOf("export function apply(")).replace("export function", "function")+"\napply;",
  {installForkLineage:()=>{},queueMicrotask:fn=>queued.push(fn),
   retireUpstreamBundles:async()=>0,PACKAGE_ROOT:repo,
   UPSTREAM_BUNDLES:["billion-context","dsh-plugin-model-request-accelerator"]});
apply({on:(event,fn)=>handlers.set(event,fn),inject:()=>{},plugin:()=>{mounts++;}},{});
handlers.get("dispose")();
for(const fn of queued) fn();
assert.equal(mounts,0);
console.log("  OK disposing before deferred startup prevents ghost plugin mounts");

const fixture = mkdtempSync(join(tmpdir(),"bili-check-install-"));
try {
  const manifest={dependencies:{"user-plugin":"1.0.0"},dsh:{profile:{bundles:["user-plugin","bili-context-patch"]}}};
  mkdirSync(join(fixture,"node_modules"));
  writeFileSync(join(fixture,"package.json"),JSON.stringify(manifest));
  writeFileSync(join(fixture,"cordis.yml"),"[]\n");
  const config="- id: bili-context-patch\n  disabled: true\n  config:\n    providers:\n      relay:\n        enabled: false\n        encoding: gzip\n";
  writeFileSync(join(fixture,"cordis.patch.yml"),config);
  const install=(extra=[])=>execFileSync(process.execPath,[join(repo,"scripts/install.mjs"),"--profile",fixture,
    "--accelerator",join(repo,"vendor/dsh-plugin-model-request-accelerator"),...extra],
    {timeout:30000,stdio:"pipe",env:process.env});
  install();
  assert.equal(readFileSync(join(fixture,"cordis.patch.yml"),"utf8"),config);
  assert.equal(JSON.parse(readFileSync(join(fixture,"package.json"))).dependencies["user-plugin"],"1.0.0");
  const dist=join(fixture,"plugins/bili-context-patch/vendor/billion-context/dist/index.js");
  const installed=readFileSync(dist);
  install();
  assert(installed.equals(readFileSync(dist)));
  assert.equal(readFileSync(join(fixture,"cordis.patch.yml"),"utf8"),config);
  console.log("  OK install/reinstall preserve disabled state, provider choices and unrelated plugins");
  const broken=join(fixture,"broken-source");
  mkdirSync(join(broken,"dist"),{recursive:true});
  writeFileSync(join(broken,"package.json"),'{"name":"billion-context","version":"0.0.0"}');
  writeFileSync(join(broken,"dsh.bundle.patch.yml"),"[]\n");
  writeFileSync(join(broken,"dist/index.js"),"var __biliEncZlib=0;");
  assert.throws(()=>install(["--bili",broken]));
  assert(installed.equals(readFileSync(dist)));
  console.log("  OK incompatible source fails before replacing the installed build");
} finally { rmSync(fixture,{recursive:true,force:true}); }
console.log("wrapper checks passed");
