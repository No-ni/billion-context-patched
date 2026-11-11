#!/usr/bin/env node
// Exercise the actual shipped functions without starting the proxy or using its DB.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";

const dist = process.argv[2] ?? new URL("../vendor/billion-context/dist/index.js", import.meta.url);
const source = readFileSync(dist, "latin1");
const span = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, "missing build span: " + start);
  return source.slice(a, b);
};
const msg = (id, text = id) => ({id, role:"user", contentType:"text", text});
const block = (id, ids) => ({blockId:id, effectiveMessageIds:ids, active:true});
const a = msg("a"), b = msg("b"), c = msg("c"), x = msg("x");
let db = [a,b];
const rows = () => db.map((m, seq) => ({seq, msgId:m.id, content:JSON.stringify(m)}));
const store = {
  unifiedMessageIdRows: rows,
  unifiedTailSeqs: () => db.map((_, seq) => seq),
  unifiedMessageRows: rows,
  unifiedUncoveredRows: (_, intervals) => rows().filter(r => !intervals.some(([a,b]) => r.seq >= a && r.seq <= b)),
};
const api = runInNewContext(
  span("function __biliPrefixDigest(", "const __biliPinnedViews=") +
  "\nconst __biliPinnedViews=new Map();\n" +
  span("function parseRow(", "var SnapshotAnchorFallbackError=") +
  span("function buildAnchoredView(", "function __biliPluginLaneSnapshot(") +
  "\n({buildView,buildAnchoredView,__biliPinViewRecord,__biliStickyView,__biliForkPinView,__biliPinnedViews});",
  {require:createRequire(import.meta.url), getStore:()=>store,
   MAX_CHAIN_WALK:8192, MIN_SEAM_RUN:2, __biliPinLog:()=>{},
   identitySig:m=>`${m.role}|${m.contentType}|${m.text}`, console:{warn:()=>{}}}
);
const session = {id:"test", metadata:{}, state:{blocks:[block("old",["a","b"]),block("new",["x"])]}};
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log("  OK " + name); };
check("newest missing block survives in the client suffix", () => {
  const r = api.buildView(session,[a,b,x]);
  assert(r.ok && r.view.some(m=>m.id==="x"));
});
check("older missing block is rejected", () => {
  session.state.blocks.reverse();
  assert.equal(api.buildView(session,[a,b,x]).reason,"block-unanchored");
  session.state.blocks.reverse();
});
check("sole missing block is rejected", () => {
  const state = session.state;
  session.state = {blocks:[block("new",["x"])]};
  assert.equal(api.buildView(session,[a,b,x]).reason,"block-unanchored");
  session.state = state;
});
check("missing message before the seam cannot disappear", () => {
  db = [a,b,c];
  assert.equal(api.buildView(session,[a,b,x,c]).reason,"skipped-block-not-in-tail");
});
check("a partially supplied missing block is rejected", () => {
  session.state.blocks[1].effectiveMessageIds.push("y");
  assert.equal(api.buildView(session,[a,b,c,x]).reason,"skipped-block-not-in-tail");
  session.state.blocks[1].effectiveMessageIds.pop();
});
check("delta/WS seam requires the same coverage proof", () => {
  assert.equal(api.buildAnchoredView(session,[],"user|text|c").reason,"skipped-block-not-in-tail");
  assert(api.buildAnchoredView(session,[x],"user|text|c").ok);
});
const deps = {pluginMode:true};
const pinned = [msg("acp_summary_old"),c];
const pin = (messages=[a,b,c]) => api.__biliPinViewRecord(session,messages,pinned);
const sticky = messages => api.__biliStickyView(session,messages,deps,"test");
pin();
check("unchanged prefix appends new messages", () => {
  assert.equal(sticky([a,b,c,x]).at(-1).id,"x");
  assert.equal(session.metadata.snapshotRenderTailStart,pinned.length);
});
check("earlier prefix edits reject the pin", () => assert.equal(sticky([msg("a","edited"),b,c]),null));
check("edits beyond character 200 reject the pin", () => {
  const long = msg("c","z".repeat(400));
  pin([a,b,long]);
  assert.equal(sticky([a,b,{...long,text:long.text+"changed"}]),null);
  pin();
});
check("removed summary placeholders reject the pin", () => {
  session.state.blocks[0].active=false;
  assert.equal(sticky([a,b,c]),null);
  session.state.blocks[0].active=true;
});
check("shorter history, excessive tail and tool-first tail reject", () => {
  assert.equal(sticky([a,b]),null);
  assert.equal(sticky([a,b,c,...Array.from({length:9},(_,i)=>msg("n"+i))]),null);
  assert.equal(sticky([a,b,c,{...x,role:"tool"}]),null);
});
check("fork checks the whole prefix and records a child pin", () => {
  const child={id:"child",metadata:{parentConversationId:"test"},state:session.state};
  assert.equal(api.__biliForkPinView(child,[msg("a","edited"),b,c,x],deps),null);
  assert.equal(api.__biliForkPinView(child,[a,b,c,x],deps).at(-1).id,"x");
  assert(api.__biliPinnedViews.has("child"));
  assert.equal(api.__biliForkPinView(child,[a,b,c,x],deps),null);
});
check("pin table remains bounded", () => {
  for(let i=0;i<20;i++) api.__biliPinViewRecord({...session,id:"p"+i},[a,b,c],pinned);
  assert.equal(api.__biliPinnedViews.size,8);
});
check("cache keys follow nested fork ancestry and stay bounded", () => {
  const keys=runInNewContext(span("const __biliPckChain=", "function __biliEncodeOutbound(") +
    "\n({key:__biliForkPck,map:__biliPckChain});", {__biliPluginLaneSnapshot:()=>true});
  assert.equal(keys.key({id:"root",metadata:{}}),"root");
  assert.equal(keys.key({id:"child",metadata:{parentConversationId:"root"}}),"root");
  assert.equal(keys.key({id:"grandchild",metadata:{parentConversationId:"child"}}),"root");
  for(let i=0;i<600;i++) keys.key({id:"k"+i,metadata:{}});
  assert.equal(keys.map.size,512);
});
check("fork timestamps copy only the inherited prefix", () => {
  const parent={state:{nextRunId:7,tsStamps:{a:10,b:20,c:30}}};
  const child={state:{}};
  runInNewContext(span("child.state.nextRunId=parent.state.nextRunId;", "child.state.lastPassIds="),
    {parent,child,prefix:[{rawId:"a"},{rawId:"b"}]});
  assert.equal(child.state.nextRunId,7);
  assert.equal(child.state.tsStamps.a,10);
  assert.equal(child.state.tsStamps.c,undefined);
  child.state.tsStamps.a=99;
  assert.equal(parent.state.tsStamps.a,10);
});
check("cache-key routing defaults to enabled and preserves explicit choices", () => {
  const routing = runInNewContext(
    span("function parsePromptCacheRouting(", "function parseUpstreamProxyMode(") +
    "\n({parse:parsePromptCacheRouting,effective:effectivePromptCacheRouting});"
  );
  for (const value of [undefined, null, "", "invalid"]) {
    assert.equal(routing.parse(value), "enabled");
    assert.equal(routing.effective({routing:value}), "enabled");
  }
  assert.equal(routing.effective(undefined), "enabled");
  for (const value of ["disabled", "auto", "enabled"]) {
    assert.equal(routing.parse(value), value);
    assert.equal(routing.effective({routing:value}), value);
  }
});
check("settings show enabled by default and preserve explicit routing", () => {
  const start = source.indexOf("const pcv = ");
  assert(start >= 0, "missing settings routing selector");
  const expression = source.slice(start, source.indexOf(";", start) + 1) + "\npcv";
  for (const draft of [{}, {promptCache:{}}, {promptCache:null}]) {
    assert.equal(runInNewContext(expression, {draft}), "enabled");
  }
  for (const routing of ["disabled", "auto", "enabled"]) {
    assert.equal(runInNewContext(expression, {draft:{promptCache:{routing}}}), routing);
  }
  assert(!source.includes('"cfg.q_pck_disabled_desc":"Off (current default):'));
  assert(source.includes('"cfg.q_pck_enabled_desc":"Force on (current default):'));
  assert(!source.includes("\"cfg.q_pck_disabled_desc\":\"\\u5173\\u95ED\\uFF08"));
  assert(source.includes("\"cfg.q_pck_enabled_desc\":\"\\u5F3A\\u5236\\u5F00\\u542F\\uFF08"));
});
check("nudge growth default is 80k", () => {
  assert(source.includes("growthFloor:8e4,growthCap:8e4"));
  assert(source.includes("const NUDGE_DEFAULT = 80000, NUDGE_STEP = 5000"));
  assert(source.includes("kernel default 80000"));
  assert(source.includes("\\u9ED8\\u8BA4 80000"));
  assert(!source.includes("growthFloor:5e4,growthCap:5e4"));
  assert(!source.includes("const NUDGE_DEFAULT = 50000, NUDGE_STEP = 5000"));
  assert(!source.includes("kernel default 50000"));
});
console.log("views: " + checks + " checks passed");
