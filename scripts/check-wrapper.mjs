#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { installForkLineage } from "../lib/fork-lineage.js";

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

const hostSource=readFileSync(join(repo,"lib/index.js"),"utf8");
const queued=[];
const handlers=new Map();
let mounts=0;
const apply=runInNewContext(hostSource.slice(hostSource.indexOf("export function apply(")).replace("export function", "function")+"\napply;",
  {installForkLineage:()=>{},queueMicrotask:fn=>queued.push(fn)});
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
